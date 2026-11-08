//! 图片引用表 `projections_blob_refs`：哪条记录（owner = 聚合 id）在用哪个位置上的哪张图。
//!
//! 删除时按它判断文件还有没有别人在用，最后一条引用没了才删文件；完整性校验和导出完整包也按它找图。
//! 它和别的投影一样由事件重放得到。投影器要排在图库、生图投影器之后，因为要读它们刚写好的行。

use super::blobs::{BlobStore, Bucket, Slot};
use super::bus::Projector;
use super::errors::Res;
use super::events::StoredEvent;
use super::hashes::is_hash64;
use super::store::EventStore;
use crate::util::{get, py_str, truthy};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// `PRAGMA user_version` 达到这个值说明引用表已经建好。
const REFS_VERSION: i64 = 1;

pub struct RefsProjector;

fn hash_of(v: &Value) -> Option<String> {
    if !truthy(v) {
        return None;
    }
    let s = py_str(v).trim().to_lowercase();
    is_hash64(&s).then_some(s)
}

fn parse_json(raw: Option<String>, fallback: &str) -> Value {
    raw.filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::from_str(fallback).unwrap())
}

fn add(conn: &Connection, hash: &str, slot: &Slot, owner: &str) -> Res<()> {
    let label = slot.label();
    conn.execute(
        "INSERT OR IGNORE INTO projections_blob_refs (ref, hash, slot, owner) VALUES (?1, ?2, ?3, ?4)",
        params![format!("{owner}|{label}|{hash}"), hash, label, owner],
    )?;
    Ok(())
}

/// 生图请求里用到的底图 / 蒙版。
pub fn input_hashes(request: &Value) -> Vec<String> {
    ["imageHash", "maskHash"]
        .iter()
        .filter_map(|k| hash_of(get(request, k)))
        .collect()
}

/// 任务结果条目在哪个桶：条目自己记了 `bucket` 就用它，否则按任务来源推断。
pub fn item_bucket(item: &Value, fallback: &Bucket) -> Bucket {
    get(item, "bucket")
        .as_str()
        .and_then(Bucket::parse)
        .unwrap_or_else(|| fallback.clone())
}

/// 一个任务结果条目占用的文件：原图和缩略图。
pub fn item_files(item: &Value, fallback: &Bucket) -> Vec<(String, Slot)> {
    let bucket = item_bucket(item, fallback);
    let mut out = Vec::new();
    if let Some(h) = hash_of(get(item, "blobHash")) {
        out.push((h, Slot::image(bucket.clone())));
    }
    if let Some(h) = hash_of(get(item, "thumbHash")) {
        out.push((h, Slot::thumb(bucket)));
    }
    out
}

/// 按投影里的任务行刷新它的结果图引用；底图 / 蒙版的引用不动。
fn refresh_job_items(conn: &Connection, job_id: &str) -> Res<()> {
    conn.execute(
        "DELETE FROM projections_blob_refs WHERE owner=?1 AND slot<>'inputs'",
        params![job_id],
    )?;
    let row: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT source, client_json, items_json FROM projections_jobs WHERE id=?1",
            params![job_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((source, client, items)) = row else {
        return Ok(());
    };
    let fallback = Bucket::for_job(&source, &parse_json(client, "{}"));
    for item in parse_json(items, "[]")
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        for (h, slot) in item_files(&item, &fallback) {
            add(conn, &h, &slot, job_id)?;
        }
    }
    Ok(())
}

fn add_inputs(conn: &Connection, job_id: &str, queued_payload: &Value) -> Res<()> {
    for h in input_hashes(get(queued_payload, "payload")) {
        add(conn, &h, &Slot::image(Bucket::Inputs), job_id)?;
    }
    Ok(())
}

fn refresh_artwork(conn: &Connection, id: &str) -> Res<()> {
    conn.execute(
        "DELETE FROM projections_blob_refs WHERE owner=?1",
        params![id],
    )?;
    let row: Option<(String, String, Option<String>, i64)> = conn
        .query_row(
            "SELECT album_id, hash, thumb_hash, deleted FROM projections_artworks WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((album, hash, thumb, deleted)) = row else {
        return Ok(());
    };
    if deleted != 0 {
        return Ok(());
    }
    let bucket = Bucket::Favorites(album);
    if let Some(h) = hash_of(&Value::String(hash)) {
        add(conn, &h, &Slot::image(bucket.clone()), id)?;
    }
    if let Some(h) = thumb.and_then(|t| hash_of(&Value::String(t))) {
        add(conn, &h, &Slot::thumb(bucket), id)?;
    }
    Ok(())
}

impl Projector for RefsProjector {
    fn handle(&self, event: &StoredEvent, conn: &Connection) -> Res<()> {
        let id = &event.aggregate_id;
        match event.event_type.as_str() {
            "JobQueued" => {
                conn.execute(
                    "DELETE FROM projections_blob_refs WHERE owner=?1",
                    params![id],
                )?;
                add_inputs(conn, id, &event.payload)?;
            }
            "JobCompleted" | "JobItemsRemoved" => refresh_job_items(conn, id)?,
            "ArtworkImported" | "ArtworkMoved" | "ArtworkDeleted" | "ArtworkRestored" => {
                refresh_artwork(conn, id)?
            }
            _ => {}
        }
        Ok(())
    }
}

/// 这张图在这个位置上还有没有人用。
pub fn is_referenced(conn: &Connection, hash: &str, slot: &Slot) -> Res<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM projections_blob_refs WHERE hash=?1 AND slot=?2 LIMIT 1",
            params![hash.to_lowercase(), slot.label()],
            |r| r.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

/// 这张图被用到的全部位置。
pub fn slots_of(conn: &Connection, hash: &str) -> Res<Vec<Slot>> {
    let mut stmt = conn.prepare("SELECT slot FROM projections_blob_refs WHERE hash=?1")?;
    let rows = stmt.query_map(params![hash.to_lowercase()], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(slot) = Slot::parse(&row?) {
            out.push(slot);
        }
    }
    Ok(out)
}

/// 这张图在任何位置上还有没有人用。
pub fn is_used(conn: &Connection, hash: &str) -> Res<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM projections_blob_refs WHERE hash=?1 LIMIT 1",
            params![hash.to_lowercase()],
            |r| r.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

/// 这些记录用着的全部文件。
pub fn files_of(conn: &Connection, owners: &BTreeSet<String>) -> Res<BTreeSet<(String, Slot)>> {
    let mut out = BTreeSet::new();
    let mut stmt = conn.prepare("SELECT hash, slot FROM projections_blob_refs WHERE owner=?1")?;
    for owner in owners {
        let rows = stmt.query_map(params![owner], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for r in rows {
            let (hash, label) = r?;
            if let Some(slot) = Slot::parse(&label) {
                out.insert((hash, slot));
            }
        }
    }
    Ok(out)
}

/// 全部引用：哈希 → 用到它的位置。
pub fn all_refs(conn: &Connection) -> Res<BTreeMap<String, BTreeSet<Slot>>> {
    let mut out: BTreeMap<String, BTreeSet<Slot>> = BTreeMap::new();
    let mut stmt = conn.prepare("SELECT hash, slot FROM projections_blob_refs")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for r in rows {
        let (hash, label) = r?;
        if let Some(slot) = Slot::parse(&label) {
            out.entry(hash).or_default().insert(slot);
        }
    }
    Ok(out)
}

/// 按现有投影补齐引用表，结果和事件重放得到的一样。
pub fn fill(conn: &Connection) -> Res<usize> {
    conn.execute("DELETE FROM projections_blob_refs", [])?;
    {
        let mut stmt = conn.prepare(
            "SELECT aggregate_id, payload_json FROM events
             WHERE event_type='JobQueued' AND payload_json LIKE '%Hash%'",
        )?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (job_id, payload) in rows {
            let payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
            add_inputs(conn, &job_id, &payload)?;
        }
    }
    let jobs: Vec<String> = conn
        .prepare("SELECT id FROM projections_jobs WHERE items_json IS NOT NULL AND items_json NOT IN ('', '[]')")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for id in jobs {
        refresh_job_items(conn, &id)?;
    }
    let artworks: Vec<String> = conn
        .prepare("SELECT id FROM projections_artworks WHERE deleted=0")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for id in artworks {
        refresh_artwork(conn, &id)?;
    }
    Ok(
        conn.query_row("SELECT COUNT(*) FROM projections_blob_refs", [], |r| {
            r.get::<_, i64>(0)
        })? as usize,
    )
}

/// 旧库第一次用上引用表时补一遍。返回是否补过。
pub fn ensure_filled(store: &EventStore) -> Res<bool> {
    let conn = store.connect()?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= REFS_VERSION {
        return Ok(false);
    }
    drop(conn);
    store.with_write_lock(|| -> Res<()> {
        let mut conn = store.connect()?;
        let tx = conn.transaction()?;
        fill(&tx)?;
        tx.commit()?;
        conn.execute_batch(&format!("PRAGMA user_version = {REFS_VERSION}"))?;
        Ok(())
    })?;
    Ok(true)
}

#[derive(Debug, Default, Clone)]
pub struct FileStats {
    pub moved: usize,
    pub copied: usize,
    pub missing: usize,
    pub deleted: usize,
    pub bytes: u64,
}

/// 让磁盘上的文件和引用表一致。`apply` 为 false 时只统计，不改文件。
pub fn sync_files(store: &EventStore, blobs: &BlobStore, apply: bool) -> Res<FileStats> {
    let conn = store.connect()?;
    let refs = all_refs(&conn)?;
    let bucket_files = blobs.files();
    let legacy_files = blobs.legacy_files();
    let legacy_present: BTreeSet<String> = legacy_files.iter().map(|f| f.hash.clone()).collect();

    let mut will: BTreeSet<(String, String)> = BTreeSet::new();
    for (hash, slots) in &refs {
        for slot in slots {
            if blobs.has(slot, hash) {
                will.insert((hash.clone(), slot.label()));
            }
        }
    }

    let mut moves: Vec<(String, Slot)> = Vec::new();
    let mut copies: Vec<(String, Slot)> = Vec::new();
    let mut legacy_taken: BTreeSet<String> = BTreeSet::new();
    let mut missing = 0usize;
    for (hash, slots) in &refs {
        let mut legacy_free = legacy_present.contains(hash);
        for slot in slots {
            let key = (hash.clone(), slot.label());
            if will.contains(&key) {
                continue;
            }
            if legacy_free {
                moves.push((hash.clone(), slot.clone()));
                legacy_free = false;
                legacy_taken.insert(hash.clone());
                will.insert(key);
            } else if will.iter().any(|(h, _)| h == hash) || blobs.exists(hash) {
                copies.push((hash.clone(), slot.clone()));
                will.insert(key);
            } else {
                missing += 1;
            }
        }
    }

    let mut deletes: Vec<(String, Slot, u64)> = Vec::new();
    for file in &bucket_files {
        let Some(slot) = file.slot.clone() else {
            continue;
        };
        let referenced = refs
            .get(&file.hash)
            .map(|s| s.contains(&slot))
            .unwrap_or(false);
        if !referenced {
            deletes.push((file.hash.clone(), slot, file.size));
        }
    }
    let mut legacy_deletes: Vec<(String, u64)> = Vec::new();
    for file in &legacy_files {
        if legacy_taken.contains(&file.hash) {
            continue;
        }
        let fully = match refs.get(&file.hash) {
            Some(slots) => slots
                .iter()
                .all(|slot| will.contains(&(file.hash.clone(), slot.label()))),
            None => true,
        };
        if fully {
            legacy_deletes.push((file.hash.clone(), file.size));
        }
    }

    let mut stats = FileStats {
        moved: moves.len(),
        copied: copies.len(),
        missing,
        deleted: 0,
        bytes: 0,
    };
    stats.deleted = deletes.len() + legacy_deletes.len();
    stats.bytes = deletes.iter().map(|(_, _, n)| *n).sum::<u64>()
        + legacy_deletes.iter().map(|(_, n)| *n).sum::<u64>();
    if !apply {
        return Ok(stats);
    }
    for (hash, slot) in &moves {
        blobs.move_legacy(slot, hash)?;
    }
    for (hash, slot) in &copies {
        if !blobs.copy_into(slot, hash)? {
            stats.copied = stats.copied.saturating_sub(1);
            stats.missing += 1;
        }
    }
    for (hash, slot, _) in &deletes {
        blobs.remove(slot, hash);
    }
    for (hash, _) in &legacy_deletes {
        blobs.remove_legacy(hash);
    }
    blobs.prune_dirs();
    Ok(stats)
}
