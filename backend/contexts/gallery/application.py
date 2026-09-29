from __future__ import annotations

import re
from typing import Any

from contexts.gallery.domain import Album, Artwork
from contexts.gallery.projectors import album_row, artwork_row
from contexts.gallery.rules import (
    SINGLE_ARTIST_ALBUM_ID,
    SINGLE_ARTIST_ALBUM_NAME,
    SINGLE_ARTIST_IMPORT_ERROR,
    is_single_artist_album,
    unique_artist_keys,
)
from kernel.blobs import BlobStore, make_thumb, png_size, sniff_mime
from kernel.bus import UnitOfWork
from kernel.clock import now_ms, new_id
from kernel.errors import DomainError
from kernel.hashes import sha256_bytes
from kernel.store import EventStore

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class GalleryService:
    def __init__(self, uow: UnitOfWork, store: EventStore, blobs: BlobStore):
        self.uow = uow
        self.store = store
        self.blobs = blobs

    def list_albums(self, *, include_deleted: bool = False) -> list[dict[str, Any]]:
        sql = """
            SELECT a.*, (
                SELECT COUNT(*) FROM projections_artworks i
                WHERE i.album_id = a.id AND i.deleted = 0
            ) AS count
            FROM projections_albums a
        """
        if not include_deleted:
            sql += " WHERE a.deleted = 0"
        sql += " ORDER BY a.sort_order ASC, a.created_at ASC"
        with self.store.connect() as conn:
            rows = conn.execute(sql).fetchall()
        return [album_row(r, r["count"]) for r in rows]

    def get_album(self, album_id: str) -> dict[str, Any] | None:
        with self.store.connect() as conn:
            row = conn.execute(
                "SELECT * FROM projections_albums WHERE id=?", (album_id,)
            ).fetchone()
        return album_row(row) if row else None

    def active_album_count(self) -> int:
        with self.store.connect() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM projections_albums WHERE deleted=0"
            ).fetchone()[0]

    def find_single_artist_album(self, *, include_deleted: bool = False) -> dict[str, Any] | None:
        live: dict[str, Any] | None = None
        dead: dict[str, Any] | None = None
        for album in self.list_albums(include_deleted=include_deleted):
            if not is_single_artist_album(album):
                continue
            if album.get("deleted"):
                dead = dead or album
            else:
                live = album
                break
        return live or dead

    def create_album(self, name: str, album_id: str | None = None, *, system: bool = False) -> dict[str, Any]:
        name = (name or "").strip()
        album_id = album_id or new_id()
        if not ID_RE.fullmatch(album_id):
            raise DomainError("无效的收藏夹 id")
        reserved = name == SINGLE_ARTIST_ALBUM_NAME or album_id == SINGLE_ARTIST_ALBUM_ID
        if reserved and not system:
            raise DomainError("「单画师」为系统收藏夹")
        if reserved and self.find_single_artist_album():
            raise DomainError("「单画师」收藏夹已存在", 409)
        created = now_ms()
        album = self.uow.load(Album, album_id)
        album.register(name, created, created)
        self.uow.commit(album, command_id=f"album.register:{album_id}:{created}")
        found = self.get_album(album_id)
        if not found:
            raise DomainError("创建失败", 500)
        found["count"] = 0
        return found

    def rename_album(self, album_id: str, name: str) -> dict[str, Any]:
        current = self.get_album(album_id)
        if not current or current.get("deleted"):
            raise DomainError("收藏夹不存在", 404)
        if is_single_artist_album(current):
            raise DomainError("系统收藏夹不可重命名")
        name = (name or "").strip()
        if name == SINGLE_ARTIST_ALBUM_NAME:
            raise DomainError("「单画师」为系统收藏夹名称")
        album = self.uow.load(Album, album_id)
        album.rename(name)
        self.uow.commit(album)
        found = self.get_album(album_id)
        if not found:
            raise DomainError("收藏夹不存在", 404)
        return found

    def delete_album(self, album_id: str) -> None:
        current = self.get_album(album_id)
        if is_single_artist_album(current):
            raise DomainError("系统收藏夹不可删除")
        if self.active_album_count() <= 1:
            raise DomainError("至少保留一个收藏夹")
        album = self.uow.load(Album, album_id)
        album.delete()
        self.uow.commit(album)
        ids = self._item_ids(album_id, deleted=False)
        for item_id in ids:
            art = self.uow.load(Artwork, item_id)
            art.delete()
            self.uow.commit(art)

    def restore_album(self, album_id: str) -> dict[str, Any]:
        album = self.uow.load(Album, album_id)
        album.restore()
        self.uow.commit(album)
        found = self.get_album(album_id)
        if not found:
            raise DomainError("收藏夹不存在", 404)
        return found

    def list_items(self, album_id: str, *, include_deleted: bool = False) -> list[dict[str, Any]]:
        album = self.get_album(album_id)
        if not album or (album["deleted"] and not include_deleted):
            raise DomainError("收藏夹不存在", 404)
        sql = "SELECT * FROM projections_artworks WHERE album_id=?"
        args: list[Any] = [album_id]
        if not include_deleted:
            sql += " AND deleted=0"
        sql += " ORDER BY added_at DESC"
        with self.store.connect() as conn:
            rows = conn.execute(sql, args).fetchall()
        return [artwork_row(r) for r in rows]

    def get_item(self, item_id: str, *, include_deleted: bool = False) -> dict[str, Any] | None:
        with self.store.connect() as conn:
            row = conn.execute(
                "SELECT * FROM projections_artworks WHERE id=?", (item_id,)
            ).fetchone()
        if not row:
            return None
        if row["deleted"] and not include_deleted:
            return None
        return artwork_row(row)

    def has_hash(self, album_id: str, digest: str) -> bool:
        with self.store.connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM projections_artworks WHERE album_id=? AND hash=? AND deleted=0",
                (album_id, digest.lower()),
            ).fetchone()
        return bool(row)

    def import_bytes(
        self,
        album_id: str,
        data: bytes,
        meta: dict[str, Any],
        *,
        thumb: bytes | None = None,
        command_id: str | None = None,
        item_id: str | None = None,
    ) -> dict[str, Any]:
        album = self.get_album(album_id)
        if not album or album["deleted"]:
            raise DomainError("收藏夹不存在", 404)
        artists = meta.get("artists") if isinstance(meta.get("artists"), list) else []
        self._assert_single_artist_meta(album, artists)
        digest = sha256_bytes(data)
        if self.has_hash(album_id, digest):
            raise DomainError("重复", 409)
        blob_hash = self.blobs.put(data)
        if blob_hash != digest:
            raise DomainError("哈希写入失败", 500)
        thumb_hash = ""
        if thumb:
            thumb_hash = self.blobs.put(thumb)
        else:
            generated = make_thumb(data)
            if generated:
                thumb_hash = self.blobs.put(generated)
        size = png_size(data)
        item_id = item_id or str(meta.get("id") or "") or new_id()
        if not ID_RE.fullmatch(item_id):
            raise DomainError("无效的图片 id")
        params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
        payload = {
            "albumId": album_id,
            "addedAt": int(meta.get("addedAt") or now_ms()),
            "name": str(meta.get("name") or "image")[:240],
            "mime": sniff_mime(data),
            "size": len(data),
            "blobHash": blob_hash,
            "thumbHash": thumb_hash,
            "width": int(meta["width"]) if meta.get("width") is not None else (size[0] if size else None),
            "height": int(meta["height"]) if meta.get("height") is not None else (size[1] if size else None),
            "artists": [str(a) for a in artists],
            "artistLine": str(meta.get("artistLine") or ""),
            "params": params,
        }
        art = self.uow.load(Artwork, item_id)
        art.import_(payload, command_id=command_id)
        self.uow.commit(art, command_id=command_id or f"artwork.import:{blob_hash}:{album_id}")
        item = self.get_item(item_id)
        if not item:
            raise DomainError("导入失败", 500)
        return item

    def move_item(self, item_id: str, album_id: str) -> dict[str, Any]:
        album = self.get_album(album_id)
        if not album or album["deleted"]:
            raise DomainError("收藏夹不存在", 404)
        item = self.get_item(item_id)
        if not item:
            raise DomainError("图片不存在", 404)
        self._assert_single_artist_meta(album, item.get("artists") or [])
        if item["albumId"] != album_id and self.has_hash(album_id, item["hash"]):
            raise DomainError("目标收藏夹已有这张图", 409)
        art = self.uow.load(Artwork, item_id)
        art.move(album_id)
        self.uow.commit(art)
        found = self.get_item(item_id)
        if not found:
            raise DomainError("图片不存在", 404)
        return found

    def delete_item(self, item_id: str) -> None:
        art = self.uow.load(Artwork, item_id)
        art.delete()
        self.uow.commit(art)

    def restore_item(self, item_id: str) -> dict[str, Any]:
        art = self.uow.load(Artwork, item_id)
        if art.album_id and self.has_hash(art.album_id, art.hash):
            raise DomainError("目标收藏夹已有这张图", 409)
        art.restore()
        self.uow.commit(art)
        found = self.get_item(item_id, include_deleted=True)
        if not found:
            raise DomainError("图片不存在", 404)
        return found

    def clear_album(self, album_id: str) -> None:
        album = self.get_album(album_id)
        if not album or album["deleted"]:
            raise DomainError("收藏夹不存在", 404)
        for item_id in self._item_ids(album_id, deleted=False):
            self.delete_item(item_id)

    def artwork_at(self, item_id: str, version: int) -> dict[str, Any]:
        art = Artwork(item_id)
        stream = [e for e in self.store.load_stream(item_id) if e.version <= version]
        if not stream:
            raise DomainError("图片不存在", 404)
        art.rehydrate(stream)
        return art.snapshot()

    def pool_for_album(self, album_id: str) -> list[dict[str, Any]]:
        items = self.list_items(album_id)
        seen: set[str] = set()
        pool: list[dict[str, Any]] = []
        for item in items:
            for name in item.get("artists") or []:
                key = re.sub(r"[_\s]+", " ", str(name).lower()).strip()
                if not key or key in seen:
                    continue
                seen.add(key)
                pool.append({"tag": str(name), "name": str(name), "key": key, "weight": 1})
        return pool

    def _item_ids(self, album_id: str, *, deleted: bool) -> list[str]:
        flag = 1 if deleted else 0
        with self.store.connect() as conn:
            rows = conn.execute(
                "SELECT id FROM projections_artworks WHERE album_id=? AND deleted=?",
                (album_id, flag),
            ).fetchall()
        return [r["id"] for r in rows]

    def _assert_single_artist_meta(self, album: dict[str, Any], artists: Any) -> None:
        if not is_single_artist_album(album):
            return
        if len(unique_artist_keys(artists)) != 1:
            raise DomainError(SINGLE_ARTIST_IMPORT_ERROR)


def ensure_default_album(service: GalleryService) -> None:
    if service.list_albums():
        return
    service.create_album("默认收藏夹", "default")


def ensure_single_artist_album(service: GalleryService) -> None:
    found = service.find_single_artist_album(include_deleted=True)
    if found:
        if found.get("deleted"):
            service.restore_album(found["id"])
        return
    service.create_album(SINGLE_ARTIST_ALBUM_NAME, SINGLE_ARTIST_ALBUM_ID, system=True)
