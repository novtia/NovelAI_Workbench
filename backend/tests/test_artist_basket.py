from contexts.gallery.application import GalleryService
from contexts.gallery.projectors import GalleryProjector
from contexts.generation.projectors import GenerationProjector
from contexts.identity.projectors import IdentityProjector
from contexts.lottery.projectors import LotteryProjector
from kernel.blobs import BlobStore
from kernel.bus import EventHub, UnitOfWork
from kernel.integrity import rebuild_projections
from kernel.store import EventStore


def _gallery(tmp_path) -> GalleryService:
    store = EventStore(tmp_path / "events.sqlite")
    blobs = BlobStore(tmp_path / "blobs")
    projectors = [GalleryProjector(), LotteryProjector(), GenerationProjector(), IdentityProjector()]
    uow = UnitOfWork(store, projectors, EventHub())
    return GalleryService(uow, store, blobs)


def _names(items):
    return [it["name"] for it in items]


def test_add_dedupes_and_keeps_order(tmp_path):
    gallery = _gallery(tmp_path)
    assert gallery.basket() == []
    out = gallery.basket_add(["artist:hiro_(dismaless)", "foo", "Hiro (dismaless)", "  ", "artist:artist:bar"])
    assert _names(out) == ["hiro_(dismaless)", "foo", "bar"]
    # 再次添加已有的（大小写 / 下划线 / 前缀不同）不会重复
    out = gallery.basket_add(["FOO", "artist:hiro (dismaless)", "baz"])
    assert _names(out) == ["hiro_(dismaless)", "foo", "bar", "baz"]


def test_add_multiple_artists_in_one_call(tmp_path):
    gallery = _gallery(tmp_path)
    out = gallery.basket_add(["a", "b", "c"])
    assert [it["key"] for it in out] == ["a", "b", "c"]
    assert all(it["addedAt"] > 0 for it in out)


def test_remove_and_clear(tmp_path):
    gallery = _gallery(tmp_path)
    gallery.basket_add(["a", "b", "c"])
    assert _names(gallery.basket_remove("B")) == ["a", "c"]
    assert _names(gallery.basket_remove("not-there")) == ["a", "c"]
    # 移除后可以再次加入，排到最后
    assert _names(gallery.basket_add(["b"])) == ["a", "c", "b"]
    assert gallery.basket_clear() == []
    assert gallery.basket_clear() == []


def test_basket_survives_projection_rebuild(tmp_path):
    gallery = _gallery(tmp_path)
    gallery.basket_add(["a", "b", "c"])
    gallery.basket_remove("b")
    gallery.basket_add(["d"])
    before = gallery.basket()
    rebuild_projections(gallery.store, gallery.uow.projectors)
    assert gallery.basket() == before
    assert _names(before) == ["a", "c", "d"]
