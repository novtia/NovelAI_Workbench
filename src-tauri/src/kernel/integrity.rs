use super::blobs::{verify_file, BlobStore};
use super::bus::{verify_chain, Projector};
use super::errors::Res;
use super::hashes::{hex_lower, sha256_bytes};
use super::refs;
use super::store::{row_to_event, EventStore, PROJECTION_TABLES};
use crate::pyjson::dumps_sorted;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

/// 在给定事务里清空投影，按事件顺序重放。
pub(crate) fn replay_all(tx: &Connection, projectors: &[Box<dyn Projector>]) -> Res<usize> {
    for table in PROJECTION_TABLES {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    tx.execute("DELETE FROM snapshots", [])?;
    let events = {
        let mut stmt = tx.prepare("SELECT * FROM events ORDER BY global_seq")?;
        let rows = stmt.query_map([], |r| Ok(row_to_event(r)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row??);
        }
        out
    };
    for event in &events {
        for p in projectors {
            p.handle(event, tx)?;
        }
    }
    Ok(events.len())
}

/// 清空投影并按事件顺序重放；整个过程持有写锁，避免和正常写入交错。
pub fn rebuild_projections(store: &EventStore, projectors: &[Box<dyn Projector>]) -> Res<usize> {
    store.with_write_lock(|| -> Res<usize> {
        let mut conn = store.connect()?;
        let tx = conn.transaction()?;
        let n = replay_all(&tx, projectors)?;
        tx.commit()?;
        Ok(n)
    })
}

/// 对每张投影表按首列排序，逐行 `json.dumps(dict(row), sort_keys=True)` 喂入 SHA-256，与 Python 版一致。
pub fn projection_checksum(store: &EventStore) -> Res<String> {
    projection_checksum_of(store, &PROJECTION_TABLES)
}

/// 只算指定的几张表（和 Python 版对照时用：Python 版没有图片引用表）。
pub fn projection_checksum_of(store: &EventStore, tables: &[&str]) -> Res<String> {
    let conn = store.connect()?;
    let mut hasher = Sha256::new();
    for table in tables {
        let mut stmt = conn.prepare(&format!("SELECT * FROM {table} ORDER BY 1"))?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let mut obj = Map::new();
            for (i, name) in names.iter().enumerate() {
                let v = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
                    ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
                    ValueRef::Blob(b) => Value::String(format!("{b:?}")),
                };
                obj.insert(name.clone(), v);
            }
            hasher.update(dumps_sorted(&Value::Object(obj)).as_bytes());
        }
    }
    Ok(hex_lower(&hasher.finalize()))
}

/// 引用表里每个位置上的图都要在、而且内容和哈希对得上。还没整理的旧图放在旧目录里，也算在。
pub fn check_files(store: &EventStore, blobs: &BlobStore) -> Res<Value> {
    let all = refs::all_refs(&store.connect()?)?;
    let empty = sha256_bytes(b"");
    let (mut files, mut legacy) = (0usize, 0usize);
    let mut missing: Vec<String> = Vec::new();
    let mut mismatch: Vec<String> = Vec::new();
    for (hash, slots) in &all {
        if *hash == empty {
            continue;
        }
        for slot in slots {
            files += 1;
            let path = match blobs.path_in(slot, hash) {
                Some(p) => p,
                None => {
                    let old = blobs.legacy_path(hash);
                    if !old.is_file() {
                        missing.push(format!("{}/{hash}", slot.label()));
                        continue;
                    }
                    legacy += 1;
                    old
                }
            };
            if !verify_file(&path, hash) {
                mismatch.push(format!("{}/{hash}", slot.label()));
            }
        }
    }
    let ok = missing.is_empty() && mismatch.is_empty();
    let (missing_count, mismatch_count) = (missing.len(), mismatch.len());
    missing.truncate(50);
    mismatch.truncate(50);
    Ok(json!({
        "ok": ok,
        "referenced": all.len(),
        "files": files,
        "legacy": legacy,
        "missingCount": missing_count,
        "mismatchCount": mismatch_count,
        "missing": missing,
        "mismatch": mismatch,
    }))
}

pub fn verify_all(store: &EventStore, blobs: &BlobStore, projectors: &[Box<dyn Projector>]) -> Res<Value> {
    let chain = verify_chain(store)?;
    let files = check_files(store, blobs)?;
    let before = projection_checksum(store)?;
    rebuild_projections(store, projectors)?;
    let after = projection_checksum(store)?;
    let chain_ok = chain.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let files_ok = files.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(json!({
        "ok": chain_ok && files_ok && before == after,
        "chain": chain,
        "blobs": files,
        "projections": {
            "checksumBefore": before,
            "checksumAfter": after,
            "match": before == after,
        },
    }))
}

pub fn backup_hint(data_dir: &Path) -> Value {
    json!({
        "copy": [
            data_dir.join("events.sqlite").to_string_lossy(),
            data_dir.join("images").to_string_lossy(),
        ],
        "note": "先停止写入或 WAL checkpoint，再复制 events.sqlite 与 images/（还没整理存储的话，旧图在 blobs/）。Token 在 secrets/，不要打进事件备份以外的公开包。",
    })
}
