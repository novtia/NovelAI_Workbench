from __future__ import annotations

import sqlite3

from kernel.bus import Projector
from kernel.events import StoredEvent


class IdentityProjector(Projector):
    def handle(self, event: StoredEvent, conn: sqlite3.Connection) -> None:
        if event.event_type == "CredentialSet":
            conn.execute(
                """
                INSERT INTO projections_identity (id, configured, hint, version)
                VALUES (?, 1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET configured=1, hint=excluded.hint, version=excluded.version
                """,
                (event.aggregate_id, event.payload.get("hint") or "", event.version),
            )
        elif event.event_type == "CredentialCleared":
            conn.execute(
                """
                INSERT INTO projections_identity (id, configured, hint, version)
                VALUES (?, 0, '', ?)
                ON CONFLICT(id) DO UPDATE SET configured=0, hint='', version=excluded.version
                """,
                (event.aggregate_id, event.version),
            )
