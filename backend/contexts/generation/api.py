from __future__ import annotations

import json
import queue

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from contexts.generation.application import GenerationService
from contexts.generation.nai_client import UC_PRESETS
from kernel.errors import DomainError

router = APIRouter()


def _svc(request: Request) -> GenerationService:
    return request.app.state.generation


def _err(exc: DomainError) -> JSONResponse:
    return JSONResponse({"error": exc.message}, status_code=exc.status)


@router.get("/api/nai/status")
def status(request: Request):
    return _svc(request).token_status()


@router.post("/api/nai/token")
async def save_token(request: Request):
    body = await request.json()
    try:
        return _svc(request).set_token(str(body.get("token") or ""))
    except DomainError as exc:
        return _err(exc)


@router.delete("/api/nai/token")
def clear_token(request: Request):
    return _svc(request).clear_token()


@router.get("/api/param-sets")
def list_sets(request: Request):
    return {"paramSets": _svc(request).list_param_sets()}


@router.post("/api/param-sets")
async def save_set(request: Request):
    body = await request.json()
    try:
        item = _svc(request).save_param_set(str(body.get("name") or ""), body.get("form") or {})
    except DomainError as exc:
        return _err(exc)
    return JSONResponse({"paramSet": item}, status_code=201)


@router.patch("/api/param-sets/{sid}")
async def update_set(sid: str, request: Request):
    body = await request.json()
    try:
        item = _svc(request).update_param_set(sid, body.get("form") or {})
    except DomainError as exc:
        return _err(exc)
    return {"paramSet": item}


@router.delete("/api/param-sets/{sid}")
def delete_set(sid: str, request: Request):
    try:
        _svc(request).delete_param_set(sid)
    except DomainError as exc:
        return _err(exc)
    return Response(status_code=204)


@router.post("/api/nai/jobs")
async def create_job(request: Request):
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse({"error": "请求格式错误"}, status_code=400)
    try:
        job = _svc(request).enqueue(body)
    except DomainError as exc:
        return _err(exc)
    return JSONResponse({"job": job}, status_code=202)


@router.get("/api/nai/jobs")
def list_jobs(request: Request):
    return {"jobs": _svc(request).list_jobs()}


@router.get("/api/nai/jobs/stream")
def stream_jobs(request: Request):
    svc = _svc(request)
    q = svc.sse.subscribe()

    def gen():
        snapshot = json.dumps({"type": "snapshot", "jobs": svc.list_jobs()}, ensure_ascii=False)
        yield f"data: {snapshot}\n\n"
        try:
            while True:
                try:
                    payload = q.get(timeout=15)
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                except queue.Empty:
                    yield ": ping\n\n"
        finally:
            svc.sse.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.get("/api/nai/jobs/{job_id}")
def get_job(job_id: str, request: Request):
    job = _svc(request).get_job(job_id)
    if not job:
        return JSONResponse({"error": "任务不存在"}, status_code=404)
    return {"job": job}


@router.post("/api/nai/jobs/{job_id}/cancel")
def cancel_job(job_id: str, request: Request):
    try:
        job = _svc(request).cancel(job_id)
    except DomainError as exc:
        return _err(exc)
    return {"job": job}


@router.post("/api/nai/generate")
async def promote(request: Request):
    body = await request.json()
    album_id = str(body.get("albumId") or "")
    hashes = body.get("tempIds") or body.get("blobHashes") or []
    if body.get("tempId"):
        hashes = [body["tempId"]] + list(hashes)
    hashes = [str(h) for h in hashes if h]
    # allow url-style ids: take blobHash from job items
    svc = _svc(request)
    resolved = []
    for h in hashes:
        if len(h) == 64:
            resolved.append(h)
            continue
        # job item id is first 32 of hash — search jobs
        for job in svc.list_jobs():
            for item in job.get("items") or []:
                if item.get("id") == h or item.get("blobHash", "").startswith(h):
                    resolved.append(item["blobHash"])
    if not album_id or not resolved:
        return JSONResponse({"error": "缺少收藏夹或图片"}, status_code=400)
    try:
        items = svc.promote(album_id, resolved, body.get("meta") or {})
    except DomainError as exc:
        return _err(exc)
    return JSONResponse({"items": items, "saved": True}, status_code=201)


@router.get("/api/generation/uc-presets")
def uc_presets():
    return {"presets": UC_PRESETS}
