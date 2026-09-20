from __future__ import annotations

from typing import Any

from kernel.events import AggregateRoot


class Credential(AggregateRoot):
    aggregate_type = "Credential"

    def __init__(self, aggregate_id: str = "nai"):
        super().__init__(aggregate_id)
        self.configured = False
        self.hint = ""

    def set_hint(self, hint: str):
        self.record("CredentialSet", {"hint": hint})

    def clear(self):
        if not self.configured and self.version == 0:
            self.record("CredentialCleared", {})
            return
        self.record("CredentialCleared", {})

    def _on_CredentialSet(self, payload: dict[str, Any]) -> None:
        self.configured = True
        self.hint = payload.get("hint") or "已保存"

    def _on_CredentialCleared(self, payload: dict[str, Any]) -> None:
        self.configured = False
        self.hint = ""
