import io

import pytest
from PIL import Image

from contexts.gallery.application import GalleryService
from contexts.gallery.projectors import GalleryProjector
from contexts.generation.application import GenerationService, SseHub
from contexts.generation.domain import GenerationJob
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


class _KeepTwo:
    def value(self, section, key):
        if section == "generation" and key == "jobsKeep":
            return 2
        raise KeyError(key)


def _stamp(svc, job_id: str, created: int) -> None:
    with svc.store.connect() as conn:
        conn.execute("UPDATE projections_jobs SET created_at=? WHERE id=?", (created, job_id))


def _finish(svc, source: str, created: int, *, items: bool = True) -> str:
    job = svc.enqueue({"prompt": "1girl", "source": source})
    agg = svc.uow.load(GenerationJob, job["id"])
    if items:
        agg.complete(
            [{"id": "shot", "blobHash": "ab" * 32, "width": 832, "height": 1216}],
            {"prompt": "1girl", "seed": 7, "width": 832, "height": 1216, "steps": 28, "sampler": "k_euler"},
            None,
            created,
        )
    else:
        agg.fail("失败", created)
    svc.uow.commit(agg)
    _stamp(svc, job["id"], created)
    return job["id"]


def test_history_pages_past_jobs_keep_and_skips_other_sources(tmp_path):
    svc, _ = _services(tmp_path)
    svc.settings = _KeepTwo()
    older = [_finish(svc, "studio", 1000 + i) for i in range(4)]
    same_a = _finish(svc, "studio", 2000)
    same_b = _finish(svc, "studio", 2000)
    lottery = _finish(svc, "lottery", 5000)
    failed = _finish(svc, "studio", 6000, items=False)
    queued = svc.enqueue({"prompt": "wait", "source": "studio"})

    listed = {j["id"] for j in svc.list_jobs()}
    assert queued["id"] in listed
    assert failed in listed
    assert not any(i in listed for i in older)

    first = svc.list_history(None, "", 2)
    newer, older_same = sorted([same_a, same_b], reverse=True)
    assert [j["id"] for j in first["jobs"]] == [newer, older_same]
    assert all(j["source"] == "studio" and j["status"] == "done" and j["items"] for j in first["jobs"])
    assert first["jobs"][0]["items"][0]["url"] == f"/api/blobs/{'ab' * 32}"
    assert lottery not in {j["id"] for j in first["jobs"]}

    second = svc.list_history(first["nextBefore"], first["nextBeforeId"], 2)
    assert [j["id"] for j in second["jobs"]] == [older[3], older[2]]
    third = svc.list_history(second["nextBefore"], second["nextBeforeId"], 2)
    assert [j["id"] for j in third["jobs"]] == [older[1], older[0]]
    assert third["nextBefore"] is None
    assert third["nextBeforeId"] is None


def _finish_with_images(svc, source: str, created: int, sizes: list[tuple[int, int]]):
    job = svc.enqueue({"prompt": "1girl", "source": source})
    items = [svc.store_image(_image(size)) for size in sizes]
    agg = svc.uow.load(GenerationJob, job["id"])
    agg.complete(items, {"prompt": "1girl", "seed": 7}, None, created)
    svc.uow.commit(agg)
    _stamp(svc, job["id"], created)
    return job["id"], items


def _history_ids(svc) -> dict[str, list[str]]:
    page = svc.list_history(None, "", 100)
    return {j["id"]: [it["id"] for it in j["items"]] for j in page["jobs"]}


def test_delete_history_keeps_blobs_and_album_items(tmp_path):
    from contexts.gallery.application import ensure_default_album
    from kernel.integrity import rebuild_projections, verify_all

    svc, blobs = _services(tmp_path)
    ensure_default_album(svc.gallery)
    job_a, items_a = _finish_with_images(svc, "studio", 1000, [(300, 400), (320, 420)])
    job_b, items_b = _finish_with_images(svc, "studio", 2000, [(340, 440)])
    job_lot, items_lot = _finish_with_images(svc, "lottery", 3000, [(360, 460)])

    saved_hash = items_a[0]["blobHash"]
    svc.promote("default", [saved_hash], {"prompt": "1girl", "name": "nai.png", "artists": ["x"]})
    before = blobs.get(saved_hash)

    refs = [
        {"jobId": job_a, "itemId": items_a[0]["id"]},
        {"jobId": job_lot, "itemId": items_lot[0]["id"]},  # 抽奖任务不属于历史，必须被忽略
        {"jobId": "nope", "itemId": "x"},
        {"jobId": job_a, "itemId": "not-there"},
    ]
    assert svc.delete_history(refs) == 1
    assert _history_ids(svc) == {job_b: [items_b[0]["id"]], job_a: [items_a[1]["id"]]}
    assert svc.get_job(job_lot)["items"], "抽奖任务的图不能被历史删除动到"

    # 收藏夹里的图和图片文件都还在，内容没变。
    assert blobs.exists(saved_hash) and blobs.get(saved_hash) == before
    assert [i["hash"] for i in svc.gallery.list_items("default")] == [saved_hash]

    # 全删光的任务从历史里消失；重复删除是空操作。
    assert svc.delete_history([{"jobId": job_b, "itemId": items_b[0]["id"]}]) == 1
    assert svc.delete_history([{"jobId": job_b, "itemId": items_b[0]["id"]}]) == 0
    assert job_b not in _history_ids(svc)

    # 重建投影后删除结果仍然生效，事件和图片校验都通过。
    expected = _history_ids(svc)
    rebuild_projections(svc.store, svc.uow.projectors)
    assert _history_ids(svc) == expected
    assert [i["hash"] for i in svc.gallery.list_items("default")] == [saved_hash]
    report = verify_all(svc.store, blobs, svc.uow.projectors)
    assert report["ok"], report


def test_upscale_defaults_to_2x(tmp_path):
    svc, _ = _services(tmp_path)
    digest = svc.store_upload(_image((832, 1216)))["blobHash"]
    job = svc.enqueue({"kind": "upscale", "imageHash": digest})
    assert (job["progress"]["width"], job["progress"]["height"]) == (1664, 2432)
