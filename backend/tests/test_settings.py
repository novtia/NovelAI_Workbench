import pytest

from contexts.gallery.application import GalleryService, ensure_default_album
from contexts.gallery.projectors import GalleryProjector
from contexts.settings.application import SettingsService
from contexts.settings.projectors import SettingsProjector
from contexts.settings.schema import SCHEMA, defaults
from kernel.blobs import BlobStore
from kernel.bus import EventHub, UnitOfWork
from kernel.errors import DomainError
from kernel.integrity import projection_checksum, rebuild_projections
from kernel.store import EventStore


def _svc(tmp_path):
    store = EventStore(tmp_path / "events.sqlite")
    blobs = BlobStore(tmp_path / "blobs")
    projectors = [GalleryProjector(), SettingsProjector()]
    uow = UnitOfWork(store, projectors, EventHub())
    return SettingsService(uow, store), store, projectors, blobs, uow


def test_defaults_when_nothing_saved(tmp_path):
    svc, *_ = _svc(tmp_path)
    data = svc.public()
    assert data["version"] == 0
    assert data["settings"] == defaults()
    assert data["settings"]["generation"]["concurrency"] == 1


def test_update_clamps_and_drops_unknown(tmp_path):
    svc, *_ = _svc(tmp_path)
    out = svc.update(
        {
            "appearance": {"theme": "dark", "toastMs": 500000, "font": "comic", "bogus": 1},
            "generation": {"steps": "abc", "concurrency": 9, "model": "nope"},
            "gallery": {"pageSize": 200, "thumbQuality": 1},
            "nonsense": {"a": 1},
        }
    )["settings"]
    assert out["appearance"]["theme"] == "dark"
    assert out["appearance"]["toastMs"] == 10000
    assert out["appearance"]["font"] == "serif"
    assert "bogus" not in out["appearance"]
    assert out["generation"]["steps"] == 28  # 非法值回到默认
    assert out["generation"]["concurrency"] == 3
    assert out["generation"]["model"] == "nai-diffusion-5-full"
    assert out["gallery"]["pageSize"] == 200
    assert out["gallery"]["thumbQuality"] == 40
    assert "nonsense" not in out


def test_bool_and_choice_type_strictness(tmp_path):
    svc, *_ = _svc(tmp_path)
    out = svc.update({"appearance": {"liveInk": "yes", "reduceMotion": True}, "gallery": {"pageSize": "100"}})["settings"]
    assert out["appearance"]["liveInk"] is True
    assert out["appearance"]["reduceMotion"] is True
    assert out["gallery"]["pageSize"] == 0


def test_noop_update_writes_no_event(tmp_path):
    svc, store, *_ = _svc(tmp_path)
    svc.update({"appearance": {"theme": "dark"}})
    before = len(store.load_all())
    svc.update({"appearance": {"theme": "dark"}})
    svc.update({"appearance": {}})
    assert len(store.load_all()) == before


def test_reset_section_and_all(tmp_path):
    svc, *_ = _svc(tmp_path)
    svc.update({"appearance": {"theme": "dark"}, "gallery": {"density": "compact"}})
    out = svc.reset("appearance")["settings"]
    assert out["appearance"]["theme"] == "light"
    assert out["gallery"]["density"] == "compact"
    out = svc.reset(None)["settings"]
    assert out == defaults()
    with pytest.raises(DomainError):
        svc.reset("nope")


def test_replace_imports_whole_document(tmp_path):
    svc, *_ = _svc(tmp_path)
    svc.update({"appearance": {"theme": "dark"}, "gallery": {"density": "compact"}})
    out = svc.replace({"gallery": {"thumbSize": 600}})["settings"]
    assert out["gallery"]["thumbSize"] == 600
    assert out["gallery"]["density"] == "comfortable"
    assert out["appearance"]["theme"] == "light"
    with pytest.raises(DomainError):
        svc.replace([])


def test_projection_replays_identically_after_rebuild(tmp_path):
    svc, store, projectors, *_ = _svc(tmp_path)
    svc.update({"appearance": {"theme": "auto", "toastMs": 4000}, "lottery": {"draws": 12, "jitter": 0.25}})
    svc.update({"generation": {"steps": 35}})
    svc.reset("appearance")
    before = projection_checksum(store)
    snapshot = svc.public()["settings"]
    rebuild_projections(store, projectors)
    assert projection_checksum(store) == before
    svc.invalidate()
    assert svc.public()["settings"] == snapshot
    assert snapshot["lottery"]["draws"] == 12
    assert snapshot["generation"]["steps"] == 35
    assert snapshot["appearance"]["theme"] == "light"


def test_value_accessor_and_schema_defaults_are_valid():
    for section, keys in SCHEMA.items():
        for key, spec in keys.items():
            assert spec.coerce(spec.default) == spec.default, (section, key)


def test_gallery_list_items_sort(tmp_path):
    svc, store, projectors, blobs, uow = _svc(tmp_path)
    gallery = GalleryService(uow, store, blobs)
    ensure_default_album(gallery)
    album = gallery.list_albums()[0]["id"]

    def png(n: int) -> bytes:
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

    ids = [gallery.import_bytes(album, png(i), {"name": f"{i}.png"})["id"] for i in range(1, 4)]
    desc = [i["id"] for i in gallery.list_items(album, sort="added_desc")]
    asc = [i["id"] for i in gallery.list_items(album, sort="added_asc")]
    assert asc == list(reversed(desc))
    assert set(asc) == set(ids)
    assert len(gallery.list_items(album, limit=2, offset=0)) == 2
    assert len(gallery.list_items(album, limit=2, offset=2)) == 1


def test_thumb_provider_controls_size(tmp_path):
    from io import BytesIO

    from PIL import Image

    blobs = BlobStore(tmp_path / "blobs")
    buf = BytesIO()
    Image.new("RGB", (900, 600), (200, 30, 30)).save(buf, format="PNG")
    blobs.thumb_provider = lambda: (200, 50)
    small = Image.open(BytesIO(blobs.thumb(buf.getvalue())))
    assert max(small.size) == 200
    blobs.thumb_provider = lambda: (600, 90)
    big = Image.open(BytesIO(blobs.thumb(buf.getvalue())))
    assert max(big.size) == 600

def test_settings_api_roundtrip(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from contexts.settings.api import router

    svc, store, projectors, blobs, uow = _svc(tmp_path)
    app = FastAPI(version="9.9")
    app.include_router(router)
    app.state.settings = svc
    app.state.data_dir = tmp_path
    app.state.blobs = blobs
    client = TestClient(app)
    assert client.get("/api/settings").json()["settings"]["appearance"]["theme"] == "light"
    r = client.put("/api/settings", json={"patch": {"appearance": {"theme": "dark"}}})
    assert r.json()["settings"]["appearance"]["theme"] == "dark"
    assert r.json()["version"] == 1
    r = client.post("/api/settings/reset", json={"section": "appearance"})
    assert r.json()["settings"]["appearance"]["theme"] == "light"
    assert client.post("/api/settings/reset", json={"section": "nope"}).status_code == 400
    r = client.post("/api/settings/import", json={"settings": {"gallery": {"density": "compact"}}})
    assert r.json()["settings"]["gallery"]["density"] == "compact"
    info = client.get("/api/settings/system").json()
    assert info["version"] == "9.9" and info["events"] >= 1 and "dataDir" in info


def test_lottery_board_uses_settings_defaults(tmp_path):
    from contexts.lottery.application import LotteryService
    from contexts.lottery.domain import DEFAULT_CONTROLS

    svc, store, projectors, blobs, uow = _svc(tmp_path)
    gallery = GalleryService(uow, store, blobs)
    lottery = LotteryService(uow, store, gallery)
    assert lottery.board()["controls"]["draws"] == DEFAULT_CONTROLS["draws"]
    lottery.default_controls = lambda: svc.section("lottery")
    svc.update({"lottery": {"draws": 12, "min": 2}})
    controls = lottery.board()["controls"]
    assert controls["draws"] == 12 and controls["min"] == 2
    assert set(controls) >= set(DEFAULT_CONTROLS)
