from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any, Callable

from kernel.events import NewEvent, StoredEvent
from kernel.hashes import GENESIS_HASH, canonical_json, event_hash

SCHEMA = """
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

CREATE TABLE IF NOT EXISTS projections_identity (
    id TEXT PRIMARY KEY,
    configured INTEGER NOT NULL DEFAULT 0,
    hint TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projections_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

PROJECTION_TABLES = (
    "projections_albums",
    "projections_artworks",
    "projections_jobs",
    "projections_param_sets",
    "projections_lottery_batches",
    "projections_lottery_board",
    "projections_identity",
    "projections_meta",
    "snapshots",
)


class EventStore:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._lock = threading.RLock()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA foreign_keys = ON")

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA cache_size = -20000")
        conn.execute("PRAGMA mmap_size = 67108864")
        return conn

    def latest_hash(self, conn: sqlite3.Connection | None = None) -> str:
        own = conn is None
        if own:
            conn = self.connect()
        try:
            row = conn.execute(
                "SELECT event_hash FROM events ORDER BY global_seq DESC LIMIT 1"
            ).fetchone()
            return row["event_hash"] if row else GENESIS_HASH
        finally:
            if own:
                conn.close()

    def events_for_command(self, command_id: str) -> list[StoredEvent]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM events WHERE command_id = ? ORDER BY global_seq",
                (command_id,),
            ).fetchall()
        return [self._row(r) for r in rows]

    def load_stream(self, aggregate_id: str) -> list[StoredEvent]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM events WHERE aggregate_id = ? ORDER BY version",
                (aggregate_id,),
            ).fetchall()
        return [self._row(r) for r in rows]

    def has_events(self) -> bool:
        with self.connect() as conn:
            return conn.execute("SELECT 1 FROM events LIMIT 1").fetchone() is not None

    def load_after(self, after: int, limit: int = 500) -> list[StoredEvent]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM events WHERE global_seq > ? ORDER BY global_seq LIMIT ?",
                (after, limit),
            ).fetchall()
        return [self._row(r) for r in rows]

    def load_all(self) -> list[StoredEvent]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM events ORDER BY global_seq").fetchall()
        return [self._row(r) for r in rows]

    def append(
        self,
        events: list[NewEvent],
        *,
        command_id: str | None = None,
        after: Callable[[list[StoredEvent], sqlite3.Connection], None] | None = None,
    ) -> list[StoredEvent]:
        if not events:
            return []
        if command_id:
            existing = self.events_for_command(command_id)
            if existing:
                return existing
        stored: list[StoredEvent] = []
        with self._lock, self.connect() as conn:
            prev = self.latest_hash(conn)
            for event in events:
                event.command_id = command_id or event.command_id
                body = event.hash_body()
                digest = event_hash(prev, body)
                conn.execute(
                    """
                    INSERT INTO events (
                        event_id, aggregate_id, aggregate_type, version, event_type,
                        payload_json, occurred_at, causation_id, correlation_id,
                        command_id, prev_hash, event_hash
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event.event_id,
                        event.aggregate_id,
                        event.aggregate_type,
                        event.version,
                        event.event_type,
                        canonical_json(event.payload),
                        event.occurred_at,
                        event.causation_id,
                        event.correlation_id,
                        event.command_id,
                        prev,
                        digest,
                    ),
                )
                row = conn.execute(
                    "SELECT * FROM events WHERE event_id = ?", (event.event_id,)
                ).fetchone()
                item = self._row(row)
                stored.append(item)
                prev = digest
            if after:
                after(stored, conn)
            conn.commit()
        return stored

    def clear_projections(self) -> None:
        with self._lock, self.connect() as conn:
            for table in PROJECTION_TABLES:
                conn.execute(f"DELETE FROM {table}")
            conn.commit()

    def _row(self, row: sqlite3.Row) -> StoredEvent:
        import json

        return StoredEvent(
            global_seq=row["global_seq"],
            event_id=row["event_id"],
            aggregate_id=row["aggregate_id"],
            aggregate_type=row["aggregate_type"],
            version=row["version"],
            event_type=row["event_type"],
            payload=json.loads(row["payload_json"] or "{}"),
            occurred_at=row["occurred_at"],
            causation_id=row["causation_id"],
            correlation_id=row["correlation_id"],
            command_id=row["command_id"],
            prev_hash=row["prev_hash"],
            event_hash=row["event_hash"],
        )
