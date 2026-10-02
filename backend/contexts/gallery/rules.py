from __future__ import annotations

import re
from typing import Any

SINGLE_ARTIST_ALBUM_ID = "single-artist"
SINGLE_ARTIST_ALBUM_NAME = "单画师"
SINGLE_ARTIST_KIND = "singleArtist"
SINGLE_ARTIST_IMPORT_ERROR = "「单画师」收藏夹只接受含单个画师串的测试图"
TEST_SET_ID_PREFIX = "testset-"
TEST_SET_KIND = "testSet"

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


# 与前端 data/singleArtist.ts 的 ARTIST_RE 保持一致：`1.4::artist:x::`、`[artist:x]`、`artist:x`。
ARTIST_RE = re.compile(
    r"(\d+(?:\.\d+)?::)?\s*(?:\[artist:\s*([^\]]+?)\]|artist:\s*([^,\]\n]+?))(?:\s*::|(?=\s*,)|\s*$)",
    re.I,
)


def extract_artists(text: str) -> tuple[list[str], str]:
    """从 prompt 文本里抽出画师名（按 tag_key 去重、保序），并返回带权重的画师串。"""
    names: list[str] = []
    chunks: list[str] = []
    seen: set[str] = set()
    for m in ARTIST_RE.finditer(text or ""):
        name = re.sub(r"\s+", " ", (m.group(2) or m.group(3) or "").strip())
        key = tag_key(name)
        if not name or not key or key in seen:
            continue
        seen.add(key)
        names.append(name)
        weight = (m.group(1) or "").strip()
        chunks.append(f"{weight}artist:{name}::" if weight else f"artist:{name}")
    return names, ", ".join(chunks)


def is_test_set_id(album_id: str) -> bool:
    return str(album_id or "").startswith(TEST_SET_ID_PREFIX)


def album_kind(album_id: str, name: str) -> str | None:
    if is_test_set_id(album_id):
        return TEST_SET_KIND
    if album_id == SINGLE_ARTIST_ALBUM_ID or str(name or "").strip() == SINGLE_ARTIST_ALBUM_NAME:
        return SINGLE_ARTIST_KIND
    return None


def is_single_artist_album(album: dict[str, Any] | None) -> bool:
    if not album:
        return False
    return album_kind(str(album.get("id") or ""), str(album.get("name") or "")) == SINGLE_ARTIST_KIND


def is_test_set_album(album: dict[str, Any] | None) -> bool:
    if not album:
        return False
    return album_kind(str(album.get("id") or ""), str(album.get("name") or "")) == TEST_SET_KIND
