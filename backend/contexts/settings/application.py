from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from contexts.settings.domain import SETTINGS_ID, AppSettings
from contexts.settings.schema import SCHEMA, defaults, normalize
from kernel.blobs import BlobStore
from kernel.bus import UnitOfWork
from kernel.errors import DomainError
from kernel.store import EventStore


class SettingsService:
    def __init__(self, uow: UnitOfWork, store: EventStore):
        self.uow = uow
        self.store = store
        self._lock = threading.Lock()
        self._cache: dict[str, dict[str, Any]] | None = None
        self._version = 0

    def _load(self) -> tuple[dict[str, dict[str, Any]], int]:
        with self.store.connect() as conn:
            row = conn.execute("SELECT data_json, version FROM projections_settings WHERE id=?", (SETTINGS_ID,)).fetchone()
        if not row:
            return defaults(), 0
        try:
            return normalize(json.loads(row["data_json"])), int(row["version"])
        except (TypeError, ValueError):
            return defaults(), 0

    def get(self) -> dict[str, dict[str, Any]]:
        """内存缓存的完整设置（供 worker、缩略图等后台代码读取，不会每次查库）。"""
        with self._lock:
            if self._cache is None:
                self._cache, self._version = self._load()
            return self._cache

    def section(self, name: str) -> dict[str, Any]:
        return self.get().get(name) or defaults()[name]

    def value(self, section: str, key: str) -> Any:
        return self.section(section).get(key, SCHEMA[section][key].default)

    def public(self) -> dict[str, Any]:
        settings = self.get()
        return {"settings": settings, "version": self._version}

    def _refresh(self) -> dict[str, Any]:
        with self._lock:
            self._cache, self._version = self._load()
        return self.public()

    def invalidate(self) -> None:
        with self._lock:
            self._cache = None

    def update(self, patch: Any) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise DomainError("参数格式错误")
        agg = self.uow.load(AppSettings, SETTINGS_ID)
        if agg.update(patch):
            self.uow.commit(agg)
        return self._refresh()

    def reset(self, section: str | None = None) -> dict[str, Any]:
        if section is not None and section not in SCHEMA:
            raise DomainError("未知的设置分区")
        agg = self.uow.load(AppSettings, SETTINGS_ID)
        if agg.reset(section):
            self.uow.commit(agg)
        return self._refresh()

    def replace(self, data: Any) -> dict[str, Any]:
        """导入设置：整体替换为给定内容（缺失的项回到默认）。"""
        if not isinstance(data, dict):
            raise DomainError("设置文件格式错误")
        agg = self.uow.load(AppSettings, SETTINGS_ID)
        changed = agg.reset(None)
        changed = agg.update(normalize(data)) or changed
        if changed:
            self.uow.commit(agg)
        return self._refresh()

    def system_info(self, data_dir: Path, blobs: BlobStore) -> dict[str, Any]:
        db = data_dir / "events.sqlite"
        size = 0
        for suffix in ("", "-wal", "-shm"):
            path = Path(str(db) + suffix)
            if path.is_file():
                size += path.stat().st_size
        blob_count = 0
        blob_bytes = 0
        for digest in blobs.iter_hashes():
            path = blobs.path_for(digest)
            try:
                blob_bytes += path.stat().st_size
                blob_count += 1
            except OSError:
                continue
        with self.store.connect() as conn:
            events = conn.execute("SELECT COUNT(*) AS n FROM events").fetchone()["n"]
            artworks = conn.execute("SELECT COUNT(*) AS n FROM projections_artworks WHERE deleted=0").fetchone()["n"]
            albums = conn.execute("SELECT COUNT(*) AS n FROM projections_albums WHERE deleted=0").fetchone()["n"]
        return {
            "dataDir": str(data_dir),
            "dbBytes": size,
            "events": events,
            "artworks": artworks,
            "albums": albums,
            "blobCount": blob_count,
            "blobBytes": blob_bytes,
        }
