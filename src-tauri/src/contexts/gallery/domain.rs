use super::rules::{strip_artist, tag_key};
use crate::kernel::{Aggregate, Core, DomainError, Res};
use crate::util::{get, py_str, take_chars, to_int, truthy};
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub const GALLERY_VIEW_ID: &str = "gallery-view";
pub const ARTIST_BASKET_ID: &str = "artist-basket";

pub struct Album {
    core: Core,
    pub name: String,
    pub created_at: i64,
    pub sort_order: i64,
    pub deleted: bool,
}

impl Album {
    pub fn register(&mut self, name: &str, created_at: i64, sort_order: i64, command_id: Option<&str>) -> Res<()> {
        if self.core.version > 0 && !self.deleted {
            return Err(DomainError::conflict("收藏夹已存在"));
        }
        let name = take_chars(name.trim(), 40);
        if name.is_empty() {
            return Err(DomainError::bad("名称不能为空"));
        }
        self.record_with(
            "AlbumRegistered",
            json!({"name": name, "createdAt": created_at, "order": sort_order}),
            command_id,
        );
        Ok(())
    }

    pub fn rename(&mut self, name: &str) -> Res<()> {
        self.ensure_active()?;
        let name = take_chars(name.trim(), 40);
        if name.is_empty() {
            return Err(DomainError::bad("名称不能为空"));
        }
        if name == self.name {
            return Ok(());
        }
        self.record("AlbumRenamed", json!({"name": name}));
        Ok(())
    }

    pub fn delete(&mut self) -> Res<()> {
        self.ensure_active()?;
        self.record("AlbumDeleted", json!({}));
        Ok(())
    }

    pub fn restore(&mut self) -> Res<()> {
        if self.core.version == 0 {
            return Err(DomainError::not_found("收藏夹不存在"));
        }
        if !self.deleted {
            return Ok(());
        }
        let name = self.name.clone();
        self.record("AlbumRestored", json!({"name": name}));
        Ok(())
    }

    fn ensure_active(&self) -> Res<()> {
        if self.core.version == 0 || self.deleted {
            return Err(DomainError::not_found("收藏夹不存在"));
        }
        Ok(())
    }
}

impl Aggregate for Album {
    const TYPE: &'static str = "Album";
    fn create(id: &str) -> Self {
        Album { core: Core::new(id), name: String::new(), created_at: 0, sort_order: 0, deleted: false }
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn on(&mut self, t: &str, p: &Value) {
        match t {
            "AlbumRegistered" => {
                self.name = py_str(get(p, "name"));
                self.created_at = to_int(get(p, "createdAt")).unwrap_or(0);
                self.sort_order = to_int(get(p, "order")).unwrap_or(0);
                self.deleted = false;
            }
            "AlbumRenamed" => self.name = py_str(get(p, "name")),
            "AlbumDeleted" => self.deleted = true,
            "AlbumRestored" => {
                self.deleted = false;
                if truthy(get(p, "name")) {
                    self.name = py_str(get(p, "name"));
                }
            }
            _ => {}
        }
    }
}

pub struct Artwork {
    core: Core,
    pub album_id: String,
    pub added_at: i64,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub hash: String,
    pub thumb_hash: String,
    pub width: Value,
    pub height: Value,
    pub artists: Vec<Value>,
    pub artist_line: String,
    pub params: Value,
    pub deleted: bool,
}

impl Artwork {
    pub fn import(&mut self, data: Value, command_id: Option<&str>) -> Res<()> {
        if self.core.version > 0 && !self.deleted {
            return Err(DomainError::conflict("图片已存在"));
        }
        self.record_with("ArtworkImported", data, command_id);
        Ok(())
    }

    pub fn move_to(&mut self, album_id: &str) -> Res<()> {
        self.ensure_active()?;
        if album_id == self.album_id {
            return Ok(());
        }
        self.record("ArtworkMoved", json!({"albumId": album_id}));
        Ok(())
    }

    pub fn delete(&mut self) -> Res<()> {
        self.ensure_active()?;
        let (a, h) = (self.album_id.clone(), self.hash.clone());
        self.record("ArtworkDeleted", json!({"albumId": a, "hash": h}));
        Ok(())
    }

    pub fn restore(&mut self) -> Res<()> {
        if self.core.version == 0 {
            return Err(DomainError::not_found("图片不存在"));
        }
        if !self.deleted {
            return Ok(());
        }
        let (a, h) = (self.album_id.clone(), self.hash.clone());
        self.record("ArtworkRestored", json!({"albumId": a, "hash": h}));
        Ok(())
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "id": self.core.id,
            "albumId": self.album_id,
            "addedAt": self.added_at,
            "name": self.name,
            "mime": self.mime,
            "size": self.size,
            "hash": self.hash,
            "thumbHash": self.thumb_hash,
            "width": self.width,
            "height": self.height,
            "artists": self.artists,
            "artistLine": self.artist_line,
            "params": self.params,
            "deleted": self.deleted,
            "version": self.core.version,
        })
    }

    fn ensure_active(&self) -> Res<()> {
        if self.core.version == 0 || self.deleted {
            return Err(DomainError::not_found("图片不存在"));
        }
        Ok(())
    }
}

impl Aggregate for Artwork {
    const TYPE: &'static str = "Artwork";
    fn create(id: &str) -> Self {
        Artwork {
            core: Core::new(id),
            album_id: String::new(),
            added_at: 0,
            name: String::new(),
            mime: String::new(),
            size: 0,
            hash: String::new(),
            thumb_hash: String::new(),
            width: Value::Null,
            height: Value::Null,
            artists: vec![],
            artist_line: String::new(),
            params: json!({}),
            deleted: false,
        }
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn on(&mut self, t: &str, p: &Value) {
        match t {
            "ArtworkImported" => {
                self.album_id = py_str(get(p, "albumId"));
                self.added_at = to_int(get(p, "addedAt")).unwrap_or(0);
                self.name = if truthy(get(p, "name")) { py_str(get(p, "name")) } else { "image".into() };
                self.mime =
                    if truthy(get(p, "mime")) { py_str(get(p, "mime")) } else { "application/octet-stream".into() };
                self.size = to_int(get(p, "size")).unwrap_or(0);
                self.hash = py_str(get(p, "blobHash"));
                self.thumb_hash = if truthy(get(p, "thumbHash")) { py_str(get(p, "thumbHash")) } else { String::new() };
                self.width = get(p, "width").clone();
                self.height = get(p, "height").clone();
                self.artists = get(p, "artists").as_array().cloned().unwrap_or_default();
                self.artist_line = if truthy(get(p, "artistLine")) { py_str(get(p, "artistLine")) } else { String::new() };
                self.params = if get(p, "params").is_object() { get(p, "params").clone() } else { json!({}) };
                self.deleted = false;
            }
            "ArtworkMoved" => self.album_id = py_str(get(p, "albumId")),
            "ArtworkDeleted" => self.deleted = true,
            "ArtworkRestored" => self.deleted = false,
            _ => {}
        }
    }
}

/// 图库的全局视图选择：当前收藏夹、选中的测试集、测试生图预设。
pub struct GalleryView {
    core: Core,
    pub album_id: String,
    pub test_set_id: String,
    pub preset_id: String,
}

impl GalleryView {
    pub fn select(&mut self, album_id: &str, test_set_id: &str, preset_id: &str) {
        if self.core.version > 0
            && self.album_id == album_id
            && self.test_set_id == test_set_id
            && self.preset_id == preset_id
        {
            return;
        }
        self.record(
            "GalleryViewSelected",
            json!({"albumId": album_id, "testSetId": test_set_id, "presetId": preset_id}),
        );
    }
}

impl Aggregate for GalleryView {
    const TYPE: &'static str = "GalleryView";
    fn create(id: &str) -> Self {
        GalleryView { core: Core::new(id), album_id: String::new(), test_set_id: String::new(), preset_id: String::new() }
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn on(&mut self, t: &str, p: &Value) {
        if t == "GalleryViewSelected" {
            let s = |k: &str| if truthy(get(p, k)) { py_str(get(p, k)) } else { String::new() };
            self.album_id = s("albumId");
            self.test_set_id = s("testSetId");
            self.preset_id = s("presetId");
        }
    }
}

/// 画师串面板：收集的画师，不带权重，按加入顺序，去重。
pub struct ArtistBasket {
    core: Core,
    pub keys: BTreeSet<String>,
}

impl ArtistBasket {
    pub fn add(&mut self, names: &[Value], added_at: i64) {
        let mut fresh: Vec<Value> = Vec::new();
        let mut seen = self.keys.clone();
        for raw in names {
            let text = if truthy(raw) { py_str(raw) } else { String::new() };
            let name = take_chars(&strip_artist(&text), 120);
            let key = tag_key(&name);
            if key.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.insert(key.clone());
            fresh.push(json!({"key": key, "name": name}));
        }
        if !fresh.is_empty() {
            self.record("ArtistBasketAdded", json!({"items": fresh, "addedAt": added_at}));
        }
    }

    pub fn remove(&mut self, key: &str) {
        let key = tag_key(key);
        if self.keys.contains(&key) {
            self.record("ArtistBasketRemoved", json!({"key": key}));
        }
    }

    pub fn clear(&mut self) {
        if !self.keys.is_empty() {
            self.record("ArtistBasketCleared", json!({}));
        }
    }
}

impl Aggregate for ArtistBasket {
    const TYPE: &'static str = "ArtistBasket";
    fn create(id: &str) -> Self {
        ArtistBasket { core: Core::new(id), keys: BTreeSet::new() }
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn on(&mut self, t: &str, p: &Value) {
        match t {
            "ArtistBasketAdded" => {
                if let Some(items) = get(p, "items").as_array() {
                    for item in items {
                        let k = if truthy(get(item, "key")) { py_str(get(item, "key")) } else { String::new() };
                        self.keys.insert(k);
                    }
                }
            }
            "ArtistBasketRemoved" => {
                let k = if truthy(get(p, "key")) { py_str(get(p, "key")) } else { String::new() };
                self.keys.remove(&k);
            }
            "ArtistBasketCleared" => self.keys.clear(),
            _ => {}
        }
    }
}
