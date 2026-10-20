//! 抽奖算法对照：fixtures/lottery_draws.json 由 Python 版生成（见 py_draw_fixture.py）。
//! 同样的种子和池子，Rust 必须抽出完全相同的画师串，并且随机数序列也走到同一个位置。

use serde_json::Value;
use workbench_lib::contexts::lottery::algorithm::{draw_from_pool, pool_hash, DrawParams};
use workbench_lib::pyrandom::PyRandom;

/// 数值按 f64 比较：Python 里偶尔是 int（如 1）而 Rust 一律是 f64，只影响存储的写法，不影响抽奖结果。
fn same(a: &Value, b: &Value, path: &str) {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            assert!((x - y).abs() < 1e-9, "{path}: {x} != {y}");
        }
        (Value::Object(x), Value::Object(y)) => {
            let kx: std::collections::BTreeSet<_> = x.keys().collect();
            let ky: std::collections::BTreeSet<_> = y.keys().collect();
            assert_eq!(kx, ky, "{path}: 键不一致");
            for (k, v) in x {
                same(v, &y[k], &format!("{path}.{k}"));
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            assert_eq!(x.len(), y.len(), "{path}: 长度不一致");
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                same(p, q, &format!("{path}[{i}]"));
            }
        }
        _ => assert_eq!(a, b, "{path}"),
    }
}

#[test]
fn draws_match_python() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/lottery_draws.json")).expect("读取 fixture");
    let pool: Vec<Value> = fixture["pool"].as_array().unwrap().clone();
    assert_eq!(pool_hash(&pool), fixture["poolHash"].as_str().unwrap(), "pool_hash 不一致");

    for (i, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
        let f = |k: &str| case[k].as_f64();
        let fixed: Vec<Value> = case
            .get("fixed")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|ix| pool[ix.as_u64().unwrap() as usize].clone()).collect())
            .unwrap_or_default();
        let params = DrawParams {
            fixed,
            n: f("n"),
            count: f("count"),
            jitter: f("jitter").unwrap_or(0.0),
            boost: f("boost").unwrap_or(0.0),
            target: f("target"),
            min_weight: f("minWeight"),
            max_weight: f("maxWeight"),
        };
        let mut rng = PyRandom::new(case["seed"].as_i64().unwrap());
        let draws = draw_from_pool(&pool, &params, &mut rng);
        let expected = case["draws"].as_array().unwrap();
        assert_eq!(draws.len(), expected.len(), "case {i}: 抽出的条数不一致");
        for (j, (got, want)) in draws.iter().zip(expected).enumerate() {
            assert_eq!(got["outputText"], want["outputText"], "case {i} draw {j}: outputText 不一致");
            same(got, want, &format!("case{i}.draw{j}"));
        }
        let next = rng.random();
        assert!((next - case["next"].as_f64().unwrap()).abs() < 1e-15, "case {i}: 随机数位置不一致");
    }
}
