from __future__ import annotations

import time
import uuid


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id() -> str:
    return str(uuid.uuid4())


def new_hex(n: int = 16) -> str:
    return uuid.uuid4().hex[:n]
