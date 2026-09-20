from random import Random

from contexts.lottery.algorithm import draw_from_pool, pool_hash, tag_key
from contexts.lottery.domain import attach_job_previews, stamp_draw_ids


def test_draw_is_deterministic_with_seed():
    pool = [{"tag": "alpha", "weight": 1}, {"tag": "beta", "weight": 1}, {"tag": "gamma", "weight": 1}]
    params = {
        "n": 2,
        "target": 1,
        "boost": 0,
        "jitter": 0.4,
        "count": 3,
        "minWeight": 0.05,
        "maxWeight": 1,
        "fixed": [],
    }
    a = draw_from_pool(pool, params, Random(42))
    b = draw_from_pool(pool, params, Random(42))
    assert [d["outputText"] for d in a] == [d["outputText"] for d in b]
    assert a[0]["artistCount"] == 2
    assert pool_hash(pool) == pool_hash(list(reversed(pool)))
    assert tag_key("Artist: Foo_Bar") == "foo bar"


def test_per_card_n_uses_requested_size():
    pool = [{"tag": f"a{i}", "weight": 0.4 + i * 0.1} for i in range(8)]
    rng = Random(7)
    ns = []
    draws = []
    base = {
        "target": 1,
        "boost": 0.4,
        "jitter": 0.6,
        "count": 1,
        "minWeight": 0.05,
        "maxWeight": 1,
        "fixed": [],
    }
    for _ in range(6):
        n = rng.randint(3, 5)
        ns.append(n)
        draws.extend(draw_from_pool(pool, {**base, "n": n}, rng))
    assert [d["artistCount"] for d in draws] == ns
    assert len(set(ns)) >= 1


def test_stamp_draw_ids_is_stable_after_delete():
    draws = [{"outputText": "a"}, {"outputText": "b"}, {"outputText": "c"}]
    assert stamp_draw_ids(draws, "batch") is True
    assert [d["id"] for d in draws] == ["batch:0", "batch:1", "batch:2"]
    draws.pop(1)
    assert stamp_draw_ids(draws, "batch") is False
    assert [d["id"] for d in draws] == ["batch:0", "batch:2"]


def test_attach_job_previews_binds_by_draw_id():
    draws = [
        {"id": "batch:0", "outputText": "a"},
        {"id": "batch:2", "outputText": "c"},
    ]
    items = [{"id": "shot-c", "blobHash": "hash-c", "url": "/api/blobs/hash-c"}]
    assert attach_job_previews(draws, "batch", "job-1", {"drawId": "batch:2"}, items) is True
    assert "previews" not in draws[0]
    assert draws[1]["jobId"] == "job-1"
    assert draws[1]["previews"][0]["blobHash"] == "hash-c"
    assert attach_job_previews(draws, "batch", "job-2", {"drawId": "batch:2"}, items, only_if_empty=True) is False
    assert draws[1]["jobId"] == "job-1"
