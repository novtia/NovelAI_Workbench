from __future__ import annotations

from contexts.gallery.application import GalleryService
from contexts.gallery.domain import Album
from kernel.clock import now_ms


def migrate_legacy(service: GalleryService, legacy_data) -> dict:
    from pathlib import Path
    import json
    import sqlite3

    legacy_data = Path(legacy_data)
    db_path = legacy_data / "gallery.db"
    images = legacy_data / "images"
    thumbs = legacy_data / "thumbs"
    if not db_path.is_file():
        return {"imported": 0, "albums": 0, "skipped": True}
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    albums = conn.execute("SELECT * FROM albums ORDER BY sort_order, created_at").fetchall()
    items = conn.execute("SELECT * FROM items ORDER BY added_at").fetchall()
    conn.close()
    album_n = 0
    item_n = 0
    skipped = 0
    for row in albums:
        command_id = f"legacy:album:{row['id']}"
        if service.uow.store.events_for_command(command_id):
            album_n += 1
            continue
        try:
            album = service.uow.load(Album, row["id"])
            album.register(row["name"], int(row["created_at"]), int(row["sort_order"]), command_id=command_id)
            service.uow.commit(album, command_id=command_id)
            album_n += 1
        except Exception:
            skipped += 1
    for row in items:
        command_id = f"legacy:item:{row['id']}"
        if service.uow.store.events_for_command(command_id):
            item_n += 1
            continue
        image_path = images / row["id"]
        if not image_path.is_file():
            skipped += 1
            continue
        data = image_path.read_bytes()
        thumb = None
        thumb_path = thumbs / row["id"]
        if thumb_path.is_file():
            thumb = thumb_path.read_bytes()
        meta = {
            "id": row["id"],
            "name": row["name"],
            "addedAt": int(row["added_at"] or now_ms()),
            "width": row["width"],
            "height": row["height"],
            "artists": json.loads(row["artists"] or "[]"),
            "artistLine": row["artist_line"] or "",
            "params": json.loads(row["params"] or "{}"),
        }
        try:
            service.import_bytes(
                row["album_id"], data, meta, thumb=thumb, command_id=command_id, item_id=row["id"]
            )
            item_n += 1
        except Exception:
            skipped += 1
    return {"imported": item_n, "albums": album_n, "skipped": skipped}
