import pytest

from contexts.gallery.application import GalleryService, ensure_default_album, ensure_single_artist_album
from contexts.gallery.projectors import GalleryProjector
from contexts.gallery.rules import SINGLE_ARTIST_ALBUM_NAME, TEST_SET_ID_PREFIX
from contexts.generation.application import GenerationService, SseHub
from contexts.generation.projectors import GenerationProjector
from contexts.identity.projectors import IdentityProjector
from contexts.lottery.projectors import LotteryProjector
from kernel.blobs import BlobStore
from kernel.bus import EventHub, UnitOfWork
from kernel.errors import DomainError
from kernel.integrity import rebuild_projections
from kernel.store import EventStore


def _services(tmp_path):
    store = EventStore(tmp_path / "events.sqlite")
    blobs = BlobStore(tmp_path / "blobs")
    projectors = [GalleryProjector(), LotteryProjector(), GenerationProjector(), IdentityProjector()]
    uow = UnitOfWork(store, projectors, EventHub())
    gallery = GalleryService(uow, store, blobs)
    generation = GenerationService(uow, store, blobs, gallery, None, None, SseHub())  # type: ignore[arg-type]
    return gallery, generation, blobs


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


def test_test_set_id_prefix_and_kind(tmp_path):
    gallery, _, _ = _services(tmp_path)
    created = gallery.create_test_set("预设A")
    assert created["id"].startswith(TEST_SET_ID_PREFIX)
    assert created["kind"] == "testSet"
    assert created["count"] == 0


def test_test_set_name_rules(tmp_path):
    gallery, _, _ = _services(tmp_path)
    first = gallery.create_test_set("预设A")
    with pytest.raises(DomainError, match="同名"):
        gallery.create_test_set("预设A")
    with pytest.raises(DomainError, match="系统收藏夹名称"):
        gallery.create_test_set(SINGLE_ARTIST_ALBUM_NAME)
    second = gallery.create_test_set("预设B")
    with pytest.raises(DomainError, match="同名"):
        gallery.rename_album(second["id"], "预设A")
    renamed = gallery.rename_album(first["id"], "预设C")
    assert renamed["name"] == "预设C"


def test_public_create_album_rejects_test_set_id(tmp_path):
    gallery, _, _ = _services(tmp_path)
    with pytest.raises(DomainError):
        gallery.create_album("x", f"{TEST_SET_ID_PREFIX}abc")


def test_test_sets_do_not_count_as_regular_albums(tmp_path):
    gallery, _, _ = _services(tmp_path)
    gallery.create_test_set("预设A")
    assert gallery.active_album_count() == 0
    ensure_default_album(gallery)
    assert gallery.active_album_count() == 1
    only_test = gallery.create_test_set("预设B")
    with pytest.raises(DomainError, match="至少保留"):
        gallery.delete_album("default")
    gallery.delete_album(only_test["id"])
    assert gallery.get_album(only_test["id"])["deleted"] is True


def test_test_set_requires_single_artist(tmp_path):
    gallery, _, _ = _services(tmp_path)
    album = gallery.create_test_set("预设A")
    with pytest.raises(DomainError, match="单个画师串"):
        gallery.import_bytes(album["id"], _png(1), {"name": "a.png", "artists": ["a", "b"]})
    item = gallery.import_bytes(album["id"], _png(2), {"name": "b.png", "artists": ["a"]})
    assert item["albumId"] == album["id"]


def test_gallery_job_completion_binds_into_test_set(tmp_path):
    gallery, generation, blobs = _services(tmp_path)
    ensure_single_artist_album(gallery)
    album = gallery.create_test_set("预设A")
    digest = blobs.put(_png(7))
    client = {
        "testSetId": album["id"],
        "testIndex": 3,
        "artists": ["hiro"],
        "artistLine": "artist:hiro",
        "form": {"prompt": "1girl", "steps": 28},
    }
    saved = generation.bind_test_set_items("gallery", client, [{"blobHash": digest}])
    assert len(saved) == 1
    items = gallery.list_items(album["id"])
    assert len(items) == 1
    assert items[0]["artists"] == ["hiro"]
    assert items[0]["params"]["testIndex"] == 3
    assert items[0]["params"]["prompt"] == "artist:hiro, 1girl"
    # 同一张图重复完成不会重复绑定，也不会抛错
    assert generation.bind_test_set_items("gallery", client, [{"blobHash": digest}]) == []
    assert len(gallery.list_items(album["id"])) == 1


def test_bound_image_keeps_generation_meta_with_characters(tmp_path):
    gallery, generation, blobs = _services(tmp_path)
    ensure_single_artist_album(gallery)
    album = gallery.create_test_set("预设B")
    digest = blobs.put(_png(9))
    client = {
        "testSetId": album["id"],
        "testIndex": 0,
        "artists": ["hiro"],
        "artistLine": "artist:hiro",
        "form": {"prompt": "1girl", "seed": -1, "characters": [{"prompt": "girl, solo", "uc": "", "x": 0.5, "y": 0.5}]},
    }
    gen_meta = {
        "prompt": "artist:hiro, 1girl",
        "seed": 123456,
        "v4Prompt": {"caption": {"base_caption": "artist:hiro, 1girl", "char_captions": [{"char_caption": "girl, solo", "centers": [{"x": 0.5, "y": 0.5}]}]}},
        "v4Negative": {"caption": {"base_caption": "lowres", "char_captions": [{"char_caption": "", "centers": [{"x": 0.5, "y": 0.5}]}]}},
    }
    generation.bind_test_set_items("gallery", client, [{"blobHash": digest}], gen_meta)
    params = gallery.list_items(album["id"])[0]["params"]
    assert params["seed"] == 123456
    assert params["v4Prompt"]["caption"]["char_captions"][0]["char_caption"] == "girl, solo"
    # 测试集自己的记录不被覆盖
    assert params["testSetId"] == album["id"]
    assert params["testIndex"] == 0


def test_other_sources_are_not_bound(tmp_path):
    gallery, generation, blobs = _services(tmp_path)
    album = gallery.create_test_set("预设A")
    digest = blobs.put(_png(8))
    client = {"testSetId": album["id"], "artists": ["hiro"], "artistLine": "artist:hiro"}
    assert generation.bind_test_set_items("lottery", client, [{"blobHash": digest}]) == []
    assert generation.bind_test_set_items("gallery", {}, [{"blobHash": digest}]) == []
    assert gallery.list_items(album["id"]) == []


def test_gallery_view_selection_is_persisted_in_database(tmp_path):
    gallery, _, _ = _services(tmp_path)
    ensure_single_artist_album(gallery)
    empty = gallery.view()
    assert empty["albumId"] == "" and empty["testSetId"] == "" and empty["presetId"] == ""
    album = gallery.find_single_artist_album()
    test_set = gallery.create_test_set("预设A")
    saved = gallery.select_view({"albumId": album["id"], "testSetId": test_set["id"], "presetId": "p1"})
    assert saved["albumId"] == album["id"]
    assert saved["testSetId"] == test_set["id"]
    assert saved["presetId"] == "p1"
    # 只改一项时，其它保持
    assert gallery.select_view({"presetId": "p2"})["testSetId"] == test_set["id"]
    # 事件重放重建投影后仍在
    rebuild_projections(gallery.store, gallery.uow.projectors)
    again = gallery.view()
    assert again["testSetId"] == test_set["id"] and again["presetId"] == "p2"
    # 切回「无」也会持久化
    assert gallery.select_view({"testSetId": ""})["testSetId"] == ""
    # 选中的测试集被删除后，不会再返回它
    gallery.select_view({"testSetId": test_set["id"]})
    gallery.delete_album(test_set["id"])
    assert gallery.view()["testSetId"] == ""