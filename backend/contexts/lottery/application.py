from __future__ import annotations

import json
import sqlite3
from random import Random
from typing import Any, Callable

from contexts.gallery.application import GalleryService
from contexts.lottery.algorithm import draw_from_pool, parse_entries, pool_hash, tag_key
from contexts.lottery.domain import BOARD_ID, DEFAULT_CONTROLS, DrawBatch, LotteryBoard, attach_job_previews, stamp_draw_ids
from kernel.bus import UnitOfWork
from kernel.clock import new_id, now_ms
from kernel.errors import DomainError
from kernel.store import EventStore


class LotteryService:
    def __init__(self, uow: UnitOfWork, store: EventStore, gallery: GalleryService):
        self.uow = uow
        self.store = store
        self.gallery = gallery
        # 「设置 → 抽奖」里的默认参数，由装配处注入；只影响还没保存过的抽奖台和缺失的字段。
        self.default_controls: Callable[[], dict[str, Any]] | None = None

    def _defaults(self) -> dict[str, Any]:
        out = dict(DEFAULT_CONTROLS)
        if self.default_controls:
            preferred = self.default_controls()
            out.update({k: v for k, v in preferred.items() if k in DEFAULT_CONTROLS})
        return out

    def board(self) -> dict[str, Any]:
        with self.store.connect() as conn:
            row = conn.execute(
                "SELECT * FROM projections_lottery_board WHERE id=?", (BOARD_ID,)
            ).fetchone()
        if not row:
            return {
                "id": BOARD_ID,
                "albumId": None,
                "excluded": [],
                "pinned": [],
                "weightCaps": {},
                "controls": self._defaults(),
                "version": 0,
            }
        return {
            "id": row["id"],
            "albumId": row["album_id"],
            "excluded": json.loads(row["excluded_json"] or "[]"),
            "pinned": json.loads(row["pinned_json"] or "[]"),
            "weightCaps": json.loads(row["weight_caps_json"] or "{}"),
            "controls": {**self._defaults(), **json.loads(row["controls_json"] or "{}")},
            "version": row["version"],
        }

    def configure(self, data: dict[str, Any]) -> dict[str, Any]:
        board = self.uow.load(LotteryBoard, BOARD_ID)
        board.configure(data)
        self.uow.commit(board)
        return self.board()

    def list_batches(self) -> list[dict[str, Any]]:
        with self.store.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM projections_lottery_batches WHERE deleted=0 ORDER BY created_at DESC"
            ).fetchall()
        batches = [self._batch_row(r) for r in rows]
        self._hydrate_draw_previews(batches)
        return batches

    def get_batch(self, batch_id: str, *, include_deleted: bool = False) -> dict[str, Any] | None:
        with self.store.connect() as conn:
            row = conn.execute(
                "SELECT * FROM projections_lottery_batches WHERE id=?", (batch_id,)
            ).fetchone()
        if not row:
            return None
        if row["deleted"] and not include_deleted:
            return None
        rec = self._batch_row(row)
        self._hydrate_draw_previews([rec])
        return rec

    def artist_pool(self, album_id: str, *, weighted: bool = True) -> list[dict[str, Any]]:
        if not weighted:
            return self.gallery.pool_for_album(album_id)
        items = self.gallery.list_items(album_id)
        seen: dict[str, dict[str, Any]] = {}
        for item in items:
            params = item.get("params") or {}
            text = ", ".join(
                x
                for x in (
                    str(params.get("artistChain") or ""),
                    str(item.get("artistLine") or ""),
                    str(params.get("prompt") or ""),
                )
                if x
            )
            weights: dict[str, float] = {}
            for entry in parse_entries(text):
                for tag in entry["tags"]:
                    key = tag_key(tag)
                    if key:
                        weights[key] = max(weights.get(key, 0), float(entry["weight"]))
            local: set[str] = set()
            for name in item.get("artists") or []:
                key = tag_key(str(name))
                if not key or key in local:
                    continue
                local.add(key)
                weight = weights.get(key) or 1
                rec = seen.get(key)
                if not rec:
                    seen[key] = {"tag": str(name), "name": str(name), "key": key, "weight": weight}
                else:
                    rec["weight"] = max(float(rec.get("weight") or 1), weight)
        return sorted(seen.values(), key=lambda p: str(p["name"]).lower())

    def _cap_item(self, src: dict[str, Any], caps: dict[str, Any] | None, key: str) -> dict[str, Any]:
        item = dict(src)
        if not isinstance(caps, dict):
            return item
        cap = caps.get(key)
        if cap is None:
            cap = caps.get(src.get("tag"))
        if cap is None:
            return item
        try:
            item["maxWeight"] = float(cap)
        except (TypeError, ValueError):
            pass
        return item

    def _prepare_pool(self, album_id: str, body: dict[str, Any], *, weighted: bool):
        pool = self.artist_pool(album_id, weighted=weighted)
        board = self.board()
        excluded = set(tag_key(x) for x in (body.get("excluded") or board["excluded"]))
        caps = body.get("weightCaps") or board["weightCaps"]
        pinned_keys = [tag_key(x) for x in (body.get("pinned") or board["pinned"])]
        active = []
        by_key = {}
        for p in pool:
            k = tag_key(p["tag"])
            by_key[k] = p
            item = self._cap_item(p, caps if isinstance(caps, dict) else None, k)
            if k not in excluded:
                active.append(item)
        fixed = []
        for k in pinned_keys:
            src = by_key.get(k)
            if src:
                fixed.append(self._cap_item(src, caps if isinstance(caps, dict) else None, k))
        return active, by_key, excluded, fixed, board, caps if isinstance(caps, dict) else {}

    def draw(self, album_id: str, body: dict[str, Any]) -> dict[str, Any]:
        active, _by_key, excluded, fixed, board, caps = self._prepare_pool(album_id, body, weighted=True)
        controls = {**board["controls"], **(body.get("controls") or {})}
        locked_n = len(fixed)
        rest_n = max(0, len(active) - locked_n)
        cap = locked_n + rest_n
        n_min = max(1, int(controls.get("min") or 1), locked_n)
        n_max = max(n_min, int(controls.get("max") or n_min), locked_n)
        n_min = min(n_min, cap) if cap else n_min
        n_max = min(max(n_max, n_min), cap) if cap else n_max
        if not active or n_min < 1 or n_max < 1:
            raise DomainError("画师池为空，无法抽奖")
        seed = int(body["seed"]) if body.get("seed") is not None else now_ms()
        rng = Random(seed)
        count = min(max(int(controls.get("draws") or 1), 1), 50)
        boost = controls.get("boost")
        base = {
            "target": float(controls.get("target") or 1),
            "boost": 0.4 if boost is None else float(boost),
            "jitter": float(controls.get("jitter") or 0),
            "minWeight": float(controls.get("wmin") or 0.01),
            "maxWeight": float(controls.get("wmax") or 1),
            "fixed": fixed,
        }
        ns: list[int] = []
        draws: list[dict[str, Any]] = []
        for _ in range(count):
            n = rng.randint(n_min, n_max)
            ns.append(n)
            draws.extend(draw_from_pool(active, {**base, "n": n, "count": 1}, rng))
        if not draws:
            raise DomainError("抽奖没有结果")
        digest = pool_hash(active)
        batch_id = new_id()
        created = now_ms()
        for draw in draws:
            draw["id"] = new_id()
        payload = {
            "albumId": album_id,
            "seed": seed,
            "poolRevision": len(active),
            "poolHash": digest,
            "params": {
                **base,
                "n": ns[0] if ns else n_min,
                "count": count,
                "ns": ns,
                "weighted": True,
                "fixed": [tag_key(p.get("tag") or "") for p in fixed],
                "excluded": list(excluded),
                "weightCaps": caps,
                "nMin": n_min,
                "nMax": n_max,
            },
            "draws": draws,
            "createdAt": created,
        }
        batch = self.uow.load(DrawBatch, batch_id)
        batch.create(payload)
        self.uow.commit(batch, command_id=f"lottery.draw:{seed}:{digest}:{created}")
        found = self.get_batch(batch_id)
        if not found:
            raise DomainError("抽奖失败", 500)
        return found

    def verify(self, batch_id: str) -> dict[str, Any]:
        found = self.get_batch(batch_id, include_deleted=True)
        if not found:
            raise DomainError("批次不存在", 404)
        params_stored = found["params"]
        weighted = bool(params_stored.get("weighted"))
        pool = self.artist_pool(found["albumId"], weighted=weighted)
        excluded = set(params_stored.get("excluded") or [])
        caps = params_stored.get("weightCaps") if isinstance(params_stored.get("weightCaps"), dict) else {}
        active = []
        by_key = {}
        for p in pool:
            k = tag_key(p["tag"])
            item = self._cap_item(p, caps, k)
            by_key[k] = item
            if k not in excluded:
                active.append(item)
        expected_hash = pool_hash(active)
        hash_ok = expected_hash == found["poolHash"]
        rng = Random(int(found["seed"]))
        n_min = int(params_stored.get("nMin") or params_stored.get("n") or 1)
        n_max = int(params_stored.get("nMax") or n_min)
        fixed = [by_key[k] for k in params_stored.get("fixed") or [] if k in by_key]
        shared = {
            "target": params_stored.get("target"),
            "boost": params_stored.get("boost") or 0,
            "jitter": params_stored.get("jitter") or 0,
            "minWeight": params_stored.get("minWeight"),
            "maxWeight": params_stored.get("maxWeight"),
            "fixed": fixed,
        }
        ns = params_stored.get("ns")
        if isinstance(ns, list) and ns:
            replayed = []
            for n in ns:
                replayed.extend(draw_from_pool(active, {**shared, "n": int(n), "count": 1}, rng))
        else:
            n = rng.randint(n_min, n_max)
            replayed = draw_from_pool(
                active,
                {**shared, "n": n, "count": params_stored.get("count") or 1},
                rng,
            )
        texts = [d.get("outputText") for d in found["draws"]]
        replay_texts = [d.get("outputText") for d in replayed]
        return {
            "ok": hash_ok and texts == replay_texts,
            "poolHashMatch": hash_ok,
            "expectedPoolHash": expected_hash,
            "storedPoolHash": found["poolHash"],
            "drawsMatch": texts == replay_texts,
        }

    def remove_draw(self, batch_id: str, draw_ref: str) -> dict[str, Any]:
        found = self.get_batch(batch_id)
        if not found:
            raise DomainError("批次不存在", 404)
        draws = found["draws"]
        index: int | None = None
        draw_id = ""
        for i, draw in enumerate(draws):
            if str(draw.get("id") or "") == str(draw_ref):
                index = i
                draw_id = str(draw.get("id") or "")
                break
        if index is None:
            try:
                index = int(draw_ref)
            except (TypeError, ValueError) as exc:
                raise DomainError("条目不存在", 404) from exc
            if index < 0 or index >= len(draws):
                raise DomainError("条目不存在", 404)
            draw_id = str(draws[index].get("id") or "")
        batch = self.uow.load(DrawBatch, batch_id)
        if len(batch.draws) == len(draws):
            for agg, proj in zip(batch.draws, draws):
                if not agg.get("id") and proj.get("id"):
                    agg["id"] = proj["id"]
        batch.remove_draw(index, draw_id=draw_id or None)
        self.uow.commit(batch)
        updated = self.get_batch(batch_id)
        if not updated:
            raise DomainError("批次不存在", 404)
        return updated

    def delete_batch(self, batch_id: str) -> None:
        batch = self.uow.load(DrawBatch, batch_id)
        batch.delete()
        self.uow.commit(batch)

    def restore_batch(self, batch_id: str) -> dict[str, Any]:
        batch = self.uow.load(DrawBatch, batch_id)
        batch.restore()
        self.uow.commit(batch)
        found = self.get_batch(batch_id, include_deleted=True)
        if not found:
            raise DomainError("批次不存在", 404)
        return found

    def _hydrate_draw_previews(self, batches: list[dict[str, Any]]) -> None:
        missing = any(not (draw.get("previews") or []) for batch in batches for draw in batch.get("draws") or [])
        if not missing:
            return
        by_id = {str(batch.get("id") or ""): batch for batch in batches}
        changed: set[str] = set()
        try:
            with self.store.connect() as conn:
                jobs = conn.execute(
                    """
                    SELECT id, client_json, items_json
                    FROM projections_jobs
                    WHERE source='lottery' AND status='done'
                    """
                ).fetchall()
                for job in jobs:
                    client = json.loads(job["client_json"] or "{}")
                    if not isinstance(client, dict):
                        continue
                    batch_id = str(client.get("batchId") or "").strip()
                    batch = by_id.get(batch_id)
                    if not batch:
                        continue
                    items = json.loads(job["items_json"] or "[]")
                    if attach_job_previews(
                        batch["draws"],
                        batch_id,
                        str(job["id"]),
                        client,
                        items if isinstance(items, list) else [],
                        only_if_empty=True,
                    ):
                        changed.add(batch_id)
                for batch_id in changed:
                    conn.execute(
                        "UPDATE projections_lottery_batches SET draws_json=? WHERE id=?",
                        (json.dumps(by_id[batch_id]["draws"], ensure_ascii=False), batch_id),
                    )
        except sqlite3.Error:
            return

    def _batch_row(self, row) -> dict[str, Any]:
        draws = json.loads(row["draws_json"] or "[]")
        if stamp_draw_ids(draws, row["id"]):
            with self.store.connect() as conn:
                conn.execute(
                    "UPDATE projections_lottery_batches SET draws_json=? WHERE id=?",
                    (json.dumps(draws, ensure_ascii=False), row["id"]),
                )
        return {
            "id": row["id"],
            "albumId": row["album_id"],
            "seed": row["seed"],
            "poolRevision": row["pool_revision"],
            "poolHash": row["pool_hash"],
            "params": json.loads(row["params_json"] or "{}"),
            "draws": draws,
            "createdAt": row["created_at"],
            "deleted": bool(row["deleted"]),
            "version": row["version"],
        }
