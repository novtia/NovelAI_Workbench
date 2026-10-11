import io

import pytest
from PIL import Image

from contexts.gallery.application import GalleryService
from contexts.gallery.projectors import GalleryProjector
from contexts.generation.application import GenerationService, SseHub
from contexts.generation.nai_client import NaiError
from contexts.generation.projectors import GenerationProjector
from contexts.identity.projectors import IdentityProjector
from contexts.lottery.projectors import LotteryProjector
from kernel.blobs import BlobStore
from kernel.bus import EventHub, UnitOfWork
from kernel.errors import DomainError
from kernel.store import EventStore


class FakeVault:
    def load(self) -> str:
        return "pst-test-token"


def _services(tmp_path):
    store = EventStore(tmp_path / "events.sqlite")
    blobs = BlobStore(tmp_path / "blobs")
    projectors = [GalleryProjector(), LotteryProjector(), GenerationProjector(), IdentityProjector()]
    uow = UnitOfWork(store, projectors, EventHub())
    gallery = GalleryService(uow, store, blobs)
    return GenerationService(uow, store, blobs, gallery, None, FakeVault(), SseHub()), blobs  # type: ignore[arg-type]


def _image(size=(500, 700), fmt="PNG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (10, 120, 200)).save(buf, format=fmt)
    return buf.getvalue()


def test_upload_converts_non_png_and_reports_size(tmp_path):
    svc, blobs = _services(tmp_path)
    rec = svc.store_upload(_image((300, 200), "JPEG"))
    assert (rec["width"], rec["height"]) == (300, 200)
    assert blobs.get(rec["blobHash"])[:8] == b"\x89PNG\r\n\x1a\n"


def test_upload_rejects_garbage_and_empty(tmp_path):
    svc, _ = _services(tmp_path)
    with pytest.raises(DomainError):
        svc.store_upload(b"")
    with pytest.raises(DomainError):
        svc.store_upload(b"not an image")


def test_enqueue_upscale_records_target_size_without_prompt(tmp_path):
    svc, _ = _services(tmp_path)
    digest = svc.store_upload(_image((832, 1216)))["blobHash"]
    job = svc.enqueue({"kind": "upscale", "imageHash": digest, "scale": 4})
    assert job["progress"]["kind"] == "upscale"
    # 官方 /ai/upscale 固定 2 倍，scale 不再影响尺寸。
    assert (job["progress"]["width"], job["progress"]["height"]) == (1664, 2432)
    assert job["progress"]["nSamples"] == 1


def test_enqueue_enhance_max_plans_official_size(tmp_path):
    svc, _ = _services(tmp_path)
    digest = svc.store_upload(_image((832, 1216)))["blobHash"]
    job = svc.enqueue({"kind": "enhance", "imageHash": digest, "upscaleAmount": "max", "prompt": "1girl", "nSamples": 4})
    assert (job["progress"]["width"], job["progress"]["height"]) == (1467, 2144)
    assert job["progress"]["nSamples"] == 1


def test_enqueue_validates_image_and_mask(tmp_path):
    svc, _ = _services(tmp_path)
    digest = svc.store_upload(_image())["blobHash"]
    with pytest.raises(DomainError):
        svc.enqueue({"kind": "nonsense", "prompt": "x"})
    with pytest.raises(DomainError):
        svc.enqueue({"kind": "img2img", "prompt": "x"})
    with pytest.raises(DomainError):
        svc.enqueue({"kind": "img2img", "prompt": "x", "imageHash": "0" * 64})
    with pytest.raises(DomainError):
        svc.enqueue({"kind": "infill", "prompt": "x", "imageHash": digest})
    ok = svc.enqueue({"kind": "infill", "prompt": "x", "imageHash": digest, "maskHash": digest})
    assert ok["progress"]["kind"] == "infill"
    assert (ok["progress"]["width"], ok["progress"]["height"]) == (512, 704)


def test_prepare_request_reads_blobs(tmp_path):
    svc, _ = _services(tmp_path)
    digest = svc.store_upload(_image())["blobHash"]
    mask = svc.store_upload(_image())["blobHash"]
    payload, meta = svc.prepare_request(
        {"kind": "infill", "prompt": "1girl", "seed": 3, "imageHash": digest, "maskHash": mask, "model": "nai-diffusion-5-full"}
    )
    assert payload["action"] == "infill"
    assert payload["model"].endswith("-inpainting")
    assert meta["sourceHash"] == digest
    with pytest.raises(NaiError):
        svc.prepare_request({"kind": "img2img", "prompt": "x", "imageHash": "f" * 64})


def test_generate_kind_is_unchanged(tmp_path):
    svc, _ = _services(tmp_path)
    job = svc.enqueue({"prompt": "1girl", "nSamples": 2})
    assert job["progress"]["kind"] == "generate"
    assert job["progress"]["nSamples"] == 2
    assert "width" not in job["progress"]


def test_enqueue_variation_forces_three_samples_and_keeps_source(tmp_path):
    svc, _ = _services(tmp_path)
    digest = svc.store_upload(_image((832, 1216)))["blobHash"]
    job = svc.enqueue({"kind": "variation", "imageHash": digest, "prompt": "1girl", "nSamples": 1, "seed": 5})
    assert job["progress"]["kind"] == "variation"
    assert job["progress"]["nSamples"] == 3
    assert job["progress"]["sourceHash"] == digest
    assert (job["progress"]["width"], job["progress"]["height"]) == (832, 1216)


def test_prepare_variation_is_img2img_with_random_seed(tmp_path):
    svc, _ = _services(tmp_path)
    digest = svc.store_upload(_image((832, 1216)))["blobHash"]
    payload, meta = svc.prepare_request({"kind": "variation", "imageHash": digest, "prompt": "1girl", "seed": 5})
    assert payload["action"] == "img2img"
    assert payload["parameters"]["n_samples"] == 3
    assert payload["parameters"]["strength"] == 0.6
    assert meta["requestType"] == "variation"
    assert meta["sourceHash"] == digest


def test_estimate_matches_official_screenshot(tmp_path):
    svc, _ = _services(tmp_path)
    cost = svc.estimate({"width": 832, "height": 1216, "steps": 28})
    assert cost["variation"] == 36
    assert cost["upscale"] == 1
    assert cost["estimated"] is True
    assert cost["enhance"] >= 2


def test_enhance_cost_matches_official_button(tmp_path):
    svc, _ = _services(tmp_path)
    # 官方 832x1216、Opus：1x 全是 0；1.5x 与 Max 按强度 1~5 计价，不跟步数滑杆变。
    one_x = [svc.estimate({"width": 832, "height": 1216, "steps": steps, "magnitude": m, "upscaleAmount": "1x", "opus": True})["enhance"] for steps in (20, 28) for m in range(1, 6)]
    assert one_x == [0] * 10
    mid = [11, 21, 27, 32, 37]
    high = [14, 27, 34, 41, 48]
    for steps in (20, 28):
        got_mid = [svc.estimate({"width": 832, "height": 1216, "steps": steps, "magnitude": m, "upscaleAmount": "1.5x", "opus": True})["enhance"] for m in range(1, 6)]
        got_high = [svc.estimate({"width": 832, "height": 1216, "steps": steps, "magnitude": m, "upscaleAmount": "max", "opus": True})["enhance"] for m in range(1, 6)]
        assert got_mid == mid
        assert got_high == high


def test_generate_estimate_respects_opus_free_image(tmp_path):
    svc, _ = _services(tmp_path)
    base = {"genWidth": 832, "genHeight": 1216, "steps": 28}
    one = svc.estimate({**base, "genSamples": 1})["generate"]
    assert one > 0
    assert svc.estimate({**base, "genSamples": 1, "opus": True})["generate"] == 0
    assert svc.estimate({**base, "genSamples": 3, "opus": True})["generate"] == one * 2
    assert svc.estimate({**base, "genSamples": 1, "opus": True, "steps": 40})["generate"] > 0


def test_upscale_defaults_to_2x(tmp_path):
    svc, _ = _services(tmp_path)
    digest = svc.store_upload(_image((832, 1216)))["blobHash"]
    job = svc.enqueue({"kind": "upscale", "imageHash": digest})
    assert (job["progress"]["width"], job["progress"]["height"]) == (1664, 2432)
