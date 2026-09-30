from __future__ import annotations

import threading

from contexts.generation.application import GenerationService
from contexts.generation.domain import GenerationJob
from contexts.generation.nai_client import NaiError, decode_image_b64
from kernel.clock import now_ms


def _progress_text(sample: int, step, steps: int, n_samples: int) -> str:
    if step is None:
        return "生成中"
    if n_samples > 1:
        return f"图 {sample + 1} · {step}/{steps}"
    return f"{step} / {steps}"


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
    try:
        try:
            iterator, meta, handle = svc.gateway.iter_stream(body)
        except NaiError as exc:
            if exc.status in (400, 401, 403):
                raise
            images, meta = svc.gateway.generate_images(body)
            items = [svc.store_image(png) for png in images]
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
            if et == "intermediate" and image:
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
                png = decode_image_b64(image)
                rec = svc.store_image(png)
                items.append(rec)
                svc.sse.emit(
                    {"type": "preview", "id": job_id, "url": rec["url"], "sample": sample, "final": True}
                )
        if svc.cancelled(job_id):
            raise InterruptedError("已取消")
        if not items:
            raise NaiError(502, "生图没有返回图片")
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


def start_worker(svc: GenerationService) -> None:
    def loop():
        while True:
            job_id = svc.work_queue.get()
            try:
                run_job(svc, job_id)
            except Exception:
                pass
            finally:
                svc.work_queue.task_done()

    threading.Thread(target=loop, name="nai-jobs", daemon=True).start()
