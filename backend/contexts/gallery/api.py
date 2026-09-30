from __future__ import annotations

import asyncio
import json
import re

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from contexts.gallery.application import GalleryService
from kernel.blobs import BlobStore
from kernel.errors import DomainError

router = APIRouter()
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")


def _svc(request: Request) -> GalleryService:
    return request.app.state.gallery


def _blobs(request: Request) -> BlobStore:
    return request.app.state.blobs


def _err(exc: DomainError) -> JSONResponse:
    return JSONResponse({"error": exc.message}, status_code=exc.status)


@router.get("/api/albums")
def list_albums(request: Request):
    return {"albums": _svc(request).list_albums()}


@router.post("/api/albums")
async def create_album(request: Request):
    body = await request.json()
    try:
        album = await asyncio.to_thread(_svc(request).create_album, str(body.get("name") or ""), body.get("id"))
    except DomainError as exc:
        return _err(exc)
    return JSONResponse({"album": album}, status_code=201)


@router.patch("/api/albums/{album_id}")
async def rename_album(album_id: str, request: Request):
    body = await request.json()
    try:
        album = await asyncio.to_thread(_svc(request).rename_album, album_id, str(body.get("name") or ""))
    except DomainError as exc:
        return _err(exc)
    return {"album": album}


@router.delete("/api/albums/{album_id}")
def delete_album(album_id: str, request: Request):
    try:
        _svc(request).delete_album(album_id)
    except DomainError as exc:
        return _err(exc)
    return Response(status_code=204)


@router.post("/api/albums/{album_id}/restore")
def restore_album(album_id: str, request: Request):
    try:
        album = _svc(request).restore_album(album_id)
    except DomainError as exc:
        return _err(exc)
    return {"album": album}


@router.get("/api/albums/{album_id}/items")
def list_items(album_id: str, request: Request, limit: int | None = None, offset: int = 0):
    try:
        items = _svc(request).list_items(album_id, limit=limit, offset=offset)
    except DomainError as exc:
        return _err(exc)
    return {"items": items}


@router.delete("/api/albums/{album_id}/items")
def clear_album(album_id: str, request: Request):
    try:
        _svc(request).clear_album(album_id)
    except DomainError as exc:
        return _err(exc)
    return Response(status_code=204)


@router.get("/api/albums/{album_id}/hashes/{hash_hex}")
def has_hash(album_id: str, hash_hex: str, request: Request):
    digest = hash_hex.strip().lower()
    if not HASH_RE.fullmatch(digest):
        return JSONResponse({"error": "无效的哈希"}, status_code=400)
    return {"exists": _svc(request).has_hash(album_id, digest)}


@router.post("/api/albums/{album_id}/items")
async def add_item(album_id: str, request: Request):
    form = await request.form()
    upload = form.get("file")
    thumb = form.get("thumb")
    if upload is None or not getattr(upload, "filename", None):
        return JSONResponse({"error": "缺少图片文件"}, status_code=400)
    try:
        meta = json.loads(str(form.get("meta") or "{}"))
        if not isinstance(meta, dict):
            raise ValueError("meta")
    except (json.JSONDecodeError, ValueError):
        return JSONResponse({"error": "元数据格式错误"}, status_code=400)
    data = await upload.read()
    thumb_bytes = await thumb.read() if thumb is not None and getattr(thumb, "filename", None) else None
    try:
        item = await asyncio.to_thread(_svc(request).import_bytes, album_id, data, meta, thumb=thumb_bytes)
    except DomainError as exc:
        return _err(exc)
    return JSONResponse({"item": item}, status_code=201)


@router.patch("/api/items/{item_id}")
async def move_item(item_id: str, request: Request):
    body = await request.json()
    try:
        item = await asyncio.to_thread(_svc(request).move_item, item_id, str(body.get("albumId") or ""))
    except DomainError as exc:
        return _err(exc)
    return {"item": item}


@router.delete("/api/items/{item_id}")
def delete_item(item_id: str, request: Request):
    try:
        _svc(request).delete_item(item_id)
    except DomainError as exc:
        return _err(exc)
    return Response(status_code=204)


@router.post("/api/items/{item_id}/restore")
def restore_item(item_id: str, request: Request):
    try:
        item = _svc(request).restore_item(item_id)
    except DomainError as exc:
        return _err(exc)
    return {"item": item}


@router.get("/api/artworks/{item_id}/at/{version}")
def artwork_at(item_id: str, version: int, request: Request):
    try:
        return {"artwork": _svc(request).artwork_at(item_id, version)}
    except DomainError as exc:
        return _err(exc)


@router.get("/api/items/{item_id}/image")
def item_image(item_id: str, request: Request):
    item = _svc(request).get_item(item_id)
    if not item:
        return JSONResponse({"error": "图片不存在"}, status_code=404)
    return _blob_response(_blobs(request), item["hash"], item.get("mime"))


@router.get("/api/items/{item_id}/thumb")
def item_thumb(item_id: str, request: Request):
    item = _svc(request).get_item(item_id)
    if not item:
        return JSONResponse({"error": "图片不存在"}, status_code=404)
    digest = item.get("thumbHash") or item["hash"]
    return _blob_response(_blobs(request), digest, "image/webp")


@router.get("/api/blobs/{digest}")
def get_blob(digest: str, request: Request):
    digest = digest.strip().lower()
    if not HASH_RE.fullmatch(digest):
        return JSONResponse({"error": "无效的哈希"}, status_code=400)
    return _blob_response(_blobs(request), digest, None)


def _blob_response(blobs: BlobStore, digest: str, mime: str | None):
    path = blobs.path_for(digest)
    if not path.is_file():
        return JSONResponse({"error": "文件不存在"}, status_code=404)
    media = mime
    if not media:
        head = path.read_bytes()[:12]
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            media = "image/png"
        elif head[:2] == b"\xff\xd8":
            media = "image/jpeg"
        elif head[:4] == b"RIFF":
            media = "image/webp"
        else:
            media = "application/octet-stream"
    return FileResponse(
        path,
        media_type=media,
        headers={"Cache-Control": "public, max-age=31536000, immutable", "ETag": f'"{digest}"'},
    )
