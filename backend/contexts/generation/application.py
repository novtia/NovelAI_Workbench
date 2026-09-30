from __future__ import annotations

import asyncio
import json
import queue
import threading
import time
from pathlib import Path
from typing import Any, Callable

from contexts.gallery.application import GalleryService
from contexts.generation.domain import GenerationJob, ParamSet
from contexts.generation.nai_client import NaiError, NaiGateway, TokenVault, decode_image_b64, token_hint
from kernel.blobs import BlobStore, make_thumb, png_size
from kernel.bus import UnitOfWork
from kernel.clock import new_hex, new_id, now_ms
from kernel.errors import DomainError
from kernel.store import EventStore

JOB_SOURCES = {"studio", "lottery", "gallery"}


class SseHub:
    def __init__(self):
        self._lock = threading.Lock()
        self._subs: list[queue.Queue] = []
        self._async: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def subscribe_async(self) -> asyncio.Queue:
        loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()
        with self._lock:
            self._async.append((loop, q))
        return q

    def unsubscribe_async(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._async = [(loop, item) for loop, item in self._async if item is not q]

    def emit(self, payload: dict[str, Any]) -> None:
        with self._lock:
            subs = list(self._subs)
            asyncs = list(self._async)
        for q in subs:
            q.put(payload)
        for loop, q in asyncs:
            loop.call_soon_threadsafe(q.put_nowait, payload)


class GenerationService:
    def __init__(
        self,
        uow: UnitOfWork,
        store: EventStore,
        blobs: BlobStore,
        gallery: GalleryService,
        gateway: NaiGateway,
        vault: TokenVault,
        sse: SseHub,
    ):
        self.uow = uow
        self.store = store
        self.blobs = blobs
        self.gallery = gallery
        self.gateway = gateway
        self.vault = vault
        self.sse = sse
        self.work_queue: queue.Queue[str] = queue.Queue()
        self._cancel = set()
        self._lock = threading.Lock()
        self._status_cache: dict[str, Any] | None = None
        self._status_at = 0.0

    def token_status(self) -> dict[str, Any]:
        now = time.monotonic()
        if self._status_cache is not None and now - self._status_at < 45:
            return self._status_cache
        token = self.vault.load()
        out: dict[str, Any] = {"configured": bool(token), "hint": token_hint(token) if token else "", "subscription": None}
        if token:
            try:
                out["subscription"] = self.gateway.fetch_subscription(token)
            except NaiError as exc:
                out["error"] = exc.message
                out["errorStatus"] = exc.status
        self._status_cache = out
        self._status_at = now
        return out

    def preview_path(self, job_id: str, sample: int) -> Path:
        folder = self.blobs.root.parent / "previews"
        folder.mkdir(parents=True, exist_ok=True)
        return folder / f"{job_id}-{int(sample)}.png"

    def write_preview(self, job_id: str, sample: int, data: bytes) -> str:
        self.preview_path(job_id, sample).write_bytes(data)
        return f"/api/nai/jobs/{job_id}/preview?sample={int(sample)}"

    def clear_previews(self, job_id: str) -> None:
        folder = self.blobs.root.parent / "previews"
        if not folder.is_dir():
            return
        for path in folder.glob(f"{job_id}-*.png"):
            path.unlink(missing_ok=True)

    def set_token(self, token: str) -> dict[str, Any]:
        self._status_cache = None
        token = (token or "").strip()
        if not token:
            raise DomainError("Token 不能为空")
        self.vault.save(token)
        from contexts.identity.domain import Credential

        cred = self.uow.load(Credential, "nai")
        cred.set_hint(token_hint(token))
        self.uow.commit(cred, command_id=f"identity.set:{now_ms()}")
        return self.token_status()

    def clear_token(self) -> dict[str, Any]:
        self._status_cache = None
        self.vault.save("")
        from contexts.identity.domain import Credential

        cred = self.uow.load(Credential, "nai")
        cred.clear()
        self.uow.commit(cred)
        return self.token_status()

    def list_param_sets(self) -> list[dict[str, Any]]:
        with self.store.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM projections_param_sets WHERE deleted=0 ORDER BY updated_at DESC"
            ).fetchall()
        return [self._param_row(r) for r in rows]

    def save_param_set(self, name: str, form: dict[str, Any]) -> dict[str, Any]:
        sid = new_id()
        created = now_ms()
        agg = self.uow.load(ParamSet, sid)
        agg.save(name, form, created)
        self.uow.commit(agg)
        found = self.get_param_set(sid)
        if not found:
            raise DomainError("保存失败", 500)
        return found

    def update_param_set(self, sid: str, form: dict[str, Any]) -> dict[str, Any]:
        agg = self.uow.load(ParamSet, sid)
        agg.update(form, now_ms())
        self.uow.commit(agg)
        found = self.get_param_set(sid)
        if not found:
            raise DomainError("预设不存在", 404)
        return found

    def delete_param_set(self, sid: str) -> None:
        agg = self.uow.load(ParamSet, sid)
        agg.delete()
        self.uow.commit(agg)

    def get_param_set(self, sid: str) -> dict[str, Any] | None:
        with self.store.connect() as conn:
            row = conn.execute(
                "SELECT * FROM projections_param_sets WHERE id=? AND deleted=0", (sid,)
            ).fetchone()
        return self._param_row(row) if row else None

    def enqueue(self, body: dict[str, Any]) -> dict[str, Any]:
        if not self.vault.load():
            raise DomainError("还没有配置 NovelAI Persistent API Token", 401)
        data = dict(body)
        source = str(data.pop("source", "") or "studio").strip() or "studio"
        if source not in JOB_SOURCES:
            source = "studio"
        client = data.pop("client", {}) or {}
        if not isinstance(client, dict):
            client = {}
        data.pop("save", None)
        data.pop("albumId", None)
        data.pop("tempId", None)
        data.pop("tempIds", None)
        job_id = new_hex(16)
        created = now_ms()
        try:
            steps = max(1, min(50, int(data.get("steps") or 28)))
        except (TypeError, ValueError):
            steps = 28
        try:
            n_samples = max(1, min(4, int(data.get("nSamples") or 1)))
        except (TypeError, ValueError):
            n_samples = 1
        job = self.uow.load(GenerationJob, job_id)
        job.queue(
            {
                "source": source,
                "payload": data,
                "client": client,
                "progress": {"step": None, "steps": steps, "sample": 0, "nSamples": n_samples, "text": "排队中"},
                "createdAt": created,
            }
        )
        self.uow.commit(job, command_id=f"job.queue:{job_id}")
        public = self.get_job(job_id)
        self.sse.emit({"type": "job", "job": public})
        self.work_queue.put(job_id)
        return public

    def list_jobs(self) -> list[dict[str, Any]]:
        with self.store.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM projections_jobs ORDER BY created_at DESC LIMIT 80"
            ).fetchall()
        return [self._job_row(r) for r in rows]

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self.store.connect() as conn:
            row = conn.execute("SELECT * FROM projections_jobs WHERE id=?", (job_id,)).fetchone()
        return self._job_row(row) if row else None

    def cancel(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            self._cancel.add(job_id)
        job = self.uow.load(GenerationJob, job_id)
        if job.version == 0:
            raise DomainError("任务不存在", 404)
        job.cancel(now_ms())
        self.uow.commit(job)
        public = self.get_job(job_id)
        self.sse.emit({"type": "job", "job": public})
        return public

    def cancelled(self, job_id: str) -> bool:
        with self._lock:
            return job_id in self._cancel

    def mutate_job(self, job_id: str, mutator: Callable[[GenerationJob], None]) -> dict[str, Any] | None:
        job = self.uow.load(GenerationJob, job_id)
        if job.version == 0:
            return None
        mutator(job)
        if job.pending:
            self.uow.commit(job)
        public = self.get_job(job_id)
        if public:
            self.sse.emit({"type": "job", "job": public})
        return public

    def store_image(self, data: bytes) -> dict[str, Any]:
        digest = self.blobs.put(data)
        thumb = make_thumb(data)
        thumb_hash = self.blobs.put(thumb) if thumb else ""
        size = png_size(data)
        rec = {
            "id": digest[:32],
            "blobHash": digest,
            "thumbHash": thumb_hash,
            "url": f"/api/blobs/{digest}",
            "thumbUrl": f"/api/blobs/{thumb_hash or digest}",
            "width": size[0] if size else None,
            "height": size[1] if size else None,
        }
        return rec

    def promote(self, album_id: str, blob_hashes: list[str], meta: dict[str, Any]) -> list[dict[str, Any]]:
        items = []
        for digest in blob_hashes:
            data = self.blobs.get(digest)
            if not data:
                raise DomainError("预览文件不存在", 404)
            payload_meta = {
                "name": meta.get("name") or "nai.png",
                "artists": meta.get("artists") or [],
                "artistLine": meta.get("artistLine") or meta.get("artists") or "",
                "params": {**meta, "source": meta.get("source") or "nai-v5"},
                "width": meta.get("width"),
                "height": meta.get("height"),
            }
            if isinstance(payload_meta["artistLine"], list):
                payload_meta["artistLine"] = ", ".join(f"artist:{n}" for n in payload_meta["artistLine"])
            try:
                item = self.gallery.import_bytes(album_id, data, payload_meta)
                items.append(item)
            except DomainError as exc:
                if exc.status != 409:
                    raise
        if not items:
            raise DomainError("重复", 409)
        return items

    def _param_row(self, row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"],
            "form": json.loads(row["form_json"] or "{}"),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "version": row["version"],
        }

    def _job_row(self, row) -> dict[str, Any]:
        preview = row["preview_hash"]
        items = json.loads(row["items_json"] or "[]")
        for item in items:
            if item.get("blobHash") and not item.get("url"):
                item["url"] = f"/api/blobs/{item['blobHash']}"
            if item.get("thumbHash") and not item.get("thumbUrl"):
                item["thumbUrl"] = f"/api/blobs/{item['thumbHash']}"
        return {
            "id": row["id"],
            "source": row["source"],
            "status": row["status"],
            "progress": json.loads(row["progress_json"] or "{}"),
            "items": items,
            "meta": json.loads(row["meta_json"] or "{}"),
            "error": row["error"],
            "subscription": json.loads(row["subscription_json"]) if row["subscription_json"] else None,
            "client": json.loads(row["client_json"] or "{}"),
            "previewUrl": f"/api/blobs/{preview}" if preview else (items[0]["url"] if items else None),
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
            "version": row["version"],
        }
