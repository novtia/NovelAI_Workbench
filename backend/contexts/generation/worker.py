from __future__ import annotations

import threading

from contexts.generation.application import GenerationService
from contexts.generation.domain import GenerationJob
from contexts.generation.nai_client import NaiError, composite_infill, decode_image_b64, image_to_png, upscale_factor
from kernel.blobs import png_size
from kernel.clock import now_ms


def _progress_text(sample: int, step, steps: int, n_samples: int) -> str:
    if step is None:
        return "生成中"
    if n_samples > 1:
        return f"图 {sample + 1} · {step}/{steps}"
    return f"{step} / {steps}"


def _infill_png(svc: GenerationService, body: dict, png: bytes) -> bytes:
    """局部重绘的接口结果是整张新图，蒙版外面要贴回原图，和官网一样。"""
    if str(body.get("kind") or "") != "infill":
        return png
    original = svc.blobs.get(str(body.get("imageHash") or ""))
    mask = svc.blobs.get(str(body.get("maskHash") or ""))
    if not original or not mask:
        return png
    return composite_infill(original, png, mask)


def _fetch_sub(svc: GenerationService):
    try:
        return svc.gateway.fetch_subscription()
    except NaiError:
        return None


def _run_upscale(svc: GenerationService, job_id: str, job, body: dict) -> None:
    """专用放大：不经过扩散模型，直接调 /ai/upscale。"""
    src = svc.blobs.get(str(body.get("imageHash") or ""))
    if not src:
        raise NaiError(404, "底图已不存在")
    png = image_to_png(src)
    size = png_size(png)
    if not size:
        raise NaiError(400, "无法读取底图")
    factor = upscale_factor(body)
    svc.mutate_job(job_id, lambda j: j.preview(0, None, None, "放大中"))
    inherit = body.get("inherit") if isinstance(body.get("inherit"), dict) else {}
    out = svc.gateway.upscale_image(png, inherit.get("model"))
    if svc.cancelled(job_id):
        raise InterruptedError("已取消")
    rec = svc.store_image(out)
    meta = {
        **inherit,
        "requestType": "upscale",
        "scale": factor,
        "sourceHash": str(body.get("imageHash") or ""),
        "width": rec.get("width"),
        "height": rec.get("height"),
    }
    items = [rec]
    svc.bind_test_set_items(job.source, job.client, items, meta)
    svc.mutate_job(job_id, lambda j: j.complete(items, meta, _fetch_sub(svc), now_ms()))


def _post_upscale(svc: GenerationService, job_id: str, items: list[dict], meta: dict) -> list[dict]:
    """Enhance 的 Max 档：原尺寸 img2img 之后再接一次 2x 放大。"""
    factor = int(meta.get("postUpscale") or 0)
    if not factor:
        return items
    svc.mutate_job(job_id, lambda j: j.preview(0, None, None, "放大中"))
    out: list[dict] = []
    for rec in items:
        if svc.cancelled(job_id):
            raise InterruptedError("已取消")
        raw = svc.blobs.get(rec["blobHash"])
        size = png_size(raw) if raw else None
        if not raw or not size:
            out.append(rec)
            continue
        out.append(svc.store_image(svc.gateway.upscale_image(raw, meta.get("model"))))
    if out and out[0].get("width"):
        meta["width"], meta["height"] = out[0]["width"], out[0]["height"]
    return out


def run_job(svc: GenerationService, job_id: str) -> None:
    job = svc.uow.load(GenerationJob, job_id)
    if job.version == 0 or job.status in {"cancelled", "done", "error"}:
        return
    if svc.cancelled(job_id):
        svc.mutate_job(job_id, lambda j: j.cancel(now_ms()))
        return

    svc.mutate_job(job_id, lambda j: j.start(now_ms()))
    body = job.payload
    progress = job.progress if isinstance(job.progress, dict) else {}
    steps = int(progress.get("steps") or 28)
    n_samples = int(progress.get("nSamples") or 1)
    handle = None
    kind = str(body.get("kind") or "generate")
    try:
        if kind == "upscale":
            _run_upscale(svc, job_id, job, body)
            return
        prepared = svc.prepare_request(body)
        try:
            iterator, meta, handle = svc.gateway.iter_stream(body, prepared)
        except NaiError as exc:
            if exc.status in (400, 401, 403):
                raise
            images, meta = svc.gateway.generate_images(body, prepared)
            items = [svc.store_image(_infill_png(svc, body, png)) for png in images]
            items = _post_upscale(svc, job_id, items, meta)
            sub = None
            try:
                sub = svc.gateway.fetch_subscription()
            except NaiError:
                sub = None
            svc.bind_test_set_items(job.source, job.client, items, meta)
            svc.mutate_job(job_id, lambda j: j.complete(items, meta, sub, now_ms()))
            return

        items: list[dict] = []
        for chunk in iterator:
            if svc.cancelled(job_id):
                raise InterruptedError("已取消")
            et = str(chunk.get("event_type") or "")
            sample = int(chunk.get("samp_ix") or 0)
            image = chunk.get("image") if isinstance(chunk.get("image"), str) else ""
            if et == "intermediate" and image and svc.cfg("generation", "streamPreview", True):
                step = chunk.get("step_ix")
                text = _progress_text(sample, step, steps, n_samples)
                raw = decode_image_b64(image)
                url = svc.write_preview(job_id, sample, raw)
                svc.sse.emit(
                    {
                        "type": "preview",
                        "id": job_id,
                        "url": url,
                        "step": step,
                        "sample": sample,
                        "text": text,
                    }
                )
            elif et == "final" and image:
                png = _infill_png(svc, body, decode_image_b64(image))
                rec = svc.store_image(png)
                items.append(rec)
                svc.sse.emit(
                    {"type": "preview", "id": job_id, "url": rec["url"], "sample": sample, "final": True}
                )
        if svc.cancelled(job_id):
            raise InterruptedError("已取消")
        if not items:
            raise NaiError(502, "生图没有返回图片")
        items = _post_upscale(svc, job_id, items, meta)
        sub = None
        try:
            sub = svc.gateway.fetch_subscription()
        except NaiError:
            sub = None
        svc.bind_test_set_items(job.source, job.client, items, meta)
        svc.mutate_job(job_id, lambda j: j.complete(items, meta, sub, now_ms()))
    except InterruptedError:
        svc.mutate_job(job_id, lambda j: j.cancel(now_ms()))
    except NaiError as exc:
        if svc.cancelled(job_id):
            svc.mutate_job(job_id, lambda j: j.cancel(now_ms()))
        else:
            svc.mutate_job(job_id, lambda j: j.fail(exc.message, now_ms()))
    except Exception as exc:
        if svc.cancelled(job_id):
            svc.mutate_job(job_id, lambda j: j.cancel(now_ms()))
        else:
            svc.mutate_job(job_id, lambda j: j.fail(str(exc) or "生图失败", now_ms()))
    finally:
        svc.clear_previews(job_id)
        if handle:
            resp, client = handle
            try:
                resp.close()
            except Exception:
                pass
            try:
                client.close()
            except Exception:
                pass


MAX_WORKERS = 3


def start_worker(svc: GenerationService) -> None:
    """起 MAX_WORKERS 个线程，实际并发数由设置 generation.concurrency 动态限制（默认 1）。"""
    gate = threading.Condition()
    running = 0

    def loop():
        nonlocal running
        while True:
            job_id = svc.work_queue.get()
            with gate:
                while running >= int(svc.cfg("generation", "concurrency", 1)):
                    gate.wait(1.0)
                running += 1
            try:
                run_job(svc, job_id)
            except Exception:
                pass
            finally:
                with gate:
                    running -= 1
                    gate.notify_all()
                svc.work_queue.task_done()

    for i in range(MAX_WORKERS):
        threading.Thread(target=loop, name=f"nai-jobs-{i}", daemon=True).start()
