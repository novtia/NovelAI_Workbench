"""生成 Rust golden 测试用的 Python 基线。

用法（在 workbench/backend 目录下）：
    .venv\\Scripts\\python ..\\src-tauri\\tests\\py_baseline.py <events.sqlite 的副本> <输出 json>

注意：必须传副本，rebuild 会清空并重建投影表。
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from contexts.gallery.application import GalleryService  # noqa: E402
from contexts.gallery.projectors import GalleryProjector  # noqa: E402
from contexts.generation.projectors import GenerationProjector  # noqa: E402
from contexts.identity.projectors import IdentityProjector  # noqa: E402
from contexts.lottery.application import LotteryService  # noqa: E402
from contexts.lottery.projectors import LotteryProjector  # noqa: E402
from contexts.settings.projectors import SettingsProjector  # noqa: E402
from kernel.blobs import BlobStore  # noqa: E402
from kernel.bus import EventHub, UnitOfWork, verify_chain  # noqa: E402
from kernel.integrity import projection_checksum, rebuild_projections  # noqa: E402
from kernel.store import EventStore  # noqa: E402


def main() -> None:
    db = Path(sys.argv[1])
    out = Path(sys.argv[2])
    store = EventStore(db)
    projectors = [GalleryProjector(), LotteryProjector(), GenerationProjector(), IdentityProjector(), SettingsProjector()]
    blobs = BlobStore(Path(tempfile.mkdtemp()) / "blobs")
    uow = UnitOfWork(store, projectors, EventHub())
    gallery = GalleryService(uow, store, blobs)
    lottery = LotteryService(uow, store, gallery)

    chain = verify_chain(store)
    before = projection_checksum(store)
    rebuild_projections(store, projectors)
    after = projection_checksum(store)

    with store.connect() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM projections_lottery_batches ORDER BY created_at, id")]
    verifies = {}
    for batch_id in ids:
        try:
            verifies[batch_id] = lottery.verify(batch_id)
        except Exception as exc:  # noqa: BLE001
            verifies[batch_id] = {"error": str(exc)}

    out.write_text(
        json.dumps(
            {"chain": chain, "before": before, "after": after, "verifies": verifies},
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    print("events", chain["events"], "ok", chain["ok"], "match", before == after, "batches", len(ids))


if __name__ == "__main__":
    main()
