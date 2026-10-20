use super::blobs::BlobStore;
use super::errors::Res;
use super::events::{Aggregate, StoredEvent};
use super::hashes::{event_hash, GENESIS_HASH};
use super::store::EventStore;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub trait Projector: Send + Sync {
    fn handle(&self, event: &StoredEvent, conn: &Connection) -> Res<()>;
}

/// 事件库 + blob 库 + 投影器；对应 Python 的 UnitOfWork。
pub struct Kernel {
    pub store: EventStore,
    pub blobs: BlobStore,
    pub projectors: Vec<Box<dyn Projector>>,
}

impl Kernel {
    pub fn load<A: Aggregate>(&self, id: &str) -> Res<A> {
        let mut agg = A::create(id);
        for ev in self.store.load_stream(id)? {
            agg.apply(ev.version, &ev.event_type, &ev.payload);
        }
        Ok(agg)
    }

    /// 一个聚合的待提交事件 = 一次提交：同一个事务里写事件和投影。
    pub fn commit<A: Aggregate>(&self, agg: &mut A, command_id: Option<&str>) -> Res<Vec<StoredEvent>> {
        if agg.core().pending.is_empty() {
            return Ok(vec![]);
        }
        let pending = std::mem::take(&mut agg.core_mut().pending);
        let projectors = &self.projectors;
        let mut after = |stored: &[StoredEvent], conn: &Connection| -> Res<()> {
            for event in stored {
                for p in projectors {
                    p.handle(event, conn)?;
                }
            }
            Ok(())
        };
        self.store.append(pending, command_id, &mut after)
    }
}

pub fn verify_chain(store: &EventStore) -> Res<Value> {
    let events = store.load_all()?;
    let mut prev = GENESIS_HASH.to_string();
    let mut errors: Vec<String> = Vec::new();
    for event in &events {
        if event.prev_hash != prev {
            errors.push(format!("seq {}: prev_hash mismatch", event.global_seq));
        }
        let body = json!({
            "aggregate_id": event.aggregate_id,
            "aggregate_type": event.aggregate_type,
            "causation_id": event.causation_id,
            "command_id": event.command_id,
            "correlation_id": event.correlation_id,
            "event_id": event.event_id,
            "event_type": event.event_type,
            "occurred_at": event.occurred_at,
            "payload": event.payload,
            "version": event.version,
        });
        let expected = event_hash(&event.prev_hash, &body);
        if expected != event.event_hash {
            errors.push(format!("seq {}: event_hash mismatch", event.global_seq));
        }
        prev = event.event_hash.clone();
    }
    let truncated = errors.len() > 50;
    errors.truncate(50);
    Ok(json!({
        "ok": errors.is_empty(),
        "events": events.len(),
        "head": if events.is_empty() { GENESIS_HASH.to_string() } else { prev },
        "errors": errors,
        "truncated": truncated,
    }))
}

fn is_hash64_any_case(s: &str) -> bool {
    s.len() == 64
}

pub fn referenced_hashes(store: &EventStore) -> Res<BTreeSet<String>> {
    let mut hashes = BTreeSet::new();
    for event in store.load_all()? {
        let payload = &event.payload;
        for key in ["blobHash", "thumbHash", "previewHash"] {
            if let Some(v) = payload.get(key).and_then(|v| v.as_str()) {
                if is_hash64_any_case(v) {
                    hashes.insert(v.to_lowercase());
                }
            }
        }
        if let Some(items) = payload.get("items").and_then(|v| v.as_array()) {
            for item in items {
                for key in ["blobHash", "thumbHash"] {
                    if let Some(v) = item.get(key).and_then(|v| v.as_str()) {
                        if is_hash64_any_case(v) {
                            hashes.insert(v.to_lowercase());
                        }
                    }
                }
            }
        }
    }
    Ok(hashes)
}