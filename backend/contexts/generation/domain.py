from __future__ import annotations

from typing import Any

from kernel.errors import DomainError
from kernel.events import AggregateRoot


class ParamSet(AggregateRoot):
    aggregate_type = "ParamSet"

    def __init__(self, aggregate_id: str):
        super().__init__(aggregate_id)
        self.name = ""
        self.form: dict[str, Any] = {}
        self.created_at = 0
        self.updated_at = 0
        self.deleted = False

    def save(self, name: str, form: dict[str, Any], created_at: int):
        if self.version > 0 and not self.deleted:
            raise DomainError("预设已存在", 409)
        name = name.strip()[:40]
        if not name:
            raise DomainError("名称不能为空")
        self.record("ParamSetSaved", {"name": name, "form": form, "createdAt": created_at})

    def update(self, form: dict[str, Any], updated_at: int):
        if self.version == 0 or self.deleted:
            raise DomainError("预设不存在", 404)
        self.record("ParamSetUpdated", {"form": form, "updatedAt": updated_at, "name": self.name})

    def delete(self):
        if self.version == 0 or self.deleted:
            raise DomainError("预设不存在", 404)
        self.record("ParamSetDeleted", {})

    def restore(self):
        if self.version == 0:
            raise DomainError("预设不存在", 404)
        if not self.deleted:
            return
        self.record("ParamSetRestored", {})

    def _on_ParamSetSaved(self, payload: dict[str, Any]) -> None:
        self.name = payload["name"]
        self.form = dict(payload.get("form") or {})
        self.created_at = int(payload["createdAt"])
        self.updated_at = self.created_at
        self.deleted = False

    def _on_ParamSetUpdated(self, payload: dict[str, Any]) -> None:
        self.form = dict(payload.get("form") or {})
        self.updated_at = int(payload.get("updatedAt") or self.updated_at)
        if payload.get("name"):
            self.name = payload["name"]

    def _on_ParamSetDeleted(self, payload: dict[str, Any]) -> None:
        self.deleted = True

    def _on_ParamSetRestored(self, payload: dict[str, Any]) -> None:
        self.deleted = False


class GenerationJob(AggregateRoot):
    aggregate_type = "GenerationJob"

    def __init__(self, aggregate_id: str):
        super().__init__(aggregate_id)
        self.source = "studio"
        self.status = "queued"
        self.payload: dict[str, Any] = {}
        self.client: dict[str, Any] = {}
        self.progress: dict[str, Any] = {}
        self.items: list[dict[str, Any]] = []
        self.meta: dict[str, Any] = {}
        self.error: str | None = None
        self.subscription: dict[str, Any] | None = None
        self.preview_hash: str | None = None
        self.created_at = 0
        self.started_at: int | None = None
        self.finished_at: int | None = None
        self.cancel_requested = False

    def queue(self, data: dict[str, Any]):
        if self.version > 0:
            raise DomainError("任务已存在", 409)
        self.record("JobQueued", data)

    def start(self, started_at: int):
        if self.status == "cancelled" or self.cancel_requested:
            return
        self.record("JobStarted", {"startedAt": started_at})

    def preview(self, sample: int, step, blob_hash: str | None, text: str):
        self.record(
            "JobPreviewed",
            {"sample": sample, "step": step, "previewHash": blob_hash, "text": text},
        )

    def complete(self, items: list[dict[str, Any]], meta: dict[str, Any], subscription, finished_at: int):
        self.record(
            "JobCompleted",
            {"items": items, "meta": meta, "subscription": subscription, "finishedAt": finished_at},
        )

    def fail(self, error: str, finished_at: int):
        self.record("JobFailed", {"error": error, "finishedAt": finished_at})

    def cancel(self, finished_at: int):
        if self.status in {"done", "error", "cancelled"}:
            return
        self.record("JobCancelled", {"finishedAt": finished_at})

    def _on_JobQueued(self, payload: dict[str, Any]) -> None:
        self.source = payload.get("source") or "studio"
        self.status = "queued"
        self.payload = dict(payload.get("payload") or {})
        self.client = dict(payload.get("client") or {})
        self.progress = dict(payload.get("progress") or {})
        self.created_at = int(payload.get("createdAt") or 0)

    def _on_JobStarted(self, payload: dict[str, Any]) -> None:
        self.status = "running"
        self.started_at = int(payload["startedAt"])

    def _on_JobPreviewed(self, payload: dict[str, Any]) -> None:
        self.preview_hash = payload.get("previewHash")
        self.progress = {
            **self.progress,
            "step": payload.get("step"),
            "sample": payload.get("sample"),
            "text": payload.get("text") or "生成中",
        }

    def _on_JobCompleted(self, payload: dict[str, Any]) -> None:
        self.status = "done"
        self.items = list(payload.get("items") or [])
        self.meta = dict(payload.get("meta") or {})
        self.subscription = payload.get("subscription")
        self.finished_at = int(payload["finishedAt"])
        self.progress = {**self.progress, "text": "完成"}

    def _on_JobFailed(self, payload: dict[str, Any]) -> None:
        self.status = "error"
        self.error = payload.get("error")
        self.finished_at = int(payload["finishedAt"])
        self.progress = {**self.progress, "text": "失败"}

    def _on_JobCancelled(self, payload: dict[str, Any]) -> None:
        self.status = "cancelled"
        self.cancel_requested = True
        self.error = "已取消"
        self.finished_at = int(payload["finishedAt"])
        self.progress = {**self.progress, "text": "已取消"}
