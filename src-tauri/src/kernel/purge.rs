//! 彻底清除：真的删掉事件（而不是再追加一条「删除事件」），然后重算哈希链。
//!
//! 一次清除在一个事务里完成：
//! 1. 删掉要清除的聚合的全部事件和快照，删掉单独指定的事件，改写部分删除的事件载荷；
//! 2. 被删掉部分事件的聚合，把版本号重新排成 1..n；
//! 3. 从第一条改动过的事件起重算 `prev_hash` / `event_hash`（哈希体里没有 global_seq，序号留空没关系）；
//! 4. 清除的聚合直接删投影行；部分改动的聚合删掉投影行后用剩下的事件重放；
//! 5. 提交后再删已经没人引用的图片文件。中途失败最多留下孤儿文件，不会出现记录指向不存在的图。

use super::blobs::Slot;
use super::bus::{Kernel, Projector};
use super::errors::Res;
use super::events::StoredEvent;
use super::hashes::{sha256_text, GENESIS_HASH};
use super::refs;
use super::store::{row_to_event, AGGREGATE_TABLES};
use crate::pyjson::canonical_json;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default, Clone)]
pub struct Purge {
    /// 整个清除的聚合。
    pub aggregates: BTreeSet<String>,
    /// 单独删掉的事件（global_seq）。
    pub events: BTreeSet<i64>,
    /// 改写载荷的事件：global_seq → 新载荷。
    pub rewrites: BTreeMap<i64, Value>,
}

impl Purge {
    pub fn is_empty(&self) -> bool {
        self.aggregates.is_empty() && self.events.is_empty() && self.rewrites.is_empty()
    }

    pub fn drop_aggregate(&mut self, id: &str) {
        self.aggregates.insert(id.to_string());
    }

    pub fn merge(&mut self, other: Purge) {
        self.aggregates.extend(other.aggregates);
        self.events.extend(other.events);
        self.rewrites.extend(other.rewrites);
    }
}

#[derive(Debug, Default, Clone)]
pub struct PurgeStats {
    /// 实际清除的聚合：(id, 聚合类型)。
    pub aggregates: Vec<(String, String)>,
    pub events: usize,
    pub rewritten: usize,
    pub rehashed: usize,
    pub files: usize,
    pub bytes: u64,
}

pub type PurgeHook = Box<dyn Fn(&PurgeStats) + Send + Sync>;

fn lower(start: &mut Option<i64>, seq: i64) {
    *start = Some(start.map_or(seq, |s| s.min(seq)));
}

fn aggregate_of(tx: &Connection, seq: i64) -> Res<Option<String>> {
    Ok(tx.query_row("SELECT aggregate_id FROM events WHERE global_seq=?1", [seq], |r| r.get(0)).optional()?)
}

/// 只动 `events` 表：删除、改写、重排版本号、重算哈希链。返回部分改动的聚合和统计。
pub(crate) fn rewrite_events(tx: &Connection, plan: &Purge) -> Res<(BTreeSet<String>, PurgeStats)> {
    let mut stats = PurgeStats::default();
    let mut start: Option<i64> = None;
    let mut partial: BTreeSet<String> = BTreeSet::new();
    let mut thinned: BTreeSet<String> = BTreeSet::new();
    for seq in &plan.events {
        if let Some(a) = aggregate_of(tx, *seq)?.filter(|a| !plan.aggregates.contains(a)) {
            partial.insert(a.clone());
            thinned.insert(a);
        }
    }
    for seq in plan.rewrites.keys() {
        if let Some(a) = aggregate_of(tx, *seq)?.filter(|a| !plan.aggregates.contains(a)) {
            partial.insert(a);
        }
    }

    {
        let mut first = tx.prepare("SELECT MIN(global_seq), MAX(aggregate_type) FROM events WHERE aggregate_id=?1")?;
        let mut del = tx.prepare("DELETE FROM events WHERE aggregate_id=?1")?;
        let mut snap = tx.prepare("DELETE FROM snapshots WHERE aggregate_id=?1")?;
        for id in &plan.aggregates {
            let (min, kind): (Option<i64>, Option<String>) = first.query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            if let Some(m) = min {
                lower(&mut start, m);
            }
            stats.events += del.execute([id])?;
            snap.execute([id])?;
            stats.aggregates.push((id.clone(), kind.unwrap_or_default()));
        }
    }
    {
        let mut del = tx.prepare("DELETE FROM events WHERE global_seq=?1")?;
        for seq in &plan.events {
            if del.execute([seq])? > 0 {
                stats.events += 1;
                lower(&mut start, *seq);
            }
        }
    }
    {
        let mut up = tx.prepare("UPDATE events SET payload_json=?1 WHERE global_seq=?2")?;
        for (seq, payload) in &plan.rewrites {
            if up.execute(params![canonical_json(payload), seq])? > 0 {
                stats.rewritten += 1;
                lower(&mut start, *seq);
            }
        }
    }
    for id in &partial {
        tx.execute("DELETE FROM snapshots WHERE aggregate_id=?1", [id])?;
    }
    for id in &thinned {
        renumber(tx, id, &mut start)?;
    }
    if let Some(s) = start {
        stats.rehashed = rehash_from(tx, s)?;
    }
    Ok((partial, stats))
}

/// 版本号重新排成 1..n。按原顺序从小往大改，不会撞上 (aggregate_id, version) 唯一约束。
fn renumber(tx: &Connection, aggregate_id: &str, start: &mut Option<i64>) -> Res<()> {
    let rows: Vec<(i64, i64)> = tx
        .prepare("SELECT global_seq, version FROM events WHERE aggregate_id=?1 ORDER BY version")?
        .query_map([aggregate_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut up = tx.prepare("UPDATE events SET version=?1 WHERE global_seq=?2")?;
    for (i, (seq, version)) in rows.iter().enumerate() {
        let want = i as i64 + 1;
        if *version != want {
            up.execute(params![want, seq])?;
            lower(start, *seq);
        }
    }
    Ok(())
}

/// 参与哈希的字段，和 `NewEvent::hash_body` / `verify_chain` 一致。
fn hash_body(e: &StoredEvent) -> Value {
    json!({
        "aggregate_id": e.aggregate_id,
        "aggregate_type": e.aggregate_type,
        "causation_id": e.causation_id,
        "command_id": e.command_id,
        "correlation_id": e.correlation_id,
        "event_id": e.event_id,
        "event_type": e.event_type,
        "occurred_at": e.occurred_at,
        "payload": e.payload,
        "version": e.version,
    })
}

/// 不解析载荷，直接把库里存的 JSON 拼进哈希正文。载荷本身是规范 JSON 时，结果和 `hash_body` 序列化出来的一样。
fn spliced_body(row: &Row) -> Res<String> {
    let payload: String = row.get("payload_json")?;
    let head = json!({
        "aggregate_id": row.get::<_, String>("aggregate_id")?,
        "aggregate_type": row.get::<_, String>("aggregate_type")?,
        "causation_id": row.get::<_, Option<String>>("causation_id")?,
        "command_id": row.get::<_, Option<String>>("command_id")?,
        "correlation_id": row.get::<_, Option<String>>("correlation_id")?,
        "event_id": row.get::<_, String>("event_id")?,
        "event_type": row.get::<_, String>("event_type")?,
        "occurred_at": row.get::<_, i64>("occurred_at")?,
        "payload": Value::Null,
        "version": row.get::<_, i64>("version")?,
    });
    // 前面几个字段的字符串里出现的引号都被转义了，第一个 `"payload":null` 一定是键本身。
    let payload = if payload.is_empty() { "{}" } else { payload.as_str() };
    Ok(canonical_json(&head).replacen("\"payload\":null", &format!("\"payload\":{payload}"), 1))
}

/// 从 `start` 起重算哈希链，返回改动的事件数。
///
/// 每条事件先用拼接正文验一下旧哈希：对得上说明载荷是规范 JSON，可以直接用拼接正文算新哈希；
/// 对不上（刚改写过、版本号改了、或旧链本来就有问题）就解析载荷重新序列化。
pub(crate) fn rehash_from(tx: &Connection, start: i64) -> Res<usize> {
    let mut prev: String = tx
        .query_row("SELECT event_hash FROM events WHERE global_seq < ?1 ORDER BY global_seq DESC LIMIT 1", [start], |r| {
            r.get(0)
        })
        .optional()?
        .unwrap_or_else(|| GENESIS_HASH.to_string());
    let mut updates: Vec<(i64, String, String)> = Vec::new();
    {
        let mut stmt = tx.prepare("SELECT * FROM events WHERE global_seq >= ?1 ORDER BY global_seq")?;
        let mut rows = stmt.query([start])?;
        while let Some(row) = rows.next()? {
            let seq: i64 = row.get("global_seq")?;
            let old_prev: String = row.get("prev_hash")?;
            let old_hash: String = row.get("event_hash")?;
            let mut body = spliced_body(row)?;
            if sha256_text(&format!("{old_prev}{body}")) != old_hash {
                body = canonical_json(&hash_body(&row_to_event(row)?));
            }
            let digest = sha256_text(&format!("{prev}{body}"));
            if digest != old_hash || prev != old_prev {
                updates.push((seq, prev.clone(), digest.clone()));
            }
            prev = digest;
        }
    }
    let mut up = tx.prepare("UPDATE events SET prev_hash=?1, event_hash=?2 WHERE global_seq=?3")?;
    for (seq, p, h) in &updates {
        up.execute(params![p, h, seq])?;
    }
    Ok(updates.len())
}

fn load_stream(tx: &Connection, aggregate_id: &str) -> Res<Vec<StoredEvent>> {
    let mut stmt = tx.prepare("SELECT * FROM events WHERE aggregate_id=?1 ORDER BY version")?;
    let rows = stmt.query_map([aggregate_id], |r| Ok(row_to_event(r)))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r??);
    }
    Ok(out)
}

/// 清除的聚合删投影行；部分改动的聚合删掉后用剩下的事件重放。
fn reproject(
    tx: &Connection,
    projectors: &[Box<dyn Projector>],
    dropped: &BTreeSet<String>,
    partial: &BTreeSet<String>,
) -> Res<()> {
    let mut deletes: Vec<_> = AGGREGATE_TABLES
        .iter()
        .map(|t| tx.prepare(&format!("DELETE FROM {t} WHERE id=?1")))
        .collect::<Result<_, _>>()?;
    let mut refs_del = tx.prepare("DELETE FROM projections_blob_refs WHERE owner=?1")?;
    for id in dropped.iter().chain(partial.iter()) {
        for stmt in deletes.iter_mut() {
            stmt.execute([id])?;
        }
        refs_del.execute([id])?;
    }
    for id in partial {
        for event in load_stream(tx, id)? {
            for p in projectors {
                p.handle(&event, tx)?;
            }
        }
    }
    Ok(())
}

impl Kernel {
    pub fn purge(&self, plan: &Purge) -> Res<PurgeStats> {
        self.purge_with(plan, &mut |_| Ok(()))
    }

    /// 和 [`purge`] 一样改事件，但不删文件。整理存储时文件要等引用表重算完再统一处理。
    pub fn purge_keep_files(&self, plan: &Purge) -> Res<PurgeStats> {
        self.purge_inner(plan, &mut |_| Ok(()), false)
    }

    /// `fixup` 在投影重放之后、提交之前调用，用来补跨聚合的投影（例如抽奖批次上挂的预览图）。
    pub fn purge_with(&self, plan: &Purge, fixup: &mut dyn FnMut(&Connection) -> Res<()>) -> Res<PurgeStats> {
        self.purge_inner(plan, fixup, true)
    }

    fn purge_inner(
        &self,
        plan: &Purge,
        fixup: &mut dyn FnMut(&Connection) -> Res<()>,
        release: bool,
    ) -> Res<PurgeStats> {
        if plan.is_empty() {
            return Ok(PurgeStats::default());
        }
        let (mut stats, released) = self.store.with_write_lock(|| -> Res<(PurgeStats, Vec<(String, Slot)>)> {
            let mut conn = self.store.connect()?;
            let tx = conn.transaction()?;
            let mut owners: BTreeSet<String> = plan.aggregates.clone();
            for seq in plan.events.iter().chain(plan.rewrites.keys()) {
                if let Some(a) = aggregate_of(&tx, *seq)? {
                    owners.insert(a);
                }
            }
            let before = refs::files_of(&tx, &owners)?;
            let (partial, stats) = rewrite_events(&tx, plan)?;
            reproject(&tx, &self.projectors, &plan.aggregates, &partial)?;
            fixup(&tx)?;
            let mut released = Vec::new();
            for (hash, slot) in before {
                if !refs::is_referenced(&tx, &hash, &slot)? {
                    released.push((hash, slot));
                }
            }
            tx.commit()?;
            Ok((stats, released))
        })?;
        if release {
            let (files, bytes) = self.release_files(&released)?;
            stats.files = files;
            stats.bytes = bytes;
        }
        for hook in self.purge_hooks.read().unwrap_or_else(|e| e.into_inner()).iter() {
            hook(&stats);
        }
        Ok(stats)
    }

    /// 删掉已经没人用的文件：只删对应位置上的那份；这张图哪里都没人用了，旧目录里的也一起删。
    pub fn release_files(&self, files: &[(String, Slot)]) -> Res<(usize, u64)> {
        if files.is_empty() {
            return Ok((0, 0));
        }
        let conn = self.store.connect()?;
        let (mut n, mut bytes) = (0usize, 0u64);
        let mut hashes = BTreeSet::new();
        for (hash, slot) in files {
            if refs::is_referenced(&conn, hash, slot)? {
                continue;
            }
            let b = self.blobs.remove(slot, hash);
            if b > 0 {
                n += 1;
                bytes += b;
            }
            hashes.insert(hash.clone());
        }
        for hash in hashes {
            let drop_legacy = if !refs::is_used(&conn, &hash)? {
                true
            } else {
                let slots = refs::slots_of(&conn, &hash)?;
                !slots.is_empty() && slots.iter().all(|slot| self.blobs.has(slot, &hash))
            };
            if drop_legacy {
                let b = self.blobs.remove_legacy(&hash);
                if b > 0 {
                    n += 1;
                    bytes += b;
                }
            }
        }
        Ok((n, bytes))
    }

    pub fn on_purge(&self, hook: PurgeHook) {
        self.purge_hooks.write().unwrap_or_else(|e| e.into_inner()).push(hook);
    }
}

/// 一个聚合的事件，按版本顺序。只带清除时要用的字段。
pub struct StreamEvent {
    pub seq: i64,
    pub event_type: String,
    pub payload: Value,
}

pub fn stream_events(conn: &Connection, aggregate_id: &str) -> Res<Vec<StreamEvent>> {
    let mut stmt = conn.prepare(
        "SELECT global_seq, event_type, payload_json FROM events WHERE aggregate_id=?1 ORDER BY version",
    )?;
    let rows = stmt.query_map(params![aggregate_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (seq, event_type, payload_json) = row?;
        let payload = serde_json::from_str(if payload_json.is_empty() { "{}" } else { &payload_json }).unwrap_or(Value::Null);
        out.push(StreamEvent { seq, event_type, payload });
    }
    Ok(out)
}

/// 把任务结果改成 `keep`。空列表表示整个任务清除；否则改写完成事件，并删掉「从历史移除」事件。
pub fn plan_job_items(conn: &Connection, job_id: &str, keep: &[Value], plan: &mut Purge) -> Res<()> {
    if keep.is_empty() {
        plan.drop_aggregate(job_id);
        return Ok(());
    }
    let rows = stream_events(conn, job_id)?;
    let mut saw = false;
    for row in &rows {
        match row.event_type.as_str() {
            "JobItemsRemoved" => {
                plan.events.insert(row.seq);
            }
            "JobCompleted" => {
                let mut payload = row.payload.clone();
                payload["items"] = Value::Array(keep.to_vec());
                plan.rewrites.insert(row.seq, payload);
                saw = true;
            }
            _ => {}
        }
    }
    if !saw {
        plan.drop_aggregate(job_id);
    }
    Ok(())
}
