from __future__ import annotations

import re
from random import Random
from typing import Any

SCALE = 100
ARTIST_PREFIX = re.compile(r"^artist\s*:\s*", re.I)


def fmt2(cents: int) -> str:
    return f"{cents / SCALE:.2f}"


def clean_tag(raw: str) -> str:
    return re.sub(r"^[:：\s]+", "", re.sub(r"[:：\s]+$", "", raw)).strip()


def strip_artist(tag: str) -> str:
    t = str(tag or "")
    while ARTIST_PREFIX.search(t):
        t = ARTIST_PREFIX.sub("", t)
    return t.strip()


def tag_key(tag: str) -> str:
    return re.sub(r"[_\s]+", " ", strip_artist(tag).lower()).strip()


def format_tags(tags: list[str]) -> str:
    prefixed = any(ARTIST_PREFIX.search(t) for t in tags)
    bare = [strip_artist(t) for t in tags if strip_artist(t)]
    if not bare:
        return ""
    return ("artist:" if prefixed else "") + ", ".join(bare)


def pad_numeric_closers(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        body = match.group(2).rstrip()
        if re.search(r"\d$", body):
            body = f"{body} "
        return f"{match.group(1)}::{body}::"

    return re.sub(r"(-?\d*\.?\d+)\s*::\s*([\s\S]*?)\s*::", repl, str(text or ""))


def split_tags(chunk: str) -> list[str]:
    return [clean_tag(p) for p in re.split(r"[,，\n\r]+", chunk) if clean_tag(p)]


def parse_entries(text: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    block = re.compile(r"(-?\d*\.?\d+)\s*::\s*([\s\S]*?)\s*::")
    cursor = 0
    src = str(text or "")

    def push_loose(chunk: str) -> None:
        for piece in re.split(r"[,，\n\r]+", chunk):
            open_m = re.match(r"^(-?\d*\.?\d+)\s*::\s*(.+)$", piece.strip())
            if open_m:
                tag = clean_tag(open_m.group(2))
                if tag:
                    entries.append({"weight": float(open_m.group(1)), "tags": [tag], "hadWeight": True})
                continue
            tag = clean_tag(piece)
            if tag:
                entries.append({"weight": 1, "tags": [tag], "hadWeight": False})

    for m in block.finditer(src):
        push_loose(src[cursor : m.start()])
        tags = split_tags(m.group(2))
        if tags:
            entries.append({"weight": float(m.group(1)), "tags": tags, "hadWeight": True})
        cursor = m.end()
    push_loose(src[cursor:])
    return entries


def effective_of(weight: float, boost: float) -> float:
    return weight * (1 + boost) if weight > 1 else weight


def personal_cap(per_max_cents: list[int | None] | None, i: int) -> int | None:
    if not per_max_cents:
        return None
    v = per_max_cents[i]
    if v is None:
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if n != n or n < 0:
        return None
    return round(n)


def allocate(effectives, units, target, min_cents, max_cents, per_max_cents):
    n = len(effectives)
    target_cents = round(target * SCALE)
    active = [w > 0 for w in effectives]
    billed_units = 0
    for i, u in enumerate(units):
        if not active[i] or personal_cap(per_max_cents, i) == 0:
            continue
        billed_units += u
    floor = 1 if min_cents is None else max(1, round(min_cents))
    cap = target_cents if max_cents is None else max(floor, round(max_cents))
    if billed_units > 0 and floor * billed_units > target_cents:
        floor = max(1, target_cents // billed_units)
    if billed_units > 0 and cap * billed_units < target_cents:
        cap = max(floor, -(-target_cents // billed_units))
    if not n:
        return {"cents": [], "ideal": []}

    caps = []
    for i in range(n):
        if not active[i]:
            caps.append(0)
            continue
        hard = personal_cap(per_max_cents, i)
        caps.append(cap if hard is None else max(0, min(hard, cap)))
    floors = [min(floor, caps[i]) if active[i] else 0 for i in range(n)]

    max_possible = sum(caps[i] * units[i] for i in range(n))
    if max_possible < target_cents:
        free = [i for i in range(n) if active[i] and personal_cap(per_max_cents, i) is None]
        need = target_cents - max_possible
        guard_raise = 0
        while need > 0 and free and guard_raise < 100000:
            guard_raise += 1
            progressed = False
            for i in free:
                if need <= 0:
                    break
                if units[i] > need:
                    continue
                caps[i] += 1
                need -= units[i]
                progressed = True
            if not progressed:
                break

    total = sum(w * units[i] for i, w in enumerate(effectives))
    if total <= 0:
        return {"cents": [0] * n, "ideal": [0] * n}

    ideal = [(target_cents * w) / total for w in effectives]
    cents = [
        min(caps[i], max(floors[i], int(ideal[i] + 1e-9))) if active[i] else 0
        for i in range(n)
    ]

    def used() -> int:
        return sum(cents[i] * units[i] for i in range(n))

    leftover = target_cents - used()
    guard = 0
    while leftover > 0 and guard < 100000:
        guard += 1
        pick = -1
        best_frac = float("-inf")
        for i in range(n):
            if units[i] > leftover or not active[i] or cents[i] >= caps[i]:
                continue
            frac = ideal[i] - cents[i]
            if frac > best_frac:
                best_frac = frac
                pick = i
        if pick < 0:
            break
        cents[pick] += 1
        leftover -= units[pick]

    while leftover < 0 and guard < 100000:
        guard += 1
        pick = -1
        best_frac = float("inf")
        for i in range(n):
            if units[i] > -leftover:
                continue
            if cents[i] <= floors[i]:
                continue
            frac = ideal[i] - cents[i]
            if frac < best_frac:
                best_frac = frac
                pick = i
        if pick < 0:
            break
        cents[pick] -= 1
        leftover += units[pick]

    return {"cents": cents, "ideal": ideal}


def assemble(entries, effectives, units, target, min_cents, max_cents, per_max_cents):
    allocated = allocate(effectives, units, target, min_cents, max_cents, per_max_cents)
    cents = allocated["cents"]
    rows = []
    for i, e in enumerate(entries):
        rows.append(
            {
                "tags": e["tags"],
                "count": len(e["tags"]),
                "unit": units[i],
                "weight": e["weight"],
                "cents": cents[i],
            }
        )
    new_cents = sum(r["cents"] * r["unit"] for r in rows)
    target_cents = round(target * SCALE)
    artist_count = sum(r["count"] for r in rows)
    output_text = pad_numeric_closers(
        ", ".join(f"{fmt2(r['cents'])}::{format_tags(r['tags'])}::" for r in rows)
    )
    return {
        "rows": rows,
        "outputText": output_text,
        "newCents": new_cents,
        "targetCents": target_cents,
        "diffCents": target_cents - new_cents,
        "artistCount": artist_count,
    }


def shuffle(rng: Random, arr: list) -> list:
    a = list(arr)
    for i in range(len(a) - 1, 0, -1):
        j = rng.randrange(i + 1)
        a[i], a[j] = a[j], a[i]
    return a


def fit_weight_bounds(n: int, target: float, min_weight, max_weight):
    t = float(target)
    lo = float(min_weight) if min_weight is not None else 0.01
    hi = float(max_weight) if max_weight is not None else t
    if lo != lo or lo < 0.01:
        lo = 0.01
    if hi != hi or hi < 0.01:
        hi = t
    if lo > hi:
        lo, hi = hi, lo
    size = max(1, n)
    if size * lo > t:
        lo = t / size
    if size * hi < t:
        hi = t / size
    if lo > hi:
        hi = lo
    return lo, hi


def draw_from_pool(pool: list[dict], params: dict, rng: Random) -> list[dict]:
    def key_of(p: dict) -> str:
        return tag_key(p.get("tag") or p.get("name") or p.get("key") or "")

    seen: set[str] = set()
    locked: list[dict] = []
    for p in params.get("fixed") or []:
        k = key_of(p)
        if not k or k in seen:
            continue
        seen.add(k)
        locked.append(p)
    rest = [p for p in (pool or []) if key_of(p) and key_of(p) not in seen]
    if not locked and not rest:
        return []
    want = max(round(params.get("n") or 1) or 1, 1)
    size = min(max(want, len(locked)), len(locked) + len(rest))
    if size <= 0:
        return []
    extra = max(0, size - len(locked))
    draws = min(max(round(params.get("count") or 1) or 1, 1), 50)
    jit = min(max(params.get("jitter") or 0, 0), 1)
    b = max(params.get("boost") or 0, 0)
    t = float(params.get("target"))
    if t != t or t <= 0:
        return []
    lo, hi = fit_weight_bounds(size, t, params.get("minWeight"), params.get("maxWeight"))
    min_cents = max(1, round(lo * SCALE))
    max_cents = max(min_cents, round(hi * SCALE))

    out = []
    for _ in range(draws):
        picked = locked + shuffle(rng, rest)[:extra] if extra > 0 else list(locked)
        entries = [
            {
                "weight": p.get("weight") if (p.get("weight") or 0) > 0 else 1,
                "tags": [f"artist:{strip_artist(p.get('tag') or p.get('name'))}"],
                "hadWeight": True,
            }
            for p in picked
        ]
        units = [1] * len(entries)
        rolled = []
        for e in entries:
            w = effective_of(e["weight"], b)
            factor = 1 - jit + rng.random() * jit * 2
            rolled.append(max(w * factor, 0.01))
        per_max = []
        for p in picked:
            if p.get("maxWeight") is None:
                per_max.append(None)
                continue
            try:
                cap = float(p["maxWeight"])
            except (TypeError, ValueError):
                per_max.append(None)
                continue
            if cap != cap or cap < 0:
                per_max.append(None)
            else:
                per_max.append(max(0, round(cap * SCALE)))
        assembled = assemble(entries, rolled, units, t, min_cents, max_cents, per_max)
        assembled["artists"] = [strip_artist(p.get("tag") or p.get("name")) for p in picked]
        out.append(assembled)
    return out


def pool_hash(pool: list[dict]) -> str:
    from kernel.hashes import canonical_json, sha256_text

    keys = sorted({tag_key(p.get("tag") or p.get("name") or "") for p in pool if p})
    return sha256_text(canonical_json(keys))
