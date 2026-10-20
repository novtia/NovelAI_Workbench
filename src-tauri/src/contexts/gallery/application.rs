use super::domain::{Album, ArtistBasket, Artwork, GalleryView, ARTIST_BASKET_ID, GALLERY_VIEW_ID};
use super::projectors::{album_row, artwork_row};
use super::rules::{
    is_single_artist_album, is_test_set_album, is_test_set_id, unique_artist_keys, SINGLE_ARTIST_ALBUM_ID,
    SINGLE_ARTIST_ALBUM_NAME, SINGLE_ARTIST_IMPORT_ERROR, TEST_SET_ID_PREFIX,
};
use crate::kernel::blobs::{png_size, sniff_mime};
use crate::kernel::clock::{new_id, now_ms};
use crate::kernel::hashes::sha256_bytes;
use crate::kernel::bus::Kernel;
use crate::kernel::{Aggregate, DomainError, Res};
use crate::util::{get, has_value, py_str, take_chars, to_int, truthy};
use rusqlite::params;
use serde_json::{json, Map, Value};
use std::sync::Arc;

pub fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub struct GalleryService {
    pub k: Arc<Kernel>,
}

pub struct ImportOptions<'a> {
    pub thumb: Option<&'a [u8]>,
    pub command_id: Option<&'a str>,
    pub item_id: Option<&'a str>,
}

impl GalleryService {
    pub fn new(k: Arc<Kernel>) -> Self {
        GalleryService { k }
    }

    pub fn list_albums(&self, include_deleted: bool) -> Res<Vec<Value>> {
        let mut sql = String::from(
            "SELECT a.*, (SELECT COUNT(*) FROM projections_artworks i WHERE i.album_id = a.id AND i.deleted = 0) AS count
             FROM projections_albums a",
        );
        if !include_deleted {
            sql.push_str(" WHERE a.deleted = 0");
        }
        sql.push_str(" ORDER BY a.sort_order ASC, a.created_at ASC");
        let conn = self.k.store.connect()?;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| album_row(r, Some(r.get::<_, i64>("count")?)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_album(&self, album_id: &str) -> Res<Option<Value>> {
        let conn = self.k.store.connect()?;
        let mut stmt = conn.prepare("SELECT * FROM projections_albums WHERE id=?1")?;
        let mut rows = stmt.query_map(params![album_id], |r| album_row(r, None))?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    pub fn active_album_count(&self) -> Res<i64> {
        let conn = self.k.store.connect()?;
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM projections_albums WHERE deleted=0 AND id NOT LIKE ?1",
            params![format!("{TEST_SET_ID_PREFIX}%")],
            |r| r.get(0),
        )?)
    }

    pub fn find_single_artist_album(&self, include_deleted: bool) -> Res<Option<Value>> {
        let mut live: Option<Value> = None;
        let mut dead: Option<Value> = None;
        for album in self.list_albums(include_deleted)? {
            if !is_single_artist_album(Some(&album)) {
                continue;
            }
            if album["deleted"].as_bool().unwrap_or(false) {
                if dead.is_none() {
                    dead = Some(album);
                }
            } else {
                live = Some(album);
                break;
            }
        }
        Ok(live.or(dead))
    }

    /// 图库全局视图选择；已删除的收藏夹或测试集会被忽略。
    pub fn view(&self) -> Res<Value> {
        let conn = self.k.store.connect()?;
        let row: Option<(String, String, String, i64)> = conn
            .query_row(
                "SELECT album_id, test_set_id, preset_id, version FROM projections_gallery_view WHERE id=?1",
                params![GALLERY_VIEW_ID],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();
        let (mut album_id, mut test_set_id, preset_id, version) = row.unwrap_or_default();
        if !album_id.is_empty() {
            let album = self.get_album(&album_id)?;
            let bad = match &album {
                None => true,
                Some(a) => a["deleted"].as_bool().unwrap_or(false) || is_test_set_album(Some(a)),
            };
            if bad {
                album_id.clear();
            }
        } else {
            album_id.clear();
        }
        if !test_set_id.is_empty() {
            let ts = self.get_album(&test_set_id)?;
            let bad = match &ts {
                None => true,
                Some(a) => a["deleted"].as_bool().unwrap_or(false) || !is_test_set_album(Some(a)),
            };
            if bad {
                test_set_id.clear();
            }
        }
        Ok(json!({"albumId": album_id, "testSetId": test_set_id, "presetId": preset_id, "version": version}))
    }

    pub fn select_view(&self, data: &Value) -> Res<Value> {
        let current = self.view()?;
        let pick = |key: &str| -> String {
            if has_value(data, key) {
                py_str(get(data, key))
            } else {
                current[key].as_str().unwrap_or("").to_string()
            }
        };
        let album_id = pick("albumId");
        let test_set_id = pick("testSetId");
        let preset_id = pick("presetId");
        let mut agg: GalleryView = self.k.load(GALLERY_VIEW_ID)?;
        agg.select(&album_id, &test_set_id, &take_chars(&preset_id, 64));
        self.k.commit(&mut agg, None)?;
        self.view()
    }

    pub fn basket(&self) -> Res<Vec<Value>> {
        let conn = self.k.store.connect()?;
        let mut stmt =
            conn.prepare("SELECT key, name, added_at FROM projections_artist_basket ORDER BY sort_order ASC")?;
        let rows = stmt.query_map([], |r| {
            Ok(json!({"key": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "addedAt": r.get::<_, i64>(2)?}))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn basket_add(&self, names: &Value) -> Res<Vec<Value>> {
        let Some(list) = names.as_array() else {
            return Err(DomainError::bad("names 必须是数组"));
        };
        let mut agg: ArtistBasket = self.k.load(ARTIST_BASKET_ID)?;
        agg.add(list, now_ms());
        self.k.commit(&mut agg, None)?;
        self.basket()
    }

    pub fn basket_remove(&self, key: &str) -> Res<Vec<Value>> {
        let mut agg: ArtistBasket = self.k.load(ARTIST_BASKET_ID)?;
        agg.remove(key);
        self.k.commit(&mut agg, None)?;
        self.basket()
    }

    pub fn basket_clear(&self) -> Res<Vec<Value>> {
        let mut agg: ArtistBasket = self.k.load(ARTIST_BASKET_ID)?;
        agg.clear();
        self.k.commit(&mut agg, None)?;
        self.basket()
    }

    pub fn create_test_set(&self, name: &str) -> Res<Value> {
        let name = name.trim();
        if name.is_empty() {
            return Err(DomainError::bad("测试集名称不能为空"));
        }
        if name == SINGLE_ARTIST_ALBUM_NAME {
            return Err(DomainError::bad("「单画师」为系统收藏夹名称"));
        }
        self.assert_test_set_name_free(name, None)?;
        self.create_album(name, Some(&format!("{TEST_SET_ID_PREFIX}{}", new_id())), false, true)
    }

    fn assert_test_set_name_free(&self, name: &str, except_id: Option<&str>) -> Res<()> {
        for album in self.list_albums(false)? {
            if Some(album["id"].as_str().unwrap_or("")) == except_id || !is_test_set_album(Some(&album)) {
                continue;
            }
            if album["name"].as_str() == Some(name) {
                return Err(DomainError::conflict("已有同名测试集"));
            }
        }
        Ok(())
    }

    pub fn create_album(&self, name: &str, album_id: Option<&str>, system: bool, test_set: bool) -> Res<Value> {
        let name = name.trim();
        let album_id = match album_id {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => new_id(),
        };
        if !valid_id(&album_id) {
            return Err(DomainError::bad("无效的收藏夹 id"));
        }
        if is_test_set_id(&album_id) && !test_set {
            return Err(DomainError::bad("无效的收藏夹 id"));
        }
        let reserved = name == SINGLE_ARTIST_ALBUM_NAME || album_id == SINGLE_ARTIST_ALBUM_ID;
        if reserved && !system {
            return Err(DomainError::bad("「单画师」为系统收藏夹"));
        }
        if reserved && self.find_single_artist_album(false)?.is_some() {
            return Err(DomainError::conflict("「单画师」收藏夹已存在"));
        }
        let created = now_ms();
        let mut album: Album = self.k.load(&album_id)?;
        album.register(name, created, created, None)?;
        self.k.commit(&mut album, Some(&format!("album.register:{album_id}:{created}")))?;
        let mut found = self.get_album(&album_id)?.ok_or_else(|| DomainError::internal("创建失败"))?;
        found["count"] = json!(0);
        Ok(found)
    }

    pub fn rename_album(&self, album_id: &str, name: &str) -> Res<Value> {
        let current = self.get_album(album_id)?;
        let live = match &current {
            Some(c) if !c["deleted"].as_bool().unwrap_or(false) => c,
            _ => return Err(DomainError::not_found("收藏夹不存在")),
        };
        if is_single_artist_album(Some(live)) {
            return Err(DomainError::bad("系统收藏夹不可重命名"));
        }
        let name = name.trim();
        if name == SINGLE_ARTIST_ALBUM_NAME {
            return Err(DomainError::bad("「单画师」为系统收藏夹名称"));
        }
        if is_test_set_album(Some(live)) {
            self.assert_test_set_name_free(name, Some(album_id))?;
        }
        let mut album: Album = self.k.load(album_id)?;
        album.rename(name)?;
        self.k.commit(&mut album, None)?;
        self.get_album(album_id)?.ok_or_else(|| DomainError::not_found("收藏夹不存在"))
    }

    pub fn delete_album(&self, album_id: &str) -> Res<()> {
        let current = self.get_album(album_id)?;
        if is_single_artist_album(current.as_ref()) {
            return Err(DomainError::bad("系统收藏夹不可删除"));
        }
        if !is_test_set_album(current.as_ref()) && self.active_album_count()? <= 1 {
            return Err(DomainError::bad("至少保留一个收藏夹"));
        }
        let mut album: Album = self.k.load(album_id)?;
        album.delete()?;
        self.k.commit(&mut album, None)?;
        for item_id in self.item_ids(album_id, false)? {
            let mut art: Artwork = self.k.load(&item_id)?;
            art.delete()?;
            self.k.commit(&mut art, None)?;
        }
        Ok(())
    }

    pub fn restore_album(&self, album_id: &str) -> Res<Value> {
        let mut album: Album = self.k.load(album_id)?;
        album.restore()?;
        self.k.commit(&mut album, None)?;
        self.get_album(album_id)?.ok_or_else(|| DomainError::not_found("收藏夹不存在"))
    }

    pub fn list_items(
        &self,
        album_id: &str,
        include_deleted: bool,
        limit: Option<i64>,
        offset: i64,
        sort: &str,
    ) -> Res<Vec<Value>> {
        let album = self.get_album(album_id)?;
        match &album {
            Some(a) if include_deleted || !a["deleted"].as_bool().unwrap_or(false) => {}
            _ => return Err(DomainError::not_found("收藏夹不存在")),
        }
        let mut sql = String::from("SELECT * FROM projections_artworks WHERE album_id=?1");
        if !include_deleted {
            sql.push_str(" AND deleted=0");
        }
        sql.push_str(if sort == "added_asc" {
            " ORDER BY added_at ASC, id ASC"
        } else {
            " ORDER BY added_at DESC, id DESC"
        });
        let conn = self.k.store.connect()?;
        let mut out = Vec::new();
        if let Some(limit) = limit {
            sql.push_str(" LIMIT ?2 OFFSET ?3");
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![album_id, limit.max(0), offset.max(0)], artwork_row)?;
            for r in rows {
                out.push(r?);
            }
        } else {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![album_id], artwork_row)?;
            for r in rows {
                out.push(r?);
            }
        }
        Ok(out)
    }

    pub fn get_item(&self, item_id: &str, include_deleted: bool) -> Res<Option<Value>> {
        let conn = self.k.store.connect()?;
        let mut stmt = conn.prepare("SELECT * FROM projections_artworks WHERE id=?1")?;
        let mut rows = stmt.query_map(params![item_id], artwork_row)?;
        match rows.next() {
            Some(r) => {
                let item = r?;
                if item["deleted"].as_bool().unwrap_or(false) && !include_deleted {
                    return Ok(None);
                }
                Ok(Some(item))
            }
            None => Ok(None),
        }
    }

    pub fn has_hash(&self, album_id: &str, digest: &str) -> Res<bool> {
        let conn = self.k.store.connect()?;
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM projections_artworks WHERE album_id=?1 AND hash=?2 AND deleted=0",
                params![album_id, digest.to_lowercase()],
                |r| r.get(0),
            )
            .ok();
        Ok(found.is_some())
    }

    pub fn import_bytes(&self, album_id: &str, data: &[u8], meta: &Value, opts: ImportOptions) -> Res<Value> {
        let album = self.get_album(album_id)?;
        let album = match album {
            Some(a) if !a["deleted"].as_bool().unwrap_or(false) => a,
            _ => return Err(DomainError::not_found("收藏夹不存在")),
        };
        let empty = json!([]);
        let artists = if get(meta, "artists").is_array() { get(meta, "artists") } else { &empty };
        self.assert_single_artist_meta(&album, artists)?;
        let digest = sha256_bytes(data);
        if self.has_hash(album_id, &digest)? {
            return Err(DomainError::conflict("重复"));
        }
        let blob_hash = self.k.blobs.put(data)?;
        if blob_hash != digest {
            return Err(DomainError::internal("哈希写入失败"));
        }
        let mut thumb_hash = String::new();
        match opts.thumb {
            Some(t) if !t.is_empty() => thumb_hash = self.k.blobs.put(t)?,
            _ => {
                if let Some(generated) = self.k.blobs.thumb(data) {
                    thumb_hash = self.k.blobs.put(&generated)?;
                }
            }
        }
        let size = png_size(data);
        let item_id = match opts.item_id {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => {
                let from_meta = if truthy(get(meta, "id")) { py_str(get(meta, "id")) } else { String::new() };
                if from_meta.is_empty() {
                    new_id()
                } else {
                    from_meta
                }
            }
        };
        if !valid_id(&item_id) {
            return Err(DomainError::bad("无效的图片 id"));
        }
        let params_v = if get(meta, "params").is_object() { get(meta, "params").clone() } else { json!({}) };
        let name = if truthy(get(meta, "name")) { py_str(get(meta, "name")) } else { "image".into() };
        let added_at = if truthy(get(meta, "addedAt")) { to_int(get(meta, "addedAt")).unwrap_or_else(now_ms) } else { now_ms() };
        let width = if has_value(meta, "width") {
            to_int(get(meta, "width")).map(Value::from).ok_or_else(|| DomainError::bad("width 格式错误"))?
        } else {
            size.map(|s| Value::from(s.0)).unwrap_or(Value::Null)
        };
        let height = if has_value(meta, "height") {
            to_int(get(meta, "height")).map(Value::from).ok_or_else(|| DomainError::bad("height 格式错误"))?
        } else {
            size.map(|s| Value::from(s.1)).unwrap_or(Value::Null)
        };
        let artist_strs: Vec<Value> = artists.as_array().unwrap().iter().map(|a| Value::String(py_str(a))).collect();
        let payload = json!({
            "albumId": album_id,
            "addedAt": added_at,
            "name": take_chars(&name, 240),
            "mime": sniff_mime(data),
            "size": data.len(),
            "blobHash": blob_hash,
            "thumbHash": thumb_hash,
            "width": width,
            "height": height,
            "artists": artist_strs,
            "artistLine": if truthy(get(meta, "artistLine")) { py_str(get(meta, "artistLine")) } else { String::new() },
            "params": params_v,
        });
        let mut art: Artwork = self.k.load(&item_id)?;
        art.import(payload, opts.command_id)?;
        // 幂等键带上图片 id：同一次请求重试不会重复写入；删除 / 移走后再导入同一张图（新 id）必须能成功。
        let default_cid = format!("artwork.import:{item_id}:{blob_hash}:{album_id}");
        self.k.commit(&mut art, Some(opts.command_id.unwrap_or(&default_cid)))?;
        self.get_item(&item_id, false)?.ok_or_else(|| DomainError::internal("导入失败"))
    }

    pub fn move_item(&self, item_id: &str, album_id: &str) -> Res<Value> {
        let album = match self.get_album(album_id)? {
            Some(a) if !a["deleted"].as_bool().unwrap_or(false) => a,
            _ => return Err(DomainError::not_found("收藏夹不存在")),
        };
        let item = self.get_item(item_id, false)?.ok_or_else(|| DomainError::not_found("图片不存在"))?;
        self.assert_single_artist_meta(&album, &item["artists"])?;
        if item["albumId"].as_str() != Some(album_id) && self.has_hash(album_id, item["hash"].as_str().unwrap_or(""))? {
            return Err(DomainError::conflict("目标收藏夹已有这张图"));
        }
        let mut art: Artwork = self.k.load(item_id)?;
        art.move_to(album_id)?;
        self.k.commit(&mut art, None)?;
        self.get_item(item_id, false)?.ok_or_else(|| DomainError::not_found("图片不存在"))
    }

    pub fn delete_item(&self, item_id: &str) -> Res<()> {
        let mut art: Artwork = self.k.load(item_id)?;
        art.delete()?;
        self.k.commit(&mut art, None)?;
        Ok(())
    }

    pub fn restore_item(&self, item_id: &str) -> Res<Value> {
        let mut art: Artwork = self.k.load(item_id)?;
        if !art.album_id.is_empty() && self.has_hash(&art.album_id, &art.hash)? {
            return Err(DomainError::conflict("目标收藏夹已有这张图"));
        }
        art.restore()?;
        self.k.commit(&mut art, None)?;
        self.get_item(item_id, true)?.ok_or_else(|| DomainError::not_found("图片不存在"))
    }

    pub fn clear_album(&self, album_id: &str) -> Res<()> {
        match self.get_album(album_id)? {
            Some(a) if !a["deleted"].as_bool().unwrap_or(false) => {}
            _ => return Err(DomainError::not_found("收藏夹不存在")),
        }
        for item_id in self.item_ids(album_id, false)? {
            self.delete_item(&item_id)?;
        }
        Ok(())
    }

    pub fn artwork_at(&self, item_id: &str, version: i64) -> Res<Value> {
        let mut art = Artwork::create(item_id);
        let stream: Vec<_> = self.k.store.load_stream(item_id)?.into_iter().filter(|e| e.version <= version).collect();
        if stream.is_empty() {
            return Err(DomainError::not_found("图片不存在"));
        }
        for e in &stream {
            art.apply(e.version, &e.event_type, &e.payload);
        }
        Ok(art.snapshot())
    }

    /// 不带权重的画师池：整个收藏夹里出现过的画师，按 key 去重。
    pub fn pool_for_album(&self, album_id: &str) -> Res<Vec<Value>> {
        let items = self.list_items(album_id, false, None, 0, "added_desc")?;
        let mut seen: Vec<String> = Vec::new();
        let mut pool = Vec::new();
        for item in items {
            if let Some(names) = item["artists"].as_array() {
                for name in names {
                    let s = py_str(name);
                    let key = crate::util::collapse_ws_lower(&s);
                    if key.is_empty() || seen.contains(&key) {
                        continue;
                    }
                    seen.push(key.clone());
                    pool.push(json!({"tag": s, "name": s, "key": key, "weight": 1}));
                }
            }
        }
        Ok(pool)
    }

    fn item_ids(&self, album_id: &str, deleted: bool) -> Res<Vec<String>> {
        let conn = self.k.store.connect()?;
        let mut stmt = conn.prepare("SELECT id FROM projections_artworks WHERE album_id=?1 AND deleted=?2")?;
        let rows = stmt.query_map(params![album_id, deleted as i64], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    fn assert_single_artist_meta(&self, album: &Value, artists: &Value) -> Res<()> {
        if !is_single_artist_album(Some(album)) && !is_test_set_album(Some(album)) {
            return Ok(());
        }
        if unique_artist_keys(artists).len() != 1 {
            return Err(DomainError::bad(SINGLE_ARTIST_IMPORT_ERROR));
        }
        Ok(())
    }
}

pub fn ensure_default_album(svc: &GalleryService) -> Res<()> {
    if svc.list_albums(false)?.iter().any(|a| !is_test_set_album(Some(a))) {
        return Ok(());
    }
    svc.create_album("默认收藏夹", Some("default"), false, false)?;
    Ok(())
}

pub fn ensure_single_artist_album(svc: &GalleryService) -> Res<()> {
    if let Some(found) = svc.find_single_artist_album(true)? {
        if found["deleted"].as_bool().unwrap_or(false) {
            svc.restore_album(found["id"].as_str().unwrap_or(""))?;
        }
        return Ok(());
    }
    svc.create_album(SINGLE_ARTIST_ALBUM_NAME, Some(SINGLE_ARTIST_ALBUM_ID), true, false)?;
    Ok(())
}

#[allow(dead_code)]
pub fn empty_map() -> Map<String, Value> {
    Map::new()
}
