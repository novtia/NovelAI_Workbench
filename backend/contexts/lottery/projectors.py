from __future__ import annotations

import json
import sqlite3

from contexts.lottery.domain import attach_job_previews
from kernel.bus import Projector
from kernel.events import StoredEvent


class LotteryProjector(Projector):
    def handle(self, event: StoredEvent, conn: sqlite3.Connection) -> None:
        p = event.payload
        t = event.event_type
        if t == "BoardConfigured":
            conn.execute(
                """
                INSERT INTO projections_lottery_board
                    (id, album_id, excluded_json, pinned_json, weight_caps_json, controls_json, version)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    album_id=excluded.album_id, excluded_json=excluded.excluded_json,
                    pinned_json=excluded.pinned_json, weight_caps_json=excluded.weight_caps_json,
                    controls_json=excluded.controls_json, version=excluded.version
                """,
                (
                    event.aggregate_id,
                    p.get("albumId"),
                    json.dumps(p.get("excluded") or [], ensure_ascii=False),
                    json.dumps(p.get("pinned") or [], ensure_ascii=False),
                    json.dumps(p.get("weightCaps") or {}, ensure_ascii=False),
                    json.dumps(p.get("controls") or {}, ensure_ascii=False),
                    event.version,
                ),
            )
        elif t == "DrawBatchCreated":
            conn.execute(
                """
                INSERT INTO projections_lottery_batches
                    (id, album_id, seed, pool_revision, pool_hash, params_json, draws_json,
                     created_at, deleted, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(id) DO UPDATE SET
                    album_id=excluded.album_id, seed=excluded.seed, pool_revision=excluded.pool_revision,
                    pool_hash=excluded.pool_hash, params_json=excluded.params_json,
                    draws_json=excluded.draws_json, created_at=excluded.created_at,
                    deleted=0, version=excluded.version
                """,
                (
                    event.aggregate_id,
                    p["albumId"],
                    p["seed"],
                    p.get("poolRevision") or 0,
                    p["poolHash"],
                    json.dumps(p.get("params") or {}, ensure_ascii=False),
                    json.dumps(p.get("draws") or [], ensure_ascii=False),
                    p.get("createdAt") or 0,
                    event.version,
                ),
            )
        elif t == "DrawRemoved":
            row = conn.execute(
                "SELECT draws_json FROM projections_lottery_batches WHERE id=?",
                (event.aggregate_id,),
            ).fetchone()
            if not row:
                return
            draws = json.loads(row["draws_json"] or "[]")
            did = str(p.get("id") or "").strip()
            removed = False
            if did:
                kept = [d for d in draws if str((d or {}).get("id") or "") != did]
                if len(kept) != len(draws):
                    draws = kept
                    removed = True
            if not removed:
                idx = int(p["index"])
                if 0 <= idx < len(draws):
                    draws.pop(idx)
            conn.execute(
                "UPDATE projections_lottery_batches SET draws_json=?, version=? WHERE id=?",
                (json.dumps(draws, ensure_ascii=False), event.version, event.aggregate_id),
            )
        elif t == "DrawBatchDeleted":
            conn.execute(
                "UPDATE projections_lottery_batches SET deleted=1, version=? WHERE id=?",
                (event.version, event.aggregate_id),
            )
        elif t == "DrawBatchRestored":
            conn.execute(
                "UPDATE projections_lottery_batches SET deleted=0, version=? WHERE id=?",
                (event.version, event.aggregate_id),
            )
        elif t == "JobCompleted":
            job = conn.execute(
                "SELECT source, client_json FROM projections_jobs WHERE id=?",
                (event.aggregate_id,),
            ).fetchone()
            if not job or str(job["source"] or "") != "lottery":
                return
            client = json.loads(job["client_json"] or "{}")
            if not isinstance(client, dict):
                return
            batch_id = str(client.get("batchId") or "").strip()
            if not batch_id:
                return
            row = conn.execute(
                "SELECT draws_json FROM projections_lottery_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if not row:
                return
            draws = json.loads(row["draws_json"] or "[]")
            if not isinstance(draws, list):
                return
            if attach_job_previews(draws, batch_id, event.aggregate_id, client, p.get("items") or []):
                conn.execute(
                    "UPDATE projections_lottery_batches SET draws_json=? WHERE id=?",
                    (json.dumps(draws, ensure_ascii=False), batch_id),
                )
