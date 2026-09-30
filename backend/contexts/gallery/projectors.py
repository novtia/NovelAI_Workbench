from __future__ import annotations

import json
import sqlite3
from typing import Any

from contexts.gallery.rules import album_kind
from kernel.events import StoredEvent
from kernel.bus import Projector


class GalleryProjector(Projector):
    def handle(self, event: StoredEvent, conn: sqlite3.Connection) -> None:
        p = event.payload
        t = event.event_type
        if t == "AlbumRegistered":
            conn.execute(
                """
                INSERT INTO projections_albums (id, name, created_at, sort_order, deleted, version)
                VALUES (?, ?, ?, ?, 0, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name, created_at=excluded.created_at,
                    sort_order=excluded.sort_order, deleted=0, version=excluded.version
                """,
                (event.aggregate_id, p["name"], p["createdAt"], p["order"], event.version),
            )
        elif t == "AlbumRenamed":
            conn.execute(
                "UPDATE projections_albums SET name=?, version=? WHERE id=?",
                (p["name"], event.version, event.aggregate_id),
            )
        elif t == "AlbumDeleted":
            conn.execute(
                "UPDATE projections_albums SET deleted=1, version=? WHERE id=?",
                (event.version, event.aggregate_id),
            )
        elif t == "AlbumRestored":
            conn.execute(
                "UPDATE projections_albums SET deleted=0, version=? WHERE id=?",
                (event.version, event.aggregate_id),
            )
        elif t == "ArtworkImported":
            conn.execute(
                """
                INSERT INTO projections_artworks (
                    id, album_id, added_at, name, mime, size, hash, thumb_hash,
                    width, height, artists, artist_line, params, deleted, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(id) DO UPDATE SET
                    album_id=excluded.album_id, added_at=excluded.added_at, name=excluded.name,
                    mime=excluded.mime, size=excluded.size, hash=excluded.hash,
                    thumb_hash=excluded.thumb_hash, width=excluded.width, height=excluded.height,
                    artists=excluded.artists, artist_line=excluded.artist_line,
                    params=excluded.params, deleted=0, version=excluded.version
                """,
                (
                    event.aggregate_id,
                    p["albumId"],
                    p["addedAt"],
                    p.get("name") or "image",
                    p.get("mime"),
                    p.get("size"),
                    p["blobHash"],
                    p.get("thumbHash") or "",
                    p.get("width"),
                    p.get("height"),
                    json.dumps(p.get("artists") or [], ensure_ascii=False),
                    p.get("artistLine") or "",
                    json.dumps(p.get("params") or {}, ensure_ascii=False),
                    event.version,
                ),
            )
        elif t == "GalleryViewSelected":
            conn.execute(
                """
                INSERT INTO projections_gallery_view (id, album_id, test_set_id, preset_id, version)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    album_id=excluded.album_id, test_set_id=excluded.test_set_id,
                    preset_id=excluded.preset_id, version=excluded.version
                """,
                (
                    event.aggregate_id,
                    p.get("albumId") or "",
                    p.get("testSetId") or "",
                    p.get("presetId") or "",
                    event.version,
                ),
            )
        elif t == "ArtistBasketAdded":
            for item in p.get("items") or []:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO projections_artist_basket (key, name, added_at, sort_order)
                    VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM projections_artist_basket))
                    """,
                    (item["key"], item["name"], p.get("addedAt") or 0),
                )
        elif t == "ArtistBasketRemoved":
            conn.execute("DELETE FROM projections_artist_basket WHERE key=?", (p.get("key") or "",))
        elif t == "ArtistBasketCleared":
            conn.execute("DELETE FROM projections_artist_basket")
        elif t == "ArtworkMoved":
            conn.execute(
                "UPDATE projections_artworks SET album_id=?, version=? WHERE id=?",
                (p["albumId"], event.version, event.aggregate_id),
            )
        elif t == "ArtworkDeleted":
            conn.execute(
                "UPDATE projections_artworks SET deleted=1, version=? WHERE id=?",
                (event.version, event.aggregate_id),
            )
        elif t == "ArtworkRestored":
            conn.execute(
                "UPDATE projections_artworks SET deleted=0, version=? WHERE id=?",
                (event.version, event.aggregate_id),
            )


def album_row(row: sqlite3.Row, count: int | None = None) -> dict[str, Any]:
    kind = album_kind(row["id"], row["name"])
    out = {
        "id": row["id"],
        "name": row["name"],
        "createdAt": row["created_at"],
        "order": row["sort_order"],
        "deleted": bool(row["deleted"]),
        "version": row["version"],
    }
    if kind:
        out["kind"] = kind
    if count is not None:
        out["count"] = count
    return out


def artwork_row(row: sqlite3.Row) -> dict[str, Any]:
    thumb = row["thumb_hash"] or ""
    digest = row["hash"]
    return {
        "id": row["id"],
        "albumId": row["album_id"],
        "addedAt": row["added_at"],
        "name": row["name"],
        "mime": row["mime"],
        "size": row["size"],
        "hash": digest,
        "thumbHash": thumb,
        "width": row["width"],
        "height": row["height"],
        "artists": json.loads(row["artists"] or "[]"),
        "artistLine": row["artist_line"] or "",
        "params": json.loads(row["params"] or "{}"),
        "deleted": bool(row["deleted"]),
        "version": row["version"],
        "imageUrl": f"/api/blobs/{digest}",
        "thumbUrl": f"/api/blobs/{thumb or digest}",
    }
