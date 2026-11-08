//! 把旧的扁平图片目录拆进各桶，并清掉没有归属的事件。
//!
//! 先给出一份清单（不改图片文件），确认后再执行。执行前会把数据库备份到 `backups/`。

use crate::app::projectors;
use crate::contexts::lottery::domain::{lottery_client_draw_id, stamp_draw_ids};
use crate::kernel::blobs::{gallery_target, BlobStore, Bucket};
use crate::kernel::bus::Kernel;
use crate::kernel::clock::now_ms;
use crate::kernel::integrity::{rebuild_projections, verify_all};
use crate::kernel::purge::{plan_job_items, stream_events, Purge};
use crate::kernel::refs;
use crate::kernel::store::EventStore;
use crate::kernel::transfer::export_db;
use crate::kernel::{DomainError, Res};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

pub fn startup(k: &Kernel) -> Res<()> {
    refs::ensure_filled(&k.store)?;
    gc_inputs(k)?;
    for path in preview_files(&preview_dir(&k.blobs)) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

pub fn status(k: &Kernel) -> Res<Value> {
    let conn = k.store.connect()?;
    let count = |sql: &str| -> Res<i64> { Ok(conn.query_row(sql, [], |r| r.get(0))?) };
    let legacy = k.blobs.legacy_files().len();
    let previews = preview_files(&preview_dir(&k.blobs)).len();
    let failed =
        count("SELECT COUNT(*) FROM projections_jobs WHERE status IN ('error', 'cancelled')")?;
    let deleted_albums = count("SELECT COUNT(*) FROM projections_albums WHERE deleted=1")?;
    let deleted_artworks = count("SELECT COUNT(*) FROM projections_artworks WHERE deleted=1")?;
    Ok(json!({
        "legacyFiles": legacy,
        "previews": previews,
        "failedJobs": failed,
        "deletedAlbums": deleted_albums,
        "deletedArtworks": deleted_artworks,
        "needsOrganize": legacy > 0 || previews > 0 || failed > 0 || deleted_albums > 0 || deleted_artworks > 0,
    }))
}

pub fn plan(k: &Kernel, data_dir: &Path) -> Res<Value> {
    ensure_idle(&k.store)?;
    let scratch = data_dir.join(format!("plan-{}", now_ms()));
    std::fs::create_dir_all(&scratch)?;
    let copy = scratch.join("events.sqlite");
    let result = (|| -> Res<Value> {
        export_db(&k.store, &copy)?;
        let staged = Kernel::new(
            EventStore::open(&copy)?,
            BlobStore::new(&scratch.join("images"), &scratch.join("legacy"))?,
            projectors(),
        );
        run_organize(&staged, &k.blobs, false)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

pub fn migrate(k: &Kernel, data_dir: &Path) -> Res<Value> {
    ensure_idle(&k.store)?;
    let backup = data_dir
        .join("backups")
        .join(format!("events-before-migrate-{}.sqlite", now_ms()));
    let saved = export_db(&k.store, &backup)?;
    let mut report = apply(k)?;
    report["backup"] = saved.get("path").cloned().unwrap_or(Value::Null);
    Ok(report)
}

/// 按当前库直接整理。调用方已经自行备份时用这个，不再复制数据库。
pub fn apply(k: &Kernel) -> Res<Value> {
    ensure_idle(&k.store)?;
    let mut report = run_organize(k, &k.blobs, true)?;
    report["verify"] = verify_all(&k.store, &k.blobs, &k.projectors)?;
    Ok(report)
}

pub fn vacuum(store: &EventStore) -> Res<Value> {
    let before = std::fs::metadata(&store.db_path)
        .map(|m| m.len())
        .unwrap_or(0);
    store.with_write_lock(|| -> Res<()> {
        store.connect()?.execute_batch("VACUUM")?;
        Ok(())
    })?;
    let after = std::fs::metadata(&store.db_path)
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(json!({"before": before, "after": after}))
}

fn ensure_idle(store: &EventStore) -> Res<()> {
    let n: i64 = store.connect()?.query_row(
        "SELECT COUNT(*) FROM projections_jobs WHERE status IN ('queued', 'running')",
        [],
        |r| r.get(0),
    )?;
    if n > 0 {
        return Err(DomainError::conflict(
            "还有生图任务在排队或进行中，请等它们结束或取消后再整理",
        ));
    }
    Ok(())
}

fn run_organize(k: &Kernel, files: &BlobStore, apply: bool) -> Res<Value> {
    let plan = build_purge(&k.store)?;
    let stats = k.purge_keep_files(&plan)?;
    rebuild_projections(&k.store, &k.projectors)?;
    let file_stats = refs::sync_files(&k.store, files, apply)?;
    let previews = preview_files(&preview_dir(files));
    if apply {
        for path in &previews {
            let _ = std::fs::remove_file(path);
        }
        files.prune_dirs();
    }
    Ok(json!({
        "aggregates": stats.aggregates.len(),
        "events": stats.events,
        "rewritten": stats.rewritten,
        "rehashed": stats.rehashed,
        "filesMoved": file_stats.moved,
        "filesCopied": file_stats.copied,
        "filesDeleted": file_stats.deleted,
        "bytesFreed": file_stats.bytes,
        "filesMissing": file_stats.missing,
        "previewsDeleted": previews.len(),
        "applied": apply,
    }))
}

fn preview_dir(blobs: &BlobStore) -> PathBuf {
    blobs
        .root
        .parent()
        .map(|p| p.join("previews"))
        .unwrap_or_else(|| PathBuf::from("previews"))
}

fn preview_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".png") {
            out.push(entry.path());
        }
    }
    out
}

fn gc_inputs(k: &Kernel) -> Res<()> {
    let conn = k.store.connect()?;
    for file in k.blobs.files() {
        let Some(slot) = file.slot.clone() else {
            continue;
        };
        if !matches!(slot.bucket, Bucket::Inputs) {
            continue;
        }
        if !refs::is_referenced(&conn, &file.hash, &slot)? {
            k.blobs.remove(&slot, &file.hash);
        }
    }
    Ok(())
}

struct JobRow {
    id: String,
    source: String,
    status: String,
    client: Value,
    items: Vec<Value>,
    finished: i64,
    created: i64,
}

fn build_purge(store: &EventStore) -> Res<Purge> {
    let conn = store.connect()?;
    let mut plan = Purge::default();

    let deleted_albums: HashSet<String> =
        query_ids(&conn, "SELECT id FROM projections_albums WHERE deleted=1")?
            .into_iter()
            .collect();
    for id in &deleted_albums {
        plan.drop_aggregate(id);
        let mut stmt = conn.prepare("SELECT id FROM projections_artworks WHERE album_id=?1")?;
        let rows = stmt.query_map([id], |r| r.get::<_, String>(0))?;
        for row in rows {
            plan.drop_aggregate(&row?);
        }
    }
    for id in query_ids(&conn, "SELECT id FROM projections_artworks WHERE deleted=1")? {
        plan.drop_aggregate(&id);
    }
    for id in query_ids(
        &conn,
        "SELECT id FROM projections_param_sets WHERE deleted=1",
    )? {
        plan.drop_aggregate(&id);
    }

    let mut live: HashMap<String, HashSet<String>> = HashMap::new();
    {
        let mut stmt =
            conn.prepare("SELECT album_id, hash FROM projections_artworks WHERE deleted=0")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (album, hash) = row?;
            if !deleted_albums.contains(&album) {
                live.entry(album).or_default().insert(hash.to_lowercase());
            }
        }
    }

    let mut batches: HashMap<String, (bool, BTreeSet<String>, Vec<Value>)> = HashMap::new();
    {
        let mut stmt =
            conn.prepare("SELECT id, deleted, draws_json FROM projections_lottery_batches")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (id, deleted, draws_json) = row?;
            let draws = clean_draws(&id, &draws_json);
            let ids = draws
                .iter()
                .map(|d| crate::util::py_str(crate::util::get(d, "id")))
                .filter(|s| !s.is_empty())
                .collect();
            batches.insert(id, (deleted != 0, ids, draws));
        }
    }

    let jobs = load_jobs(&conn)?;
    let mut lottery: BTreeMap<(String, String), Vec<JobRow>> = BTreeMap::new();
    for job in jobs {
        if matches!(job.status.as_str(), "error" | "cancelled") {
            plan.drop_aggregate(&job.id);
            continue;
        }
        if job.status != "done" {
            continue;
        }
        match job.source.as_str() {
            "studio" => {
                if job.items.is_empty() {
                    plan.drop_aggregate(&job.id);
                } else {
                    plan_job_items(
                        &conn,
                        &job.id,
                        &label(&job.items, &Bucket::Studio),
                        &mut plan,
                    )?;
                }
            }
            "gallery" => {
                let Some(album) = gallery_target(&job.client) else {
                    plan.drop_aggregate(&job.id);
                    continue;
                };
                if deleted_albums.contains(&album) {
                    plan.drop_aggregate(&job.id);
                    continue;
                }
                let hashes = live.get(&album);
                let keep: Vec<Value> = job
                    .items
                    .iter()
                    .filter(|it| {
                        let h = crate::util::py_str(crate::util::get(it, "blobHash"))
                            .trim()
                            .to_lowercase();
                        hashes.map(|set| set.contains(&h)).unwrap_or(false)
                    })
                    .cloned()
                    .collect();
                if keep.is_empty() {
                    plan.drop_aggregate(&job.id);
                } else {
                    plan_job_items(
                        &conn,
                        &job.id,
                        &label(&keep, &Bucket::Favorites(album)),
                        &mut plan,
                    )?;
                }
            }
            "lottery" => {
                let batch_id = text_field(&job.client, "batchId");
                let draw = lottery_client_draw_id(&batch_id, &job.client);
                let doomed = batch_id.is_empty()
                    || draw.is_empty()
                    || batches
                        .get(&batch_id)
                        .map(|(deleted, ids, _)| *deleted || !ids.contains(&draw))
                        .unwrap_or(true);
                if doomed {
                    plan.drop_aggregate(&job.id);
                } else {
                    lottery.entry((batch_id, draw)).or_default().push(job);
                }
            }
            _ => {
                if job.items.is_empty() {
                    plan.drop_aggregate(&job.id);
                } else {
                    plan_job_items(
                        &conn,
                        &job.id,
                        &label(&job.items, &Bucket::Studio),
                        &mut plan,
                    )?;
                }
            }
        }
    }
    for ((_, _), group) in lottery {
        let mut keep_at = 0usize;
        let mut best = (i64::MIN, i64::MIN, String::new());
        for (i, job) in group.iter().enumerate() {
            let rank = (job.finished, job.created, job.id.clone());
            if rank > best {
                best = rank;
                keep_at = i;
            }
        }
        for (i, job) in group.iter().enumerate() {
            if i == keep_at {
                plan_job_items(
                    &conn,
                    &job.id,
                    &label(&job.items, &Bucket::Lottery),
                    &mut plan,
                )?;
            } else {
                plan.drop_aggregate(&job.id);
            }
        }
    }

    for (id, (deleted, _, draws)) in &batches {
        if *deleted || draws.is_empty() {
            plan.drop_aggregate(id);
            continue;
        }
        let rows = stream_events(&conn, id)?;
        let mut saw = false;
        for row in &rows {
            if row.event_type == "DrawRemoved" {
                plan.events.insert(row.seq);
            } else if row.event_type == "DrawBatchCreated" {
                let mut payload = row.payload.clone();
                payload["draws"] = Value::Array(draws.clone());
                plan.rewrites.insert(row.seq, payload);
                saw = true;
            }
        }
        if !saw {
            plan.drop_aggregate(id);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT global_seq, aggregate_id FROM events WHERE event_type='JobPreviewed'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (seq, agg) = row?;
            if !plan.aggregates.contains(&agg) {
                plan.events.insert(seq);
            }
        }
    }
    Ok(plan)
}

fn load_jobs(conn: &Connection) -> Res<Vec<JobRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, source, status, client_json, items_json, finished_at, created_at FROM projections_jobs",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, i64>(6)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, source, status, client, items, finished, created) = row?;
        out.push(JobRow {
            id,
            source,
            status,
            client: parse_json(client, Value::Null),
            items: parse_json(items, json!([]))
                .as_array()
                .cloned()
                .unwrap_or_default(),
            finished: finished.unwrap_or(0),
            created,
        });
    }
    Ok(out)
}

fn query_ids(conn: &Connection, sql: &str) -> Res<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn parse_json(raw: Option<String>, fallback: Value) -> Value {
    raw.filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(fallback)
}

fn text_field(v: &Value, key: &str) -> String {
    let value = crate::util::get(v, key);
    if crate::util::truthy(value) {
        crate::util::py_str(value).trim().to_string()
    } else {
        String::new()
    }
}

fn label(items: &[Value], bucket: &Bucket) -> Vec<Value> {
    let text = bucket.label();
    items
        .iter()
        .map(|it| {
            let mut copy = it.clone();
            if let Some(obj) = copy.as_object_mut() {
                obj.insert("bucket".into(), json!(text));
            }
            copy
        })
        .collect()
}

fn clean_draws(batch_id: &str, raw: &str) -> Vec<Value> {
    let mut draws = serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    stamp_draw_ids(&mut draws, batch_id);
    for draw in &mut draws {
        if let Some(obj) = draw.as_object_mut() {
            obj.remove("previews");
            obj.remove("jobId");
        }
    }
    draws
}
