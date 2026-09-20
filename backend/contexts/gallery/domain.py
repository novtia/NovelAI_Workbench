from __future__ import annotations

from typing import Any

from kernel.errors import DomainError
from kernel.events import AggregateRoot


class Album(AggregateRoot):
    aggregate_type = "Album"

    def __init__(self, aggregate_id: str):
        super().__init__(aggregate_id)
        self.name = ""
        self.created_at = 0
        self.sort_order = 0
        self.deleted = False

    def register(self, name: str, created_at: int, sort_order: int, *, command_id: str | None = None):
        if self.version > 0 and not self.deleted:
            raise DomainError("收藏夹已存在", 409)
        name = name.strip()[:40]
        if not name:
            raise DomainError("名称不能为空")
        self.record(
            "AlbumRegistered",
            {"name": name, "createdAt": created_at, "order": sort_order},
            command_id=command_id,
        )

    def rename(self, name: str):
        self._ensure_active()
        name = name.strip()[:40]
        if not name:
            raise DomainError("名称不能为空")
        if name == self.name:
            return
        self.record("AlbumRenamed", {"name": name})

    def delete(self):
        self._ensure_active()
        self.record("AlbumDeleted", {})

    def restore(self):
        if self.version == 0:
            raise DomainError("收藏夹不存在", 404)
        if not self.deleted:
            return
        self.record("AlbumRestored", {"name": self.name})

    def _ensure_active(self):
        if self.version == 0 or self.deleted:
            raise DomainError("收藏夹不存在", 404)

    def _on_AlbumRegistered(self, payload: dict[str, Any]) -> None:
        self.name = payload["name"]
        self.created_at = int(payload["createdAt"])
        self.sort_order = int(payload["order"])
        self.deleted = False

    def _on_AlbumRenamed(self, payload: dict[str, Any]) -> None:
        self.name = payload["name"]

    def _on_AlbumDeleted(self, payload: dict[str, Any]) -> None:
        self.deleted = True

    def _on_AlbumRestored(self, payload: dict[str, Any]) -> None:
        self.deleted = False
        if payload.get("name"):
            self.name = payload["name"]


class Artwork(AggregateRoot):
    aggregate_type = "Artwork"

    def __init__(self, aggregate_id: str):
        super().__init__(aggregate_id)
        self.album_id = ""
        self.added_at = 0
        self.name = ""
        self.mime = ""
        self.size = 0
        self.hash = ""
        self.thumb_hash = ""
        self.width: int | None = None
        self.height: int | None = None
        self.artists: list[str] = []
        self.artist_line = ""
        self.params: dict[str, Any] = {}
        self.deleted = False

    def import_(self, data: dict[str, Any], *, command_id: str | None = None):
        if self.version > 0 and not self.deleted:
            raise DomainError("图片已存在", 409)
        self.record("ArtworkImported", data, command_id=command_id)

    def move(self, album_id: str):
        self._ensure_active()
        if album_id == self.album_id:
            return
        self.record("ArtworkMoved", {"albumId": album_id})

    def delete(self):
        self._ensure_active()
        self.record("ArtworkDeleted", {"albumId": self.album_id, "hash": self.hash})

    def restore(self):
        if self.version == 0:
            raise DomainError("图片不存在", 404)
        if not self.deleted:
            return
        self.record("ArtworkRestored", {"albumId": self.album_id, "hash": self.hash})

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "albumId": self.album_id,
            "addedAt": self.added_at,
            "name": self.name,
            "mime": self.mime,
            "size": self.size,
            "hash": self.hash,
            "thumbHash": self.thumb_hash,
            "width": self.width,
            "height": self.height,
            "artists": list(self.artists),
            "artistLine": self.artist_line,
            "params": dict(self.params),
            "deleted": self.deleted,
            "version": self.version,
        }

    def _ensure_active(self):
        if self.version == 0 or self.deleted:
            raise DomainError("图片不存在", 404)

    def _on_ArtworkImported(self, payload: dict[str, Any]) -> None:
        self.album_id = payload["albumId"]
        self.added_at = int(payload["addedAt"])
        self.name = payload.get("name") or "image"
        self.mime = payload.get("mime") or "application/octet-stream"
        self.size = int(payload.get("size") or 0)
        self.hash = payload["blobHash"]
        self.thumb_hash = payload.get("thumbHash") or ""
        self.width = payload.get("width")
        self.height = payload.get("height")
        self.artists = list(payload.get("artists") or [])
        self.artist_line = payload.get("artistLine") or ""
        self.params = dict(payload.get("params") or {})
        self.deleted = False

    def _on_ArtworkMoved(self, payload: dict[str, Any]) -> None:
        self.album_id = payload["albumId"]

    def _on_ArtworkDeleted(self, payload: dict[str, Any]) -> None:
        self.deleted = True

    def _on_ArtworkRestored(self, payload: dict[str, Any]) -> None:
        self.deleted = False
