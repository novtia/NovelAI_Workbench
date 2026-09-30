from __future__ import annotations

from typing import Any

from contexts.gallery.rules import strip_artist, tag_key
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


GALLERY_VIEW_ID = "gallery-view"


class GalleryView(AggregateRoot):
    """图库的全局视图选择：当前收藏夹、选中的测试集、测试生图预设。存在数据库里，刷新/换浏览器都不丢。"""

    aggregate_type = "GalleryView"

    def __init__(self, aggregate_id: str = GALLERY_VIEW_ID):
        super().__init__(aggregate_id)
        self.album_id = ""
        self.test_set_id = ""
        self.preset_id = ""

    def select(self, album_id: str, test_set_id: str, preset_id: str):
        if self.version > 0 and (self.album_id, self.test_set_id, self.preset_id) == (album_id, test_set_id, preset_id):
            return
        self.record(
            "GalleryViewSelected",
            {"albumId": album_id, "testSetId": test_set_id, "presetId": preset_id},
        )

    def _on_GalleryViewSelected(self, payload: dict[str, Any]) -> None:
        self.album_id = str(payload.get("albumId") or "")
        self.test_set_id = str(payload.get("testSetId") or "")
        self.preset_id = str(payload.get("presetId") or "")


ARTIST_BASKET_ID = "artist-basket"


class ArtistBasket(AggregateRoot):
    """画师串面板：收集的画师，不带权重（一律按默认 1），按加入顺序，去重。"""

    aggregate_type = "ArtistBasket"

    def __init__(self, aggregate_id: str = ARTIST_BASKET_ID):
        super().__init__(aggregate_id)
        self.keys: set[str] = set()

    def add(self, names: list[Any], added_at: int):
        fresh: list[dict[str, str]] = []
        seen = set(self.keys)
        for raw in names:
            name = strip_artist(str(raw or ""))[:120]
            key = tag_key(name)
            if not key or key in seen:
                continue
            seen.add(key)
            fresh.append({"key": key, "name": name})
        if fresh:
            self.record("ArtistBasketAdded", {"items": fresh, "addedAt": added_at})

    def remove(self, key: str):
        key = tag_key(key)
        if key in self.keys:
            self.record("ArtistBasketRemoved", {"key": key})

    def clear(self):
        if self.keys:
            self.record("ArtistBasketCleared", {})

    def _on_ArtistBasketAdded(self, payload: dict[str, Any]) -> None:
        for item in payload.get("items") or []:
            self.keys.add(str(item.get("key") or ""))

    def _on_ArtistBasketRemoved(self, payload: dict[str, Any]) -> None:
        self.keys.discard(str(payload.get("key") or ""))

    def _on_ArtistBasketCleared(self, payload: dict[str, Any]) -> None:
        self.keys.clear()