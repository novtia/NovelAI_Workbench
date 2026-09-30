import pytest

from contexts.gallery.application import GalleryService, ensure_default_album, ensure_single_artist_album
from contexts.gallery.projectors import GalleryProjector
from contexts.gallery.rules import SINGLE_ARTIST_ALBUM_ID, SINGLE_ARTIST_ALBUM_NAME
from contexts.generation.projectors import GenerationProjector
from contexts.identity.projectors import IdentityProjector
from contexts.lottery.projectors import LotteryProjector
from kernel.blobs import BlobStore
from kernel.bus import EventHub, UnitOfWork
from kernel.errors import DomainError
from kernel.store import EventStore


def _gallery(tmp_path) -> GalleryService:
    store = EventStore(tmp_path / "events.sqlite")
    blobs = BlobStore(tmp_path / "blobs")
    projectors = [GalleryProjector(), LotteryProjector(), GenerationProjector(), IdentityProjector()]
    uow = UnitOfWork(store, projectors, EventHub())
    return GalleryService(uow, store, blobs)


def _png(n: int = 1) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\rIHDR"
        + (1).to_bytes(4, "big")
        + (1).to_bytes(4, "big")
        + b"\x08\x02\x00\x00\x00"
        + b"\x90wS\xde"
        + bytes([n])
        + b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def test_ensure_reuses_existing_named_album(tmp_path):
    gallery = _gallery(tmp_path)
    created = gallery.create_album("单画师", "legacy-uuid", system=True)
    assert created["kind"] == "singleArtist"
    assert created["id"] == "legacy-uuid"
    ensure_single_artist_album(gallery)
    albums = [a for a in gallery.list_albums() if a.get("kind") == "singleArtist"]
    assert len(albums) == 1
    assert albums[0]["id"] == created["id"]


def test_ensure_creates_reserved_id(tmp_path):
    gallery = _gallery(tmp_path)
    ensure_default_album(gallery)
    ensure_single_artist_album(gallery)
    album = gallery.find_single_artist_album()
    assert album is not None
    assert album["id"] == SINGLE_ARTIST_ALBUM_ID
    assert album["name"] == SINGLE_ARTIST_ALBUM_NAME
    assert album["kind"] == "singleArtist"
    ensure_single_artist_album(gallery)
    assert len([a for a in gallery.list_albums() if a.get("kind") == "singleArtist"]) == 1


def test_system_album_cannot_be_renamed_or_deleted_or_duplicated(tmp_path):
    gallery = _gallery(tmp_path)
    ensure_single_artist_album(gallery)
    album = gallery.find_single_artist_album()
    assert album
    with pytest.raises(DomainError, match="不可重命名"):
        gallery.rename_album(album["id"], "别的名字")
    with pytest.raises(DomainError, match="不可删除"):
        gallery.delete_album(album["id"])
    other = gallery.create_album("普通夹")
    with pytest.raises(DomainError, match="系统收藏夹名称"):
        gallery.rename_album(other["id"], SINGLE_ARTIST_ALBUM_NAME)
    with pytest.raises(DomainError, match="系统收藏夹"):
        gallery.create_album(SINGLE_ARTIST_ALBUM_NAME)


def test_single_artist_import_requires_one_artist(tmp_path):
    gallery = _gallery(tmp_path)
    ensure_single_artist_album(gallery)
    album_id = gallery.find_single_artist_album()["id"]
    with pytest.raises(DomainError, match="单个画师串"):
        gallery.import_bytes(album_id, _png(1), {"name": "a.png", "artists": []})
    with pytest.raises(DomainError, match="单个画师串"):
        gallery.import_bytes(
            album_id,
            _png(2),
            {"name": "b.png", "artists": ["hiro_(dismaless)", "foo"]},
        )
    first = gallery.import_bytes(
        album_id,
        _png(3),
        {"name": "c.png", "artists": ["hiro_(dismaless)"], "artistLine": "artist:hiro_(dismaless)"},
    )
    second = gallery.import_bytes(
        album_id,
        _png(4),
        {"name": "d.png", "artists": ["artist:hiro_(dismaless)"]},
    )
    assert first["albumId"] == album_id
    assert second["artists"] == ["artist:hiro_(dismaless)"]
    other = gallery.create_album("普通夹")
    multi = gallery.import_bytes(
        other["id"],
        _png(5),
        {"name": "e.png", "artists": ["a", "b"]},
    )
    with pytest.raises(DomainError, match="单个画师串"):
        gallery.move_item(multi["id"], album_id)
    gallery.move_item(first["id"], other["id"])
    assert gallery.get_item(first["id"])["albumId"] == other["id"]


def test_reimport_after_delete_or_clear(tmp_path):
    gallery = _gallery(tmp_path)
    album_id = gallery.create_album("单画师", SINGLE_ARTIST_ALBUM_ID, system=True)["id"]
    meta = {"name": "a.png", "artists": ["foo"]}
    first = gallery.import_bytes(album_id, _png(7), meta)
    gallery.delete_item(first["id"])
    # 删除后再导入同一张图：不能因为旧事件的幂等键而静默失败
    second = gallery.import_bytes(album_id, _png(7), meta)
    assert second["id"] != first["id"]
    gallery.clear_album(album_id)
    third = gallery.import_bytes(album_id, _png(7), meta)
    assert third["id"] not in (first["id"], second["id"])
    assert [it["id"] for it in gallery.list_items(album_id)] == [third["id"]]