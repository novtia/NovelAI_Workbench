"""对比两个库里某个 JSON 列的内容差异（精确到路径）。

    python py_diff_json.py <库 A> <库 B> <表> <列>
"""
from __future__ import annotations

import json
import sqlite3
import sys


def walk(a, b, path, out):
    if type(a) is not type(b):
        out.append((path, a, b))
    elif isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append((f"{path}.{k}", a.get(k, "<缺失>"), b.get(k, "<缺失>")))
            else:
                walk(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append((f"{path}[len]", len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)):
            walk(x, y, f"{path}[{i}]", out)
    elif a != b:
        out.append((path, a, b))


def main() -> None:
    pa, pb, table, col = sys.argv[1:5]
    ca, cb = sqlite3.connect(pa), sqlite3.connect(pb)
    ra = {r[0]: r[1] for r in ca.execute(f"SELECT id, {col} FROM {table}")}
    rb = {r[0]: r[1] for r in cb.execute(f"SELECT id, {col} FROM {table}")}
    shown = 0
    for key in ra:
        if ra[key] == rb.get(key):
            continue
        out: list = []
        walk(json.loads(ra[key]), json.loads(rb[key]), "", out)
        print(f"== {key}: {len(out)} 处不同，文本{'相同' if ra[key] == rb[key] else '不同'}")
        for path, x, y in out[:8]:
            print(f"   {path}: A={x!r} B={y!r}")
        shown += 1
        if shown >= 4:
            break


if __name__ == "__main__":
    main()
