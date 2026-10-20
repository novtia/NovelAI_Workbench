use super::application::{GalleryService, ImportOptions};
use super::domain::Album;
use crate::kernel::clock::now_ms;
use crate::kernel::Res;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::Path;

/// 把旧版 `ddd/data/gallery.db` 只读迁入事件库；`command_id` 保证重复执行不会重复写入。
pub fn migrate_legacy(service: &GalleryService, legacy_data: &Path) -> Res<Value> {
    let db_path = legacy_data.join("gallery.db");
    let images = legacy_data.join("images");
    let thumbs = legacy_data.join("thumbs");
    if !db_path.is_file() {
        return Ok(json!({"imported": 0, "albums": 0, "skipped": true}));
    }
    let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    struct AlbumRow {
        id: String,
        name: String,
        created_at: i64,
        sort_order: i64,
    }
    struct ItemRow {
        id: String,
        album_id: String,
        name: String,
        added_at: Option<i64>,
        width: Option<i64>,
        height: Option<i64>,
        artists: Option<String>,
        artist_line: Option<String>,
        params: Option<String>,
    }

    let albums: Vec<AlbumRow> = {
        let mut stmt = conn.prepare("SELECT * FROM albums ORDER BY sort_order, created_at")?;
        let rows = stmt.query_map([], |r| {
            Ok(AlbumRow {
                id: r.get("id")?,
                name: r.get("name")?,
                created_at: r.get("created_at")?,
                sort_order: r.get("sort_order")?,
            })
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let items: Vec<ItemRow> = {
        let mut stmt = conn.prepare("SELECT * FROM items ORDER BY added_at")?;
        let rows = stmt.query_map([], |r| {
            Ok(ItemRow {
                id: r.get("id")?,
                album_id: r.get("album_id")?,
                name: r.get("name")?,
                added_at: r.get("added_at")?,
                width: r.get("width")?,
                height: r.get("height")?,
                artists: r.get("artists")?,
                artist_line: r.get("artist_line")?,
                params: r.get("params")?,
            })
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };
    drop(conn);

    let (mut album_n, mut item_n, mut skipped) = (0, 0, 0);
    for row in &albums {
        let command_id = format!("legacy:album:{}", row.id);
        if !service.k.store.events_for_command(&command_id)?.is_empty() {
            album_n += 1;
            continue;
        }
        let result = (|| -> Res<()> {
            let mut album: Album = service.k.load(&row.id)?;
            album.register(&row.name, row.created_at, row.sort_order, Some(&command_id))?;
            service.k.commit(&mut album, Some(&command_id))?;
            Ok(())
        })();
        match result {
            Ok(_) => album_n += 1,
            Err(_) => skipped += 1,
        }
    }
    for row in &items {
        let command_id = format!("legacy:item:{}", row.id);
        if !service.k.store.events_for_command(&command_id)?.is_empty() {
            item_n += 1;
            continue;
        }
        let image_path = images.join(&row.id);
        if !image_path.is_file() {
            skipped += 1;
            continue;
        }
        let Ok(data) = std::fs::read(&image_path) else {
            skipped += 1;
            continue;
        };
        let thumb_path = thumbs.join(&row.id);
        let thumb = if thumb_path.is_file() { std::fs::read(&thumb_path).ok() } else { None };
        let parse = |s: &Option<String>, fallback: Value| -> Value {
            s.as_deref()
                .filter(|x| !x.is_empty())
                .and_then(|x| serde_json::from_str(x).ok())
                .unwrap_or(fallback)
        };
        let meta = json!({
            "id": row.id,
            "name": row.name,
            "addedAt": row.added_at.filter(|v| *v != 0).unwrap_or_else(now_ms),
            "width": row.width,
            "height": row.height,
            "artists": parse(&row.artists, json!([])),
            "artistLine": row.artist_line.clone().unwrap_or_default(),
            "params": parse(&row.params, json!({})),
        });
        let res = service.import_bytes(
            &row.album_id,
            &data,
            &meta,
            ImportOptions { thumb: thumb.as_deref(), command_id: Some(&command_id), item_id: Some(&row.id) },
        );
        match res {
            Ok(_) => item_n += 1,
            Err(_) => skipped += 1,
        }
    }
    Ok(json!({"imported": item_n, "albums": album_n, "skipped": skipped}))
}
