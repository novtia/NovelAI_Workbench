use super::errors::Res;
use super::events::{NewEvent, StoredEvent};
use super::hashes::{event_hash, GENESIS_HASH};
use crate::pyjson::canonical_json;
use rusqlite::{params, Connection, Row};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS events (
    global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    aggregate_id TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    version INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    causation_id TEXT,
    correlation_id TEXT,
    command_id TEXT,
    prev_hash TEXT NOT NULL,
    event_hash TEXT NOT NULL,
    UNIQUE (aggregate_id, version)
);
CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_id, version);
CREATE INDEX IF NOT EXISTS idx_events_command ON events(command_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

CREATE TABLE IF NOT EXISTS snapshots (
    aggregate_id TEXT PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    version INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projections_albums (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS projections_artworks (
    id TEXT PRIMARY KEY,
    album_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    name TEXT NOT NULL,
    mime TEXT,
    size INTEGER,
    hash TEXT NOT NULL,
    thumb_hash TEXT,
    width INTEGER,
    height INTEGER,
    artists TEXT,
    artist_line TEXT,
    params TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_artworks_album ON projections_artworks(album_id, deleted, added_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artworks_album_hash
    ON projections_artworks(album_id, hash) WHERE deleted = 0;

CREATE TABLE IF NOT EXISTS projections_jobs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    progress_json TEXT,
    items_json TEXT,
    meta_json TEXT,
    error TEXT,
    subscription_json TEXT,
    client_json TEXT,
    preview_hash TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON projections_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_source_status ON projections_jobs(source, status);

CREATE TABLE IF NOT EXISTS projections_param_sets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    form_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projections_lottery_batches (
    id TEXT PRIMARY KEY,
    album_id TEXT NOT NULL,
    seed INTEGER NOT NULL,
    pool_revision INTEGER NOT NULL,
    pool_hash TEXT NOT NULL,
    params_json TEXT NOT NULL,
    draws_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lottery_batches_live ON projections_lottery_batches(deleted, created_at);
CREATE INDEX IF NOT EXISTS idx_param_sets_deleted ON projections_param_sets(deleted);

CREATE TABLE IF NOT EXISTS projections_lottery_board (
    id TEXT PRIMARY KEY,
    album_id TEXT,
    excluded_json TEXT NOT NULL,
    pinned_json TEXT NOT NULL,
    weight_caps_json TEXT NOT NULL,
    controls_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projections_gallery_view (
    id TEXT PRIMARY KEY,
    album_id TEXT NOT NULL DEFAULT '',
    test_set_id TEXT NOT NULL DEFAULT '',
    preset_id TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projections_artist_basket (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projections_identity (
    id TEXT PRIMARY KEY,
    configured INTEGER NOT NULL DEFAULT 0,
    hint TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projections_settings (
    id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projections_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

pub const PROJECTION_TABLES: [&str; 11] = [
    "projections_albums",
    "projections_artworks",
    "projections_jobs",
    "projections_param_sets",
    "projections_lottery_batches",
    "projections_lottery_board",
    "projections_gallery_view",
    "projections_artist_basket",
    "projections_identity",
    "projections_settings",
    "projections_meta",
];

pub struct EventStore {
    pub db_path: PathBuf,
    write_lock: Mutex<()>,
}

pub fn open_connection(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.busy_timeout(Duration::from_secs(30))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -20000; PRAGMA mmap_size = 67108864;",
    )?;
    Ok(conn)
}

impl EventStore {
    pub fn open(db_path: &Path) -> Res<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = open_connection(db_path)?;
        conn.execute_batch(SCHEMA)?;
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        Ok(EventStore { db_path: db_path.to_path_buf(), write_lock: Mutex::new(()) })
    }

    pub fn connect(&self) -> Res<Connection> {
        Ok(open_connection(&self.db_path)?)
    }

    pub fn latest_hash(conn: &Connection) -> Res<String> {
        let row: Option<String> = conn
            .query_row("SELECT event_hash FROM events ORDER BY global_seq DESC LIMIT 1", [], |r| r.get(0))
            .ok();
        Ok(row.unwrap_or_else(|| GENESIS_HASH.to_string()))
    }

    pub fn events_for_command(&self, command_id: &str) -> Res<Vec<StoredEvent>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare("SELECT * FROM events WHERE command_id = ?1 ORDER BY global_seq")?;
        let rows = stmt.query_map(params![command_id], |r| Ok(row_to_event(r)))?;
        collect_events(rows)
    }

    pub fn load_stream(&self, aggregate_id: &str) -> Res<Vec<StoredEvent>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare("SELECT * FROM events WHERE aggregate_id = ?1 ORDER BY version")?;
        let rows = stmt.query_map(params![aggregate_id], |r| Ok(row_to_event(r)))?;
        collect_events(rows)
    }

    pub fn has_events(&self) -> Res<bool> {
        let conn = self.connect()?;
        let found: Option<i64> = conn.query_row("SELECT 1 FROM events LIMIT 1", [], |r| r.get(0)).ok();
        Ok(found.is_some())
    }

    pub fn load_after(&self, after: i64, limit: i64) -> Res<Vec<StoredEvent>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare("SELECT * FROM events WHERE global_seq > ?1 ORDER BY global_seq LIMIT ?2")?;
        let rows = stmt.query_map(params![after, limit], |r| Ok(row_to_event(r)))?;
        collect_events(rows)
    }

    pub fn load_all(&self) -> Res<Vec<StoredEvent>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare("SELECT * FROM events ORDER BY global_seq")?;
        let rows = stmt.query_map([], |r| Ok(row_to_event(r)))?;
        collect_events(rows)
    }

    /// 追加事件并在同一个事务里执行 `after`（投影）。同一个 `command_id` 再次提交直接返回旧事件。
    pub fn append(
        &self,
        mut events: Vec<NewEvent>,
        command_id: Option<&str>,
        after: &mut dyn FnMut(&[StoredEvent], &Connection) -> Res<()>,
    ) -> Res<Vec<StoredEvent>> {
        if events.is_empty() {
            return Ok(vec![]);
        }
        if let Some(cid) = command_id {
            let existing = self.events_for_command(cid)?;
            if !existing.is_empty() {
                return Ok(existing);
            }
        }
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut conn = self.connect()?;
        let tx = conn.transaction()?;
        let mut prev = Self::latest_hash(&tx)?;
        let mut stored: Vec<StoredEvent> = Vec::with_capacity(events.len());
        for event in events.iter_mut() {
            if let Some(cid) = command_id {
                event.command_id = Some(cid.to_string());
            }
            let body = event.hash_body();
            let digest = event_hash(&prev, &body);
            tx.execute(
                "INSERT INTO events (
                    event_id, aggregate_id, aggregate_type, version, event_type,
                    payload_json, occurred_at, causation_id, correlation_id,
                    command_id, prev_hash, event_hash
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    event.event_id,
                    event.aggregate_id,
                    event.aggregate_type,
                    event.version,
                    event.event_type,
                    canonical_json(&event.payload),
                    event.occurred_at,
                    event.causation_id,
                    event.correlation_id,
                    event.command_id,
                    prev,
                    digest,
                ],
            )?;
            let item = tx.query_row("SELECT * FROM events WHERE event_id = ?1", params![event.event_id], |r| {
                Ok(row_to_event(r))
            })??;
            stored.push(item);
            prev = digest;
        }
        after(&stored, &tx)?;
        tx.commit()?;
        Ok(stored)
    }

    pub fn clear_projections(&self) -> Res<()> {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut conn = self.connect()?;
        let tx = conn.transaction()?;
        for table in PROJECTION_TABLES {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
        tx.execute("DELETE FROM snapshots", [])?;
        tx.commit()?;
        Ok(())
    }

    /// 重放投影时需要和普通写入互斥。
    pub fn with_write_lock<T>(&self, f: impl FnOnce() -> T) -> T {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        f()
    }
}

/// 把一行 `events` 解析成事件。payload 重新从落库的 JSON 解析，保证键顺序和数字类型与 Python 重放时一致。
pub fn row_to_event(row: &Row) -> Res<StoredEvent> {
    let payload_json: String = row.get("payload_json")?;
    let payload = serde_json::from_str(if payload_json.is_empty() { "{}" } else { &payload_json })?;
    Ok(StoredEvent {
        global_seq: row.get("global_seq")?,
        event_id: row.get("event_id")?,
        aggregate_id: row.get("aggregate_id")?,
        aggregate_type: row.get("aggregate_type")?,
        version: row.get("version")?,
        event_type: row.get("event_type")?,
        payload,
        occurred_at: row.get("occurred_at")?,
        causation_id: row.get("causation_id")?,
        correlation_id: row.get("correlation_id")?,
        command_id: row.get("command_id")?,
        prev_hash: row.get("prev_hash")?,
        event_hash: row.get("event_hash")?,
    })
}

fn collect_events(rows: impl Iterator<Item = rusqlite::Result<Res<StoredEvent>>>) -> Res<Vec<StoredEvent>> {
    let mut out = Vec::new();
    for r in rows {
        out.push(r??);
    }
    Ok(out)
}
