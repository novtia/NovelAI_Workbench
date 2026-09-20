from contexts.gallery.application import GalleryService, ensure_default_album
from contexts.gallery.projectors import GalleryProjector
from contexts.lottery.projectors import LotteryProjector
from contexts.generation.projectors import GenerationProjector
from contexts.identity.projectors import IdentityProjector
from kernel.blobs import BlobStore
from kernel.bus import EventHub, UnitOfWork
from kernel.integrity import verify_all
from kernel.store import EventStore


def test_verify_after_album_and_blob(tmp_path):
    store = EventStore(tmp_path / "events.sqlite")
    blobs = BlobStore(tmp_path / "blobs")
    projectors = [GalleryProjector(), LotteryProjector(), GenerationProjector(), IdentityProjector()]
    uow = UnitOfWork(store, projectors, EventHub())
    gallery = GalleryService(uow, store, blobs)
    ensure_default_album(gallery)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\rIHDR"
        + (1).to_bytes(4, "big")
        + (1).to_bytes(4, "big")
        + b"\x08\x02\x00\x00\x00"
        + b"\x90wS\xde"
        + b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    gallery.import_bytes("default", png, {"name": "t.png", "artists": ["x"], "artistLine": "artist:x"})
    report = verify_all(store, blobs, projectors)
    assert report["chain"]["ok"]
    assert report["blobs"]["missing"] == []
    assert report["ok"]
