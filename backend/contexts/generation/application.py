from __future__ import annotations

import asyncio
import json
import queue
import threading
import time
from pathlib import Path
from typing import Any, Callable

from contexts.gallery.application import GalleryService
from contexts.gallery.rules import extract_artists
from contexts.generation.domain import GenerationJob, ParamSet
from contexts.generation.nai_client import NaiError, NaiGateway, TokenVault, decode_image_b64, token_hint
from kernel.blobs import BlobStore, png_size
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
        settings: Any | None = None,
    ):
        self.settings = settings
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

    def cfg(self, section: str, key: str, default: Any) -> Any:
        """读取设置项；没有设置服务（如单元测试）时回落到默认值。"""
        if self.settings is None:
            return default
        try:
            return self.settings.value(section, key)
        except KeyError:
            return default

    def token_status(self) -> dict[str, Any]:
        now = time.monotonic()
        if self._status_cache is not None and now - self._status_at < self.cfg("account", "statusTtlSec", 45):
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
        keep = int(self.cfg("generation", "jobsKeep", 80))
        with self.store.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM projections_jobs
                WHERE status IN ('queued', 'running')
                   OR id IN (SELECT id FROM projections_jobs ORDER BY created_at DESC LIMIT ?)
                ORDER BY created_at DESC
                """,
                (keep,),
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
        thumb = self.blobs.thumb(data)
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
        artists = meta.get("artists")
        artist_line = meta.get("artistLine")
        if isinstance(artists, str):
            # 上游有时传的是画师串文本而不是列表
            artist_line = artist_line or artists
            artists = extract_artists(artists)[0]
        if not artists:
            # 生图台里画师直接写在 prompt 里，没有单独的画师列表：从 prompt 里识别，否则图库会显示「未识别画师」
            artists, chain = extract_artists(str(meta.get("prompt") or ""))
            artist_line = artist_line or chain
        for digest in blob_hashes:
            data = self.blobs.get(digest)
            if not data:
                raise DomainError("预览文件不存在", 404)
            payload_meta = {
                "name": meta.get("name") or "nai.png",
                "artists": artists or [],
                "artistLine": artist_line or artists or "",
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

    def bind_test_set_items(
        self,
        source: str,
        client: dict[str, Any] | None,
        items: list[dict[str, Any]],
        gen_meta: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """图库测试图任务完成时，把图自动绑定进对应测试集。返回新写入的图库条目。

        gen_meta 是这次生图实际发给 NovelAI 的参数（含 v4Prompt / v4Negative / 角色 / 真实 seed），
        写进图片元数据后，图片详情里才有角色信息。
        """
        client = client if isinstance(client, dict) else {}
        set_id = str(client.get("testSetId") or "").strip()
        if source != "gallery" or not set_id or not items:
            return []
        hashes = [str(it.get("blobHash") or "") for it in items if it.get("blobHash")]
        if not hashes:
            return []
        form = client.get("form") if isinstance(client.get("form"), dict) else {}
        artists = client.get("artists") if isinstance(client.get("artists"), list) else []
        artist_line = str(client.get("artistLine") or "")
        base_prompt = str(form.get("prompt") or "").strip()
        prompt = f"{artist_line}, {base_prompt}" if artist_line and base_prompt else (artist_line or base_prompt)
        used = gen_meta if isinstance(gen_meta, dict) else {}
        meta = {
            **form,
            "prompt": prompt,
            **used,
            "name": "nai.png",
            "artists": [str(a) for a in artists],
            "artistLine": artist_line,
            "source": "nai-v5",
            "testSetId": set_id,
            "testIndex": client.get("testIndex"),
        }
        try:
            return self.promote(set_id, hashes, meta)
        except DomainError:
            return []

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
