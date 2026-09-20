from __future__ import annotations

import hashlib
import json
from pathlib import Path

from kernel.blobs import BlobStore
from kernel.bus import Projector, referenced_hashes, verify_chain
from kernel.store import EventStore, PROJECTION_TABLES


def rebuild_projections(store: EventStore, projectors: list[Projector]) -> int:
    store.clear_projections()
    events = store.load_all()
    with store.connect() as conn:
        for event in events:
            for projector in projectors:
                projector.handle(event, conn)
        conn.commit()
    return len(events)


def projection_checksum(store: EventStore) -> str:
    hasher = hashlib.sha256()
    with store.connect() as conn:
        for table in PROJECTION_TABLES:
            if table == "snapshots":
                continue
            rows = conn.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
            for row in rows:
                hasher.update(json.dumps(dict(row), ensure_ascii=False, sort_keys=True, default=str).encode())
    return hasher.hexdigest()


def verify_all(store: EventStore, blobs: BlobStore, projectors: list[Projector]) -> dict:
    chain = verify_chain(store)
    blob_errors: list[str] = []
    missing: list[str] = []
    needed = referenced_hashes(store)
    for digest in sorted(needed):
        if digest == hashlib.sha256(b"").hexdigest():
            continue
        if not blobs.exists(digest):
            missing.append(digest)
        elif not blobs.verify(digest):
            blob_errors.append(digest)
    before = projection_checksum(store)
    rebuild_projections(store, projectors)
    after = projection_checksum(store)
    return {
        "ok": chain["ok"] and not missing and not blob_errors and before == after,
        "chain": chain,
        "blobs": {
            "referenced": len(needed),
            "missing": missing[:50],
            "mismatch": blob_errors[:50],
        },
        "projections": {
            "checksumBefore": before,
            "checksumAfter": after,
            "match": before == after,
        },
    }


def backup_hint(data_dir: Path) -> dict:
    return {
        "copy": [str(data_dir / "events.sqlite"), str(data_dir / "blobs")],
        "note": "先停止写入或 WAL checkpoint，再复制 events.sqlite 与 blobs/。Token 在 secrets/，不要打进事件备份以外的公开包。",
    }
