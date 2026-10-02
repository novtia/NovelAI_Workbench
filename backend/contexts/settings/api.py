from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from contexts.settings.application import SettingsService
from contexts.settings.schema import SCHEMA
from kernel.errors import DomainError

router = APIRouter()


def _svc(request: Request) -> SettingsService:
    return request.app.state.settings


def _err(exc: DomainError) -> JSONResponse:
    return JSONResponse({"error": exc.message}, status_code=exc.status)


async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


@router.get("/api/settings")
def get_settings(request: Request):
    return _svc(request).public()


@router.put("/api/settings")
async def put_settings(request: Request):
    body = await _body(request)
    try:
        return await asyncio.to_thread(_svc(request).update, body.get("patch", body))
    except DomainError as exc:
        return _err(exc)


@router.post("/api/settings/reset")
async def reset_settings(request: Request):
    body = await _body(request)
    section = body.get("section")
    if section is not None and not isinstance(section, str):
        return JSONResponse({"error": "参数格式错误"}, status_code=400)
    try:
        return await asyncio.to_thread(_svc(request).reset, section or None)
    except DomainError as exc:
        return _err(exc)


@router.post("/api/settings/import")
async def import_settings(request: Request):
    body = await _body(request)
    try:
        return await asyncio.to_thread(_svc(request).replace, body.get("settings"))
    except DomainError as exc:
        return _err(exc)


@router.get("/api/settings/system")
async def system_info(request: Request):
    svc = _svc(request)
    info = await asyncio.to_thread(svc.system_info, request.app.state.data_dir, request.app.state.blobs)
    server = request.scope.get("server")
    info["port"] = server[1] if server else None
    info["version"] = request.app.version
    info["sections"] = list(SCHEMA.keys())
    return info
