from __future__ import annotations

import json
import sqlite3

from kernel.bus import Projector
from kernel.events import StoredEvent


class GenerationProjector(Projector):
    def handle(self, event: StoredEvent, conn: sqlite3.Connection) -> None:
        p = event.payload
        t = event.event_type
        if t == "ParamSetSaved":
            conn.execute(
                """
                INSERT INTO projections_param_sets
                    (id, name, form_json, created_at, updated_at, deleted, version)
                VALUES (?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name, form_json=excluded.form_json,
                    created_at=excluded.created_at, updated_at=excluded.updated_at,
                    deleted=0, version=excluded.version
                """,
                (
                    event.aggregate_id,
                    p["name"],
                    json.dumps(p.get("form") or {}, ensure_ascii=False),
                    p["createdAt"],
                    p["createdAt"],
                    event.version,
                ),
            )
        elif t == "ParamSetUpdated":
            conn.execute(
                "UPDATE projections_param_sets SET form_json=?, updated_at=?, version=? WHERE id=?",
                (
                    json.dumps(p.get("form") or {}, ensure_ascii=False),
                    p.get("updatedAt") or 0,
                    event.version,
                    event.aggregate_id,
                ),
            )
        elif t == "ParamSetDeleted":
            conn.execute(
                "UPDATE projections_param_sets SET deleted=1, version=? WHERE id=?",
                (event.version, event.aggregate_id),
            )
        elif t == "ParamSetRestored":
            conn.execute(
                "UPDATE projections_param_sets SET deleted=0, version=? WHERE id=?",
                (event.version, event.aggregate_id),
            )
        elif t == "JobQueued":
            conn.execute(
                """
                INSERT INTO projections_jobs (
                    id, source, status, progress_json, items_json, meta_json, error,
                    subscription_json, client_json, preview_hash, created_at, started_at,
                    finished_at, version
                ) VALUES (?, ?, 'queued', ?, '[]', '{}', NULL, NULL, ?, NULL, ?, NULL, NULL, ?)
                ON CONFLICT(id) DO UPDATE SET
                    source=excluded.source, status='queued', progress_json=excluded.progress_json,
                    client_json=excluded.client_json, created_at=excluded.created_at, version=excluded.version
                """,
                (
                    event.aggregate_id,
                    p.get("source") or "studio",
                    json.dumps(p.get("progress") or {}, ensure_ascii=False),
                    json.dumps(p.get("client") or {}, ensure_ascii=False),
                    p.get("createdAt") or 0,
                    event.version,
                ),
            )
        elif t == "JobStarted":
            conn.execute(
                "UPDATE projections_jobs SET status='running', started_at=?, version=? WHERE id=?",
                (p["startedAt"], event.version, event.aggregate_id),
            )
        elif t == "JobPreviewed":
            row = conn.execute(
                "SELECT progress_json FROM projections_jobs WHERE id=?", (event.aggregate_id,)
            ).fetchone()
            progress = json.loads(row["progress_json"] or "{}") if row else {}
            progress.update(
                {"step": p.get("step"), "sample": p.get("sample"), "text": p.get("text") or "生成中"}
            )
            conn.execute(
                "UPDATE projections_jobs SET progress_json=?, preview_hash=?, version=? WHERE id=?",
                (
                    json.dumps(progress, ensure_ascii=False),
                    p.get("previewHash"),
                    event.version,
                    event.aggregate_id,
                ),
            )
        elif t == "JobCompleted":
            conn.execute(
                """
                UPDATE projections_jobs SET status='done', items_json=?, meta_json=?,
                    subscription_json=?, finished_at=?, error=NULL, version=?,
                    progress_json=?
                WHERE id=?
                """,
                (
                    json.dumps(p.get("items") or [], ensure_ascii=False),
                    json.dumps(p.get("meta") or {}, ensure_ascii=False),
                    json.dumps(p.get("subscription"), ensure_ascii=False) if p.get("subscription") is not None else None,
                    p["finishedAt"],
                    event.version,
                    json.dumps({"text": "完成"}, ensure_ascii=False),
                    event.aggregate_id,
                ),
            )
        elif t == "JobFailed":
            conn.execute(
                "UPDATE projections_jobs SET status='error', error=?, finished_at=?, version=? WHERE id=?",
                (p.get("error"), p["finishedAt"], event.version, event.aggregate_id),
            )
        elif t == "JobCancelled":
            conn.execute(
                "UPDATE projections_jobs SET status='cancelled', error='已取消', finished_at=?, version=? WHERE id=?",
                (p["finishedAt"], event.version, event.aggregate_id),
            )
