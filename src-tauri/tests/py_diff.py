"""逐表逐行对比两个库的投影表（排查 golden 差异用）。

    python py_diff.py <库 A> <库 B>
"""
from __future__ import annotations

import json
import sqlite3
import sys

TABLES = [
    "projections_albums",
    "projections_artworks",
    "projections_gallery_view",
    "projections_artist_basket",
    "projections_lottery_board",
    "projections_lottery_batches",
    "projections_jobs",
    "projections_param_sets",
    "projections_credentials",
    "projections_settings",
]


def rows(path: str, table: str):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return {str(r[0]): dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY 1")}
    except sqlite3.Error as exc:
        return {"__error__": {"error": str(exc)}}


def main() -> None:
    a_path, b_path = sys.argv[1], sys.argv[2]
    conn = sqlite3.connect(a_path)
    names = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'projections_%'")]
    for table in sorted(names):
        a, b = rows(a_path, table), rows(b_path, table)
        only_a = sorted(set(a) - set(b))
        only_b = sorted(set(b) - set(a))
        diff = [k for k in a if k in b and a[k] != b[k]]
        print(f"{table}: A={len(a)} B={len(b)} onlyA={len(only_a)} onlyB={len(only_b)} diff={len(diff)}")
        for key in diff[:3]:
            for col in a[key]:
                if a[key][col] != b[key].get(col):
                    print(f"  [{key}] {col}:")
                    print(f"    A: {str(a[key][col])[:300]!r}")
                    print(f"    B: {str(b[key].get(col))[:300]!r}")


if __name__ == "__main__":
    main()
