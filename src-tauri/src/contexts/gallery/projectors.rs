use super::rules::album_kind;
use crate::kernel::bus::Projector;
use crate::kernel::{Res, StoredEvent};
use crate::pyjson::dumps;
use crate::util::{get, or_else, sql};
use rusqlite::types::Value as S;
use rusqlite::{params_from_iter, Connection, Row};
use serde_json::{json, Value};

pub struct GalleryProjector;

fn t(s: &str) -> S {
    S::Text(s.to_string())
}

fn txt_or_empty(v: &Value) -> S {
    if crate::util::truthy(v) {
        S::Text(crate::util::py_str(v))
    } else {
        S::Text(String::new())
    }
}

impl Projector for GalleryProjector {
    fn handle(&self, event: &StoredEvent, conn: &Connection) -> Res<()> {
        let p = &event.payload;
        let id = &event.aggregate_id;
        let ver = event.version;
        match event.event_type.as_str() {
            "AlbumRegistered" => {
                conn.execute(
                    "INSERT INTO projections_albums (id, name, created_at, sort_order, deleted, version)
                     VALUES (?1, ?2, ?3, ?4, 0, ?5)
                     ON CONFLICT(id) DO UPDATE SET
                        name=excluded.name, created_at=excluded.created_at,
                        sort_order=excluded.sort_order, deleted=0, version=excluded.version",
                    params_from_iter([t(id), sql(get(p, "name")), sql(get(p, "createdAt")), sql(get(p, "order")), S::Integer(ver)]),
                )?;
            }
            "AlbumRenamed" => {
                conn.execute(
                    "UPDATE projections_albums SET name=?1, version=?2 WHERE id=?3",
                    params_from_iter([sql(get(p, "name")), S::Integer(ver), t(id)]),
                )?;
            }
            "AlbumDeleted" => {
                conn.execute(
                    "UPDATE projections_albums SET deleted=1, version=?1 WHERE id=?2",
                    params_from_iter([S::Integer(ver), t(id)]),
                )?;
            }
            "AlbumRestored" => {
                conn.execute(
                    "UPDATE projections_albums SET deleted=0, version=?1 WHERE id=?2",
                    params_from_iter([S::Integer(ver), t(id)]),
                )?;
            }
            "ArtworkImported" => {
                let name = or_else(get(p, "name"), &json!("image")).clone();
                let empty_list = json!([]);
                let empty_obj = json!({});
                conn.execute(
                    "INSERT INTO projections_artworks (
                        id, album_id, added_at, name, mime, size, hash, thumb_hash,
                        width, height, artists, artist_line, params, deleted, version
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14)
                     ON CONFLICT(id) DO UPDATE SET
                        album_id=excluded.album_id, added_at=excluded.added_at, name=excluded.name,
                        mime=excluded.mime, size=excluded.size, hash=excluded.hash,
                        thumb_hash=excluded.thumb_hash, width=excluded.width, height=excluded.height,
                        artists=excluded.artists, artist_line=excluded.artist_line,
                        params=excluded.params, deleted=0, version=excluded.version",
                    params_from_iter([
                        t(id),
                        sql(get(p, "albumId")),
                        sql(get(p, "addedAt")),
                        sql(&name),
                        sql(get(p, "mime")),
                        sql(get(p, "size")),
                        sql(get(p, "blobHash")),
                        txt_or_empty(get(p, "thumbHash")),
                        sql(get(p, "width")),
                        sql(get(p, "height")),
                        S::Text(dumps(or_else(get(p, "artists"), &empty_list))),
                        txt_or_empty(get(p, "artistLine")),
                        S::Text(dumps(or_else(get(p, "params"), &empty_obj))),
                        S::Integer(ver),
                    ]),
                )?;
            }
            "GalleryViewSelected" => {
                conn.execute(
                    "INSERT INTO projections_gallery_view (id, album_id, test_set_id, preset_id, version)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(id) DO UPDATE SET
                        album_id=excluded.album_id, test_set_id=excluded.test_set_id,
                        preset_id=excluded.preset_id, version=excluded.version",
                    params_from_iter([
                        t(id),
                        txt_or_empty(get(p, "albumId")),
                        txt_or_empty(get(p, "testSetId")),
                        txt_or_empty(get(p, "presetId")),
                        S::Integer(ver),
                    ]),
                )?;
            }
            "ArtistBasketAdded" => {
                if let Some(items) = get(p, "items").as_array() {
                    let added = if crate::util::truthy(get(p, "addedAt")) { sql(get(p, "addedAt")) } else { S::Integer(0) };
                    for item in items {
                        conn.execute(
                            "INSERT OR IGNORE INTO projections_artist_basket (key, name, added_at, sort_order)
                             VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM projections_artist_basket))",
                            params_from_iter([sql(get(item, "key")), sql(get(item, "name")), added.clone()]),
                        )?;
                    }
                }
            }
            "ArtistBasketRemoved" => {
                conn.execute(
                    "DELETE FROM projections_artist_basket WHERE key=?1",
                    params_from_iter([txt_or_empty(get(p, "key"))]),
                )?;
            }
            "ArtistBasketCleared" => {
                conn.execute("DELETE FROM projections_artist_basket", [])?;
            }
            "ArtworkMoved" => {
                conn.execute(
                    "UPDATE projections_artworks SET album_id=?1, version=?2 WHERE id=?3",
                    params_from_iter([sql(get(p, "albumId")), S::Integer(ver), t(id)]),
                )?;
            }
            "ArtworkDeleted" => {
                conn.execute(
                    "UPDATE projections_artworks SET deleted=1, version=?1 WHERE id=?2",
                    params_from_iter([S::Integer(ver), t(id)]),
                )?;
            }
            "ArtworkRestored" => {
                conn.execute(
                    "UPDATE projections_artworks SET deleted=0, version=?1 WHERE id=?2",
                    params_from_iter([S::Integer(ver), t(id)]),
                )?;
            }
            _ => {}
        }
        Ok(())
    }
}

pub fn album_row(row: &Row, count: Option<i64>) -> rusqlite::Result<Value> {
    let id: String = row.get("id")?;
    let name: String = row.get("name")?;
    let mut out = json!({
        "id": id,
        "name": name,
        "createdAt": row.get::<_, i64>("created_at")?,
        "order": row.get::<_, i64>("sort_order")?,
        "deleted": row.get::<_, i64>("deleted")? != 0,
        "version": row.get::<_, i64>("version")?,
    });
    if let Some(kind) = album_kind(&id, &name) {
        out["kind"] = json!(kind);
    }
    if let Some(c) = count {
        out["count"] = json!(c);
    }
    Ok(out)
}

fn parse_json_col(raw: Option<String>, fallback: &str) -> Value {
    let text = raw.filter(|s| !s.is_empty()).unwrap_or_else(|| fallback.to_string());
    serde_json::from_str(&text).unwrap_or_else(|_| serde_json::from_str(fallback).unwrap())
}

pub fn artwork_row(row: &Row) -> rusqlite::Result<Value> {
    let thumb: String = row.get::<_, Option<String>>("thumb_hash")?.unwrap_or_default();
    let digest: String = row.get("hash")?;
    let artists = parse_json_col(row.get("artists")?, "[]");
    let params = parse_json_col(row.get("params")?, "{}");
    let thumb_src = if thumb.is_empty() { digest.clone() } else { thumb.clone() };
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "albumId": row.get::<_, String>("album_id")?,
        "addedAt": row.get::<_, i64>("added_at")?,
        "name": row.get::<_, String>("name")?,
        "mime": row.get::<_, Option<String>>("mime")?,
        "size": row.get::<_, Option<i64>>("size")?,
        "hash": digest,
        "thumbHash": thumb,
        "width": row.get::<_, Option<i64>>("width")?,
        "height": row.get::<_, Option<i64>>("height")?,
        "artists": artists,
        "artistLine": row.get::<_, Option<String>>("artist_line")?.unwrap_or_default(),
        "params": params,
        "deleted": row.get::<_, i64>("deleted")? != 0,
        "version": row.get::<_, i64>("version")?,
        "imageUrl": format!("/api/blobs/{digest}"),
        "thumbUrl": format!("/api/blobs/{thumb_src}"),
    }))
}
