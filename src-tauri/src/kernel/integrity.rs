use super::blobs::BlobStore;
use super::bus::{referenced_hashes, verify_chain, Projector};
use super::errors::Res;
use super::hashes::{hex_lower, sha256_bytes};
use super::store::{EventStore, PROJECTION_TABLES};
use crate::pyjson::dumps_sorted;
use rusqlite::types::ValueRef;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

/// 清空投影并按事件顺序重放；整个过程持有写锁，避免和正常写入交错。
pub fn rebuild_projections(store: &EventStore, projectors: &[Box<dyn Projector>]) -> Res<usize> {
    let events = store.load_all()?;
    store.with_write_lock(|| -> Res<usize> {
        let mut conn = store.connect()?;
        let tx = conn.transaction()?;
        for table in PROJECTION_TABLES {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
        tx.execute("DELETE FROM snapshots", [])?;
        for event in &events {
            for p in projectors {
                p.handle(event, &tx)?;
            }
        }
        tx.commit()?;
        Ok(events.len())
    })
}

/// 对每张投影表按首列排序，逐行 `json.dumps(dict(row), sort_keys=True)` 喂入 SHA-256，与 Python 版一致。
pub fn projection_checksum(store: &EventStore) -> Res<String> {
    let conn = store.connect()?;
    let mut hasher = Sha256::new();
    for table in PROJECTION_TABLES {
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

pub fn verify_all(store: &EventStore, blobs: &BlobStore, projectors: &[Box<dyn Projector>]) -> Res<Value> {
    let chain = verify_chain(store)?;
    let mut blob_errors: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let needed = referenced_hashes(store)?;
    let empty = sha256_bytes(b"");
    for digest in &needed {
        if *digest == empty {
            continue;
        }
        if !blobs.exists(digest) {
            missing.push(digest.clone());
        } else if !blobs.verify(digest) {
            blob_errors.push(digest.clone());
        }
    }
    let before = projection_checksum(store)?;
    rebuild_projections(store, projectors)?;
    let after = projection_checksum(store)?;
    let chain_ok = chain.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let ok = chain_ok && missing.is_empty() && blob_errors.is_empty() && before == after;
    missing.truncate(50);
    blob_errors.truncate(50);
    Ok(json!({
        "ok": ok,
        "chain": chain,
        "blobs": {
            "referenced": needed.len(),
            "missing": missing,
            "mismatch": blob_errors,
        },
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
            data_dir.join("blobs").to_string_lossy(),
        ],
        "note": "先停止写入或 WAL checkpoint，再复制 events.sqlite 与 blobs/。Token 在 secrets/，不要打进事件备份以外的公开包。",
    })
}
