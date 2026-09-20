from __future__ import annotations

from typing import Any

from kernel.errors import DomainError
from kernel.events import AggregateRoot

BOARD_ID = "lottery-board"
DEFAULT_CONTROLS = {
    "min": 3,
    "max": 5,
    "draws": 8,
    "target": 1,
    "wmin": 0.05,
    "wmax": 1,
    "jitter": 0.6,
    "boost": 0.4,
}


class LotteryBoard(AggregateRoot):
    aggregate_type = "LotteryBoard"

    def __init__(self, aggregate_id: str = BOARD_ID):
        super().__init__(aggregate_id)
        self.album_id: str | None = None
        self.excluded: list[str] = []
        self.pinned: list[str] = []
        self.weight_caps: dict[str, float] = {}
        self.controls: dict[str, Any] = dict(DEFAULT_CONTROLS)

    def configure(self, data: dict[str, Any]):
        payload = {
            "albumId": data.get("albumId"),
            "excluded": list(data.get("excluded") or []),
            "pinned": list(data.get("pinned") or []),
            "weightCaps": dict(data.get("weightCaps") or {}),
            "controls": {**DEFAULT_CONTROLS, **(data.get("controls") or {})},
        }
        self.record("BoardConfigured", payload)

    def _on_BoardConfigured(self, payload: dict[str, Any]) -> None:
        self.album_id = payload.get("albumId")
        self.excluded = list(payload.get("excluded") or [])
        self.pinned = list(payload.get("pinned") or [])
        self.weight_caps = dict(payload.get("weightCaps") or {})
        self.controls = {**DEFAULT_CONTROLS, **(payload.get("controls") or {})}


def stamp_draw_ids(draws: list[Any], batch_id: str) -> bool:
    """Give each artist-string a stable id. Never rewrite an existing id."""
    changed = False
    for i, raw in enumerate(draws):
        if not isinstance(raw, dict):
            continue
        if str(raw.get("id") or "").strip():
            continue
        raw["id"] = f"{batch_id}:{i}"
        changed = True
    return changed


def lottery_client_draw_id(batch_id: str, client: dict[str, Any] | None) -> str:
    data = client or {}
    draw_id = str(data.get("drawId") or "").strip()
    if draw_id:
        return draw_id
    idx = data.get("drawIndex")
    if idx is None or str(idx).strip() == "":
        return ""
    try:
        return f"{batch_id}:{int(idx)}"
    except (TypeError, ValueError):
        return ""


def preview_items(items: list[Any] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for raw in items or []:
        if not isinstance(raw, dict):
            continue
        digest = str(raw.get("blobHash") or raw.get("id") or "").strip()
        if not digest:
            continue
        url = str(raw.get("url") or "").strip() or f"/api/blobs/{digest}"
        thumb = str(raw.get("thumbUrl") or "").strip() or url
        rec: dict[str, Any] = {
            "id": str(raw.get("id") or digest[:32]),
            "blobHash": digest,
            "url": url,
            "thumbUrl": thumb,
        }
        for key in ("width", "height", "thumbHash"):
            if raw.get(key) not in (None, ""):
                rec[key] = raw[key]
        out.append(rec)
    return out


def attach_job_previews(
    draws: list[Any],
    batch_id: str,
    job_id: str,
    client: dict[str, Any] | None,
    items: list[Any] | None,
    *,
    only_if_empty: bool = False,
) -> bool:
    """Bind completed lottery shots onto the artist-string, never by list order."""
    draw_id = lottery_client_draw_id(batch_id, client)
    if not draw_id:
        return False
    shots = preview_items(items)
    if not shots:
        return False
    for raw in draws:
        if not isinstance(raw, dict):
            continue
        if str(raw.get("id") or "") != draw_id:
            continue
        if only_if_empty and raw.get("previews"):
            return False
        raw["previews"] = shots
        raw["jobId"] = job_id
        return True
    return False


class DrawBatch(AggregateRoot):
    aggregate_type = "DrawBatch"

    def __init__(self, aggregate_id: str):
        super().__init__(aggregate_id)
        self.album_id = ""
        self.seed = 0
        self.pool_revision = 0
        self.pool_hash = ""
        self.params: dict[str, Any] = {}
        self.draws: list[dict[str, Any]] = []
        self.deleted = False
        self.created_at = 0

    def create(self, data: dict[str, Any], *, command_id: str | None = None):
        if self.version > 0 and not self.deleted:
            raise DomainError("批次已存在", 409)
        if not data.get("draws"):
            raise DomainError("抽奖结果为空")
        self.record("DrawBatchCreated", data, command_id=command_id)

    def remove_draw(self, index: int, *, draw_id: str | None = None):
        self._ensure_active()
        if index < 0 or index >= len(self.draws):
            raise DomainError("条目不存在", 404)
        payload: dict[str, Any] = {"index": index}
        rid = str(draw_id or self.draws[index].get("id") or "").strip()
        if rid:
            payload["id"] = rid
        self.record("DrawRemoved", payload)

    def delete(self):
        self._ensure_active()
        self.record("DrawBatchDeleted", {})

    def restore(self):
        if self.version == 0:
            raise DomainError("批次不存在", 404)
        if not self.deleted:
            return
        self.record("DrawBatchRestored", {})

    def _ensure_active(self):
        if self.version == 0 or self.deleted:
            raise DomainError("批次不存在", 404)

    def _on_DrawBatchCreated(self, payload: dict[str, Any]) -> None:
        self.album_id = payload["albumId"]
        self.seed = int(payload["seed"])
        self.pool_revision = int(payload.get("poolRevision") or 0)
        self.pool_hash = payload["poolHash"]
        self.params = dict(payload.get("params") or {})
        self.draws = list(payload.get("draws") or [])
        self.created_at = int(payload.get("createdAt") or 0)
        self.deleted = False

    def _on_DrawRemoved(self, payload: dict[str, Any]) -> None:
        did = str(payload.get("id") or "").strip()
        if did:
            for i, draw in enumerate(self.draws):
                if str(draw.get("id") or "") == did:
                    self.draws.pop(i)
                    return
        idx = int(payload["index"])
        if 0 <= idx < len(self.draws):
            self.draws.pop(idx)

    def _on_DrawBatchDeleted(self, payload: dict[str, Any]) -> None:
        self.deleted = True

    def _on_DrawBatchRestored(self, payload: dict[str, Any]) -> None:
        self.deleted = False
