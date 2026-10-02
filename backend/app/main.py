from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from contexts.gallery.api import router as gallery_router
from contexts.gallery.application import GalleryService, ensure_default_album, ensure_single_artist_album
from contexts.gallery.migrate import migrate_legacy
from contexts.gallery.projectors import GalleryProjector
from contexts.generation.api import router as generation_router
from contexts.generation.application import GenerationService, SseHub
from contexts.generation.nai_client import NaiGateway, TokenVault
from contexts.generation.projectors import GenerationProjector
from contexts.generation.worker import start_worker
from contexts.identity.projectors import IdentityProjector
from contexts.lottery.api import router as lottery_router
from contexts.lottery.application import LotteryService
from contexts.lottery.projectors import LotteryProjector
from contexts.settings.api import router as settings_router
from contexts.settings.application import SettingsService
from contexts.settings.projectors import SettingsProjector
from kernel.api import router as kernel_router
from kernel.blobs import BlobStore
from kernel.bus import EventHub, UnitOfWork
from kernel.store import EventStore

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
LEGACY = ROOT.parents[1] / "ddd" / "data"


def create_app() -> FastAPI:
    DATA.mkdir(parents=True, exist_ok=True)
    store = EventStore(DATA / "events.sqlite")
    blobs = BlobStore(DATA / "blobs")
    vault = TokenVault(DATA / "secrets" / "nai.token")
    projectors = [
        GalleryProjector(),
        LotteryProjector(),
        GenerationProjector(),
        IdentityProjector(),
        SettingsProjector(),
    ]
    hub = EventHub()
    uow = UnitOfWork(store, projectors, hub)
    gallery = GalleryService(uow, store, blobs)
    lottery = LotteryService(uow, store, gallery)
    sse = SseHub()
    settings = SettingsService(uow, store)
    lottery.default_controls = lambda: settings.section("lottery")
    blobs.thumb_provider = lambda: (
        int(settings.value("gallery", "thumbSize")),
        int(settings.value("gallery", "thumbQuality")),
    )
    gateway = NaiGateway(vault)
    gateway.timeout_provider = lambda: float(settings.value("generation", "timeoutSec"))
    generation = GenerationService(
        uow,
        store,
        blobs,
        gallery,
        gateway,
        vault,
        sse,
        settings,
    )

    if not store.has_events() and (LEGACY / "gallery.db").is_file():
        migrate_legacy(gallery, LEGACY)
    ensure_default_album(gallery)
    ensure_single_artist_album(gallery)

    start_worker(generation)

    app = FastAPI(title="画师串工作台", version="0.1.0")
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:5174",
            "http://localhost:5174",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(kernel_router)
    app.include_router(gallery_router)
    app.include_router(lottery_router)
    app.include_router(generation_router)
    app.include_router(settings_router)
    app.state.settings = settings
    app.state.store = store
    app.state.blobs = blobs
    app.state.projectors = projectors
    app.state.gallery = gallery
    app.state.lottery = lottery
    app.state.generation = generation
    app.state.data_dir = DATA
    return app


app = create_app()
