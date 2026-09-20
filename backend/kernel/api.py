from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from kernel.blobs import BlobStore
from kernel.bus import Projector
from kernel.integrity import backup_hint, rebuild_projections, verify_all, verify_chain
from kernel.store import EventStore

router = APIRouter()


@router.get("/api/health")
def health():
    return {"ok": True}


@router.get("/api/stream/events")
def stream_events(request: Request, aggregateId: str | None = None, after: int = 0):
    store: EventStore = request.app.state.store
    if aggregateId:
        events = [e for e in store.load_stream(aggregateId) if e.global_seq > after]
    else:
        events = [e for e in store.load_all() if e.global_seq > after]
    return {"events": [e.as_dict() for e in events[-500:]]}


@router.post("/api/integrity/verify")
def verify(request: Request):
    store: EventStore = request.app.state.store
    blobs: BlobStore = request.app.state.blobs
    projectors: list[Projector] = request.app.state.projectors
    return verify_all(store, blobs, projectors)


@router.post("/api/integrity/rebuild")
def rebuild(request: Request):
    store: EventStore = request.app.state.store
    projectors: list[Projector] = request.app.state.projectors
    count = rebuild_projections(store, projectors)
    chain = verify_chain(store)
    return {"rebuilt": count, "chain": chain}


@router.get("/api/integrity/backup")
def backup(request: Request):
    return backup_hint(request.app.state.data_dir)
