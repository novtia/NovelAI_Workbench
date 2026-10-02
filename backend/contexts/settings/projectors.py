from __future__ import annotations

import json
import sqlite3

from contexts.settings.domain import SETTINGS_ID, apply_change
from kernel.bus import Projector
from kernel.events import StoredEvent


class SettingsProjector(Projector):
    def handle(self, event: StoredEvent, conn: sqlite3.Connection) -> None:
        if event.aggregate_id != SETTINGS_ID or event.event_type not in ("SettingsUpdated", "SettingsReset"):
            return
        row = conn.execute("SELECT data_json FROM projections_settings WHERE id=?", (SETTINGS_ID,)).fetchone()
        try:
            current = json.loads(row["data_json"]) if row else {}
        except (TypeError, ValueError):
            current = {}
        data = apply_change(current, event.event_type, event.payload or {})
        conn.execute(
            """
            INSERT INTO projections_settings (id, data_json, version) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version
            """,
            (SETTINGS_ID, json.dumps(data, ensure_ascii=False, sort_keys=True), event.version),
        )
