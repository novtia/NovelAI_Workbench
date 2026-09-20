from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from contexts.lottery.application import LotteryService
from kernel.errors import DomainError

router = APIRouter()


def _svc(request: Request) -> LotteryService:
    return request.app.state.lottery


def _err(exc: DomainError) -> JSONResponse:
    return JSONResponse({"error": exc.message}, status_code=exc.status)


@router.get("/api/lottery/board")
def get_board(request: Request):
    return {"board": _svc(request).board()}


@router.put("/api/lottery/board")
async def put_board(request: Request):
    body = await request.json()
    return {"board": _svc(request).configure(body)}


@router.get("/api/lottery/batches")
def list_batches(request: Request):
    return {"batches": _svc(request).list_batches()}


@router.post("/api/lottery/draws")
async def draw(request: Request):
    body = await request.json()
    album_id = str(body.get("albumId") or "")
    if not album_id:
        return JSONResponse({"error": "缺少收藏夹"}, status_code=400)
    try:
        batch = _svc(request).draw(album_id, body)
    except DomainError as exc:
        return _err(exc)
    return JSONResponse({"batch": batch}, status_code=201)


@router.post("/api/lottery/batches/{batch_id}/verify")
def verify(batch_id: str, request: Request):
    try:
        return _svc(request).verify(batch_id)
    except DomainError as exc:
        return _err(exc)


@router.delete("/api/lottery/batches/{batch_id}/draws/{draw_ref}")
def remove_draw(batch_id: str, draw_ref: str, request: Request):
    try:
        batch = _svc(request).remove_draw(batch_id, draw_ref)
    except DomainError as exc:
        return _err(exc)
    return {"batch": batch}


@router.delete("/api/lottery/batches/{batch_id}")
def delete_batch(batch_id: str, request: Request):
    try:
        _svc(request).delete_batch(batch_id)
    except DomainError as exc:
        return _err(exc)
    return Response(status_code=204)


@router.post("/api/lottery/batches/{batch_id}/restore")
def restore_batch(batch_id: str, request: Request):
    try:
        batch = _svc(request).restore_batch(batch_id)
    except DomainError as exc:
        return _err(exc)
    return {"batch": batch}
