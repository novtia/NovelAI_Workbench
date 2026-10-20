"""生成 tests/fixtures/lottery_draws.json：用 Python 版算法在合成画师池上抽若干组，作为 Rust 的对照。

用法（在 workbench/backend 下）：
    .venv\\Scripts\\python ..\\src-tauri\\tests\\py_draw_fixture.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from random import Random

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "backend"))

from contexts.lottery.algorithm import draw_from_pool, pool_hash  # noqa: E402


def make_pool() -> list[dict]:
    names = [
        "shinjiro", "magister", "kakuchou_no_okina", "mx2j", "quasarcake", "shiroi_yoru", "betabeet",
        "hews", "liduke", "hotate-chan", "pija_(pianiishimo)", "takeda_hiromatsu", "au_(d_elete)",
        "maabo_harusame", "96yottea", "hintobento", "ushikani_kassen", "wlop", "ciloranko", "sakimichan",
    ]
    weights = [0.5, 1.2, 0.5, 0.74, 1.3, 1.0, 0.83, 1.0, 1.1, 0.9, 1.0, 0.83, 1.0, 0.6, 1.4, 1.0, 1.0, 0.7, 1.25, 0.95]
    pool = []
    for i, (name, weight) in enumerate(zip(names, weights)):
        item = {"tag": name, "name": name, "key": name.replace("_", " "), "weight": weight}
        if i % 5 == 2:
            item["maxWeight"] = 0.8
        pool.append(item)
    return pool


CASES = [
    {"seed": 42, "n": 5, "count": 3, "target": 1, "boost": 0.4, "jitter": 0.6, "minWeight": 0.05, "maxWeight": 1},
    {"seed": 7, "n": 7, "count": 2, "target": 1.5, "boost": 0.0, "jitter": 0, "minWeight": 0.01, "maxWeight": 1.5},
    {"seed": 20260101, "n": 3, "count": 4, "target": 0.8, "boost": 0.4, "jitter": 1, "minWeight": 0.05, "maxWeight": 1},
    {"seed": 123456789, "n": 10, "count": 2, "target": 2, "boost": 0.7, "jitter": 0.3, "minWeight": 0.1, "maxWeight": 2},
    {"seed": 1, "n": 4, "count": 5, "target": 1, "boost": 0.4, "jitter": 0.6, "minWeight": 0.05, "maxWeight": 1, "fixed": [0, 3]},
]


def main() -> None:
    pool = make_pool()
    out = {"pool": pool, "poolHash": pool_hash(pool), "cases": []}
    for case in CASES:
        params = {k: v for k, v in case.items() if k not in ("seed", "fixed")}
        params["fixed"] = [pool[i] for i in case.get("fixed", [])]
        rng = Random(case["seed"])
        draws = draw_from_pool(pool, params, rng)
        out["cases"].append({**case, "draws": draws, "next": rng.random()})
    target = HERE / "fixtures" / "lottery_draws.json"
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("wrote", target, len(out["cases"]), "cases")


if __name__ == "__main__":
    main()
