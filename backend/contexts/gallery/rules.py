from __future__ import annotations

import re
from typing import Any

SINGLE_ARTIST_ALBUM_ID = "single-artist"
SINGLE_ARTIST_ALBUM_NAME = "单画师"
SINGLE_ARTIST_KIND = "singleArtist"
SINGLE_ARTIST_IMPORT_ERROR = "「单画师」收藏夹只接受含单个画师串的测试图"

ARTIST_PREFIX = re.compile(r"^artist\s*:\s*", re.I)


def strip_artist(tag: str) -> str:
    t = str(tag or "")
    while ARTIST_PREFIX.search(t):
        t = ARTIST_PREFIX.sub("", t)
    return t.strip()


def tag_key(tag: str) -> str:
    return re.sub(r"[_\s]+", " ", strip_artist(tag).lower()).strip()


def unique_artist_keys(artists: Any) -> list[str]:
    keys: list[str] = []
    seen: set[str] = set()
    if not isinstance(artists, list):
        return keys
    for raw in artists:
        key = tag_key(str(raw))
        if not key or key in seen:
            continue
        seen.add(key)
        keys.append(key)
    return keys


def album_kind(album_id: str, name: str) -> str | None:
    if album_id == SINGLE_ARTIST_ALBUM_ID or str(name or "").strip() == SINGLE_ARTIST_ALBUM_NAME:
        return SINGLE_ARTIST_KIND
    return None


def is_single_artist_album(album: dict[str, Any] | None) -> bool:
    if not album:
        return False
    return album_kind(str(album.get("id") or ""), str(album.get("name") or "")) == SINGLE_ARTIST_KIND
