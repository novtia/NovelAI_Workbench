//! 对应 Python 的 test_lottery.py（以及 test_settings.py 里抽奖面板默认值那一条）。

mod common;

use common::bare;
use serde_json::{json, Value};
use workbench_lib::contexts::lottery::algorithm::{draw_from_pool, pool_hash, tag_key, DrawParams};
use workbench_lib::contexts::lottery::domain::{attach_job_previews, default_controls, stamp_draw_ids};
use workbench_lib::pyrandom::PyRandom;

fn params(n: f64, count: f64, boost: f64, jitter: f64) -> DrawParams {
    DrawParams {
        fixed: vec![],
        n: Some(n),
        count: Some(count),
        jitter,
        boost,
        target: Some(1.0),
        min_weight: Some(0.05),
        max_weight: Some(1.0),
    }
}

fn texts(draws: &[Value]) -> Vec<String> {
    draws.iter().map(|d| d["outputText"].as_str().unwrap().to_string()).collect()
}

#[test]
fn draw_is_deterministic_with_seed() {
    let pool = vec![
        json!({"tag": "alpha", "weight": 1}),
        json!({"tag": "beta", "weight": 1}),
        json!({"tag": "gamma", "weight": 1}),
    ];
    let p = params(2.0, 3.0, 0.0, 0.4);
    let a = draw_from_pool(&pool, &p, &mut PyRandom::new(42));
    let b = draw_from_pool(&pool, &p, &mut PyRandom::new(42));
    assert_eq!(texts(&a), texts(&b));
    assert_eq!(a[0]["artistCount"], 2);
    let reversed: Vec<Value> = pool.iter().rev().cloned().collect();
    assert_eq!(pool_hash(&pool), pool_hash(&reversed));
    assert_eq!(tag_key("Artist: Foo_Bar"), "foo bar");
}

#[test]
fn per_card_n_uses_requested_size() {
    let pool: Vec<Value> = (0..8).map(|i| json!({"tag": format!("a{i}"), "weight": 0.4 + i as f64 * 0.1})).collect();
    let mut rng = PyRandom::new(7);
    let mut ns = Vec::new();
    let mut draws = Vec::new();
    for _ in 0..6 {
        let n = rng.randint(3, 5);
        ns.push(n);
        draws.extend(draw_from_pool(&pool, &params(n as f64, 1.0, 0.4, 0.6), &mut rng));
    }
    let counts: Vec<i64> = draws.iter().map(|d| d["artistCount"].as_i64().unwrap()).collect();
    assert_eq!(counts, ns);
}

#[test]
fn stamp_draw_ids_is_stable_after_delete() {
    let mut draws = vec![json!({"outputText": "a"}), json!({"outputText": "b"}), json!({"outputText": "c"})];
    assert!(stamp_draw_ids(&mut draws, "batch"));
    let ids = |d: &[Value]| d.iter().map(|x| x["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(ids(&draws), ["batch:0", "batch:1", "batch:2"]);
    draws.remove(1);
    assert!(!stamp_draw_ids(&mut draws, "batch"));
    assert_eq!(ids(&draws), ["batch:0", "batch:2"]);
}

#[test]
fn attach_job_previews_binds_by_draw_id() {
    let mut draws = vec![json!({"id": "batch:0", "outputText": "a"}), json!({"id": "batch:2", "outputText": "c"})];
    let items = json!([{"id": "shot-c", "blobHash": "hash-c", "url": "/api/blobs/hash-c"}]);
    let client = json!({"drawId": "batch:2"});
    assert!(attach_job_previews(&mut draws, "batch", "job-1", &client, &items, false));
    assert!(draws[0].get("previews").is_none());
    assert_eq!(draws[1]["jobId"], "job-1");
    assert_eq!(draws[1]["previews"][0]["blobHash"], "hash-c");
    assert!(!attach_job_previews(&mut draws, "batch", "job-2", &client, &items, true));
    assert_eq!(draws[1]["jobId"], "job-1");
}

/// 刚抽出来的批次必须能原样重放。串长有区间（min != max）时，重放要和抽奖一样先 randint 再抽。
#[test]
fn fresh_batch_verifies_with_variable_length() {
    let dir = tempfile::tempdir().unwrap();
    let svc = common::boot(dir.path());
    for i in 0..10u8 {
        let artist = format!("artist{i}");
        common::import(&svc, "default", &common::png(i), json!({"name": format!("{i}.png"), "artists": [artist.clone()], "artistLine": format!("artist:{artist}")})).unwrap();
    }
    let batch = svc
        .lottery
        .draw("default", &json!({"seed": 123, "controls": {"min": 2, "max": 4, "draws": 6}}))
        .unwrap();
    assert_eq!(batch["draws"].as_array().unwrap().len(), 6);
    let report = svc.lottery.verify(batch["id"].as_str().unwrap()).unwrap();
    assert_eq!(report["ok"], json!(true), "{report}");

    // 池子变了（多一个画师）：池哈希对不上，必须报失败
    common::import(&svc, "default", &common::png(99), json!({"name": "x.png", "artists": ["newcomer"], "artistLine": "artist:newcomer"})).unwrap();
    let report = svc.lottery.verify(batch["id"].as_str().unwrap()).unwrap();
    assert_eq!(report["poolHashMatch"], json!(false), "{report}");
    assert_eq!(report["ok"], json!(false));
}

#[test]
fn lottery_board_uses_settings_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let defaults = default_controls();
    let board = svc.lottery.board().unwrap();
    assert_eq!(board["controls"]["draws"], defaults["draws"]);
    svc.settings.update(&json!({"lottery": {"draws": 12, "min": 2}})).unwrap();
    let controls = svc.lottery.board().unwrap()["controls"].clone();
    assert!(controls["draws"] == 12 && controls["min"] == 2, "{controls}");
    for key in defaults.keys() {
        assert!(controls.get(key).is_some(), "缺少控制项 {key}");
    }
}
