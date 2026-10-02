from __future__ import annotations

from typing import Any

from contexts.settings.schema import SCHEMA, clean_patch, defaults, normalize
from kernel.events import AggregateRoot

SETTINGS_ID = "app-settings"


def apply_change(data: dict[str, dict[str, Any]], event_type: str, payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """聚合与投影共用的纯函数，保证重放结果一致。"""
    out = normalize(data)
    if event_type == "SettingsUpdated":
        for section, part in clean_patch(payload.get("patch")).items():
            out[section].update(part)
    elif event_type == "SettingsReset":
        section = payload.get("section")
        if isinstance(section, str) and section in SCHEMA:
            out[section] = defaults()[section]
        else:
            out = defaults()
    return out


class AppSettings(AggregateRoot):
    """全局设置：一个聚合，事件只记录变更的字段，重放后得到当前设置。"""

    aggregate_type = "AppSettings"

    def __init__(self, aggregate_id: str = SETTINGS_ID):
        super().__init__(aggregate_id)
        self.data = defaults()

    def update(self, patch: Any) -> bool:
        cleaned = clean_patch(patch)
        # 只记录真正变化的字段
        changed: dict[str, dict[str, Any]] = {}
        for section, part in cleaned.items():
            diff = {k: v for k, v in part.items() if self.data[section].get(k) != v}
            if diff:
                changed[section] = diff
        if not changed:
            return False
        self.record("SettingsUpdated", {"patch": changed})
        return True

    def reset(self, section: str | None = None) -> bool:
        target = section if section in SCHEMA else None
        fresh = defaults()
        if target:
            if self.data[target] == fresh[target]:
                return False
        elif self.data == fresh:
            return False
        self.record("SettingsReset", {"section": target})
        return True

    def _on_SettingsUpdated(self, payload: dict[str, Any]) -> None:
        self.data = apply_change(self.data, "SettingsUpdated", payload)

    def _on_SettingsReset(self, payload: dict[str, Any]) -> None:
        self.data = apply_change(self.data, "SettingsReset", payload)
