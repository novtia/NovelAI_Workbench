from __future__ import annotations

import hashlib
import json
from typing import Any

GENESIS_HASH = "0" * 64


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def event_hash(prev_hash: str, body: dict[str, Any]) -> str:
    return sha256_text(f"{prev_hash}{canonical_json(body)}")
