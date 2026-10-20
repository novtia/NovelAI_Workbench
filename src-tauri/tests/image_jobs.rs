//! 对应 Python 的 test_image_jobs.py。

mod common;

use common::{boot, err, png_image};
use std::path::Path;
use image::ImageFormat;
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use workbench_lib::app::Services;
use workbench_lib::contexts::generation::domain::GenerationJob;
use workbench_lib::kernel::integrity::{rebuild_projections, verify_all};

/// 入队前会检查 Token 是否已配置（对应 Python 测试里的 FakeVault）。
fn booted(dir: &Path) -> Services {
    let svc = boot(dir);
    svc.generation.vault.save("pst-test-token");
    svc
}

fn upload(svc: &Services, size: (u32, u32)) -> String {
    svc.generation.store_upload(&png_image(size)).unwrap()["blobHash"].as_str().unwrap().to_string()
}

#[test]
fn upload_converts_non_png_and_reports_size() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let rec = svc.generation.store_upload(&common::image((300, 200), ImageFormat::Jpeg)).unwrap();
    assert_eq!((rec["width"].as_i64(), rec["height"].as_i64()), (Some(300), Some(200)));
    let data = svc.kernel.blobs.get(rec["blobHash"].as_str().unwrap()).unwrap();
    assert_eq!(&data[..8], b"\x89PNG\r\n\x1a\n");
}

#[test]
fn upload_rejects_garbage_and_empty() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    err(svc.generation.store_upload(b""));
    err(svc.generation.store_upload(b"not an image"));
}

#[test]
fn enqueue_upscale_records_target_size_without_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let digest = upload(&svc, (832, 1216));
    let job = svc.generation.enqueue(&json!({"kind": "upscale", "imageHash": digest, "scale": 4})).unwrap();
    assert_eq!(job["progress"]["kind"], "upscale");
    // 官方 /ai/upscale 固定 2 倍，scale 不再影响尺寸。
    assert_eq!((job["progress"]["width"].as_i64(), job["progress"]["height"].as_i64()), (Some(1664), Some(2432)));
    assert_eq!(job["progress"]["nSamples"], 1);
}

#[test]
fn upscale_defaults_to_2x() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let digest = upload(&svc, (832, 1216));
    let job = svc.generation.enqueue(&json!({"kind": "upscale", "imageHash": digest})).unwrap();
    assert_eq!((job["progress"]["width"].as_i64(), job["progress"]["height"].as_i64()), (Some(1664), Some(2432)));
}

#[test]
fn enqueue_enhance_max_plans_official_size() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let digest = upload(&svc, (832, 1216));
    let job = svc
        .generation
        .enqueue(&json!({"kind": "enhance", "imageHash": digest, "upscaleAmount": "max", "prompt": "1girl", "nSamples": 4}))
        .unwrap();
    assert_eq!((job["progress"]["width"].as_i64(), job["progress"]["height"].as_i64()), (Some(1467), Some(2144)));
    assert_eq!(job["progress"]["nSamples"], 1);
}

#[test]
fn enqueue_validates_image_and_mask() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let digest = upload(&svc, (500, 700));
    err(svc.generation.enqueue(&json!({"kind": "nonsense", "prompt": "x"})));
    err(svc.generation.enqueue(&json!({"kind": "img2img", "prompt": "x"})));
    err(svc.generation.enqueue(&json!({"kind": "img2img", "prompt": "x", "imageHash": "0".repeat(64)})));
    err(svc.generation.enqueue(&json!({"kind": "infill", "prompt": "x", "imageHash": digest})));
    let ok = svc
        .generation
        .enqueue(&json!({"kind": "infill", "prompt": "x", "imageHash": digest, "maskHash": digest}))
        .unwrap();
    assert_eq!(ok["progress"]["kind"], "infill");
    assert_eq!((ok["progress"]["width"].as_i64(), ok["progress"]["height"].as_i64()), (Some(512), Some(704)));
}

#[test]
fn prepare_request_reads_blobs() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let digest = upload(&svc, (500, 700));
    let mask = upload(&svc, (500, 700));
    let (payload, meta) = svc
        .generation
        .prepare_request(&json!({"kind": "infill", "prompt": "1girl", "seed": 3, "imageHash": digest, "maskHash": mask, "model": "nai-diffusion-5-full"}))
        .unwrap();
    assert_eq!(payload["action"], "infill");
    assert!(payload["model"].as_str().unwrap().ends_with("-inpainting"));
    assert_eq!(meta["sourceHash"], json!(digest));
    let missing = svc.generation.prepare_request(&json!({"kind": "img2img", "prompt": "x", "imageHash": "f".repeat(64)}));
    assert_eq!(missing.unwrap_err().status, 404);
}

#[test]
fn generate_kind_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let job = svc.generation.enqueue(&json!({"prompt": "1girl", "nSamples": 2})).unwrap();
    assert_eq!(job["progress"]["kind"], "generate");
    assert_eq!(job["progress"]["nSamples"], 2);
    assert!(job["progress"].get("width").is_none());
}

#[test]
fn enqueue_variation_forces_three_samples_and_keeps_source() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let digest = upload(&svc, (832, 1216));
    let job = svc
        .generation
        .enqueue(&json!({"kind": "variation", "imageHash": digest, "prompt": "1girl", "nSamples": 1, "seed": 5}))
        .unwrap();
    assert_eq!(job["progress"]["kind"], "variation");
    assert_eq!(job["progress"]["nSamples"], 3);
    assert_eq!(job["progress"]["sourceHash"], json!(digest));
    assert_eq!((job["progress"]["width"].as_i64(), job["progress"]["height"].as_i64()), (Some(832), Some(1216)));
}

#[test]
fn prepare_variation_is_img2img_with_random_seed() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let digest = upload(&svc, (832, 1216));
    let (payload, meta) = svc
        .generation
        .prepare_request(&json!({"kind": "variation", "imageHash": digest, "prompt": "1girl", "seed": 5}))
        .unwrap();
    assert_eq!(payload["action"], "img2img");
    assert_eq!(payload["parameters"]["n_samples"], 3);
    assert_eq!(payload["parameters"]["strength"].as_f64(), Some(0.6));
    assert_eq!(meta["requestType"], "variation");
    assert_eq!(meta["sourceHash"], json!(digest));
}

#[test]
fn estimate_matches_official_screenshot() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let cost = svc.generation.estimate(&json!({"width": 832, "height": 1216, "steps": 28}));
    assert_eq!(cost["variation"], 36);
    assert_eq!(cost["upscale"], 1);
    assert_eq!(cost["estimated"], true);
    assert!(cost["enhance"].as_i64().unwrap() >= 2);
}

#[test]
fn enhance_cost_matches_official_button() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let enhance = |steps: i64, magnitude: i64, amount: &str| -> i64 {
        svc.generation
            .estimate(&json!({"width": 832, "height": 1216, "steps": steps, "magnitude": magnitude, "upscaleAmount": amount, "opus": true}))["enhance"]
            .as_i64()
            .unwrap()
    };
    // 官方 832x1216、Opus：1x 全是 0；1.5x 与 Max 按强度 1~5 计价，不跟步数滑杆变。
    for steps in [20, 28] {
        for m in 1..=5 {
            assert_eq!(enhance(steps, m, "1x"), 0, "steps={steps} m={m}");
        }
    }
    let mid = [11, 21, 27, 32, 37];
    let high = [14, 27, 34, 41, 48];
    for steps in [20, 28] {
        let got_mid: Vec<i64> = (1..=5).map(|m| enhance(steps, m, "1.5x")).collect();
        let got_high: Vec<i64> = (1..=5).map(|m| enhance(steps, m, "max")).collect();
        assert_eq!(got_mid, mid, "steps={steps}");
        assert_eq!(got_high, high, "steps={steps}");
    }
}

#[test]
fn generate_estimate_respects_opus_free_image() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let g = |samples: i64, opus: bool, steps: i64| -> i64 {
        svc.generation
            .estimate(&json!({"genWidth": 832, "genHeight": 1216, "steps": steps, "genSamples": samples, "opus": opus}))["generate"]
            .as_i64()
            .unwrap()
    };
    let one = g(1, false, 28);
    assert!(one > 0);
    assert_eq!(g(1, true, 28), 0);
    assert_eq!(g(3, true, 28), one * 2);
    assert!(g(1, true, 40) > 0);
}

// ---------- 历史 ----------

fn stamp(svc: &Services, job_id: &str, created: i64) {
    let conn = svc.kernel.store.connect().unwrap();
    conn.execute("UPDATE projections_jobs SET created_at=?1 WHERE id=?2", params![created, job_id]).unwrap();
}

fn finish(svc: &Services, source: &str, created: i64, with_items: bool) -> String {
    let job = svc.generation.enqueue(&json!({"prompt": "1girl", "source": source})).unwrap();
    let id = job["id"].as_str().unwrap().to_string();
    let mut agg: GenerationJob = svc.kernel.load(&id).unwrap();
    if with_items {
        agg.complete(
            json!([{"id": "shot", "blobHash": "ab".repeat(32), "width": 832, "height": 1216}]),
            json!({"prompt": "1girl", "seed": 7, "width": 832, "height": 1216, "steps": 28, "sampler": "k_euler"}),
            Value::Null,
            created,
        );
    } else {
        agg.fail("失败", created);
    }
    svc.kernel.commit(&mut agg, None).unwrap();
    stamp(svc, &id, created);
    id
}

fn history_job_ids(page: &Value) -> Vec<String> {
    page["jobs"].as_array().unwrap().iter().map(|j| j["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn history_pages_past_jobs_keep_and_skips_other_sources() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    // 设置里「最近任务条数」最小是 20，所以造 24 条旧任务来越过它。
    svc.settings.update(&json!({"generation": {"jobsKeep": 20}})).unwrap();
    let older: Vec<String> = (0..24).map(|i| finish(&svc, "studio", 1000 + i, true)).collect();
    let same_a = finish(&svc, "studio", 2000, true);
    let same_b = finish(&svc, "studio", 2000, true);
    let lottery = finish(&svc, "lottery", 5000, true);
    let failed = finish(&svc, "studio", 6000, false);
    let queued = svc.generation.enqueue(&json!({"prompt": "wait", "source": "studio"})).unwrap();

    let listed: Vec<String> = svc.generation.list_jobs().unwrap().iter().map(|j| j["id"].as_str().unwrap().to_string()).collect();
    assert!(listed.contains(&queued["id"].as_str().unwrap().to_string()));
    assert!(listed.contains(&failed));
    assert!(!listed.contains(&older[0]), "越过 jobsKeep 的旧任务不该出现在最近任务里");

    let first = svc.generation.list_history(None, "", 2).unwrap();
    let mut same = vec![same_a.clone(), same_b.clone()];
    same.sort();
    same.reverse();
    assert_eq!(history_job_ids(&first), same);
    for j in first["jobs"].as_array().unwrap() {
        assert!(j["source"] == "studio" && j["status"] == "done" && !j["items"].as_array().unwrap().is_empty());
    }
    assert_eq!(first["jobs"][0]["items"][0]["url"], json!(format!("/api/blobs/{}", "ab".repeat(32))));
    assert!(!history_job_ids(&first).contains(&lottery));

    // 一页页翻到底：顺序是创建时间倒序（同一时刻按 id 倒序），失败 / 抽奖 / 排队的都不在里面。
    let mut seen = history_job_ids(&first);
    let mut page = first;
    let mut guard = 0;
    while !page["nextBefore"].is_null() {
        let before = page["nextBefore"].as_i64();
        let before_id = page["nextBeforeId"].as_str().unwrap().to_string();
        page = svc.generation.list_history(before, &before_id, 2).unwrap();
        assert!(history_job_ids(&page).len() <= 2);
        seen.extend(history_job_ids(&page));
        guard += 1;
        assert!(guard < 40, "翻页没有终点");
    }
    let mut expected = same;
    expected.extend(older.iter().rev().cloned());
    assert_eq!(seen, expected);
    assert!(page["nextBeforeId"].is_null());
}

fn finish_with_images(svc: &Services, source: &str, created: i64, sizes: &[(u32, u32)]) -> (String, Vec<Value>) {
    let job = svc.generation.enqueue(&json!({"prompt": "1girl", "source": source})).unwrap();
    let id = job["id"].as_str().unwrap().to_string();
    let items: Vec<Value> = sizes.iter().map(|s| svc.generation.store_image(&png_image(*s)).unwrap()).collect();
    let mut agg: GenerationJob = svc.kernel.load(&id).unwrap();
    agg.complete(Value::Array(items.clone()), json!({"prompt": "1girl", "seed": 7}), Value::Null, created);
    svc.kernel.commit(&mut agg, None).unwrap();
    stamp(svc, &id, created);
    (id, items)
}

fn history_map(svc: &Services) -> BTreeMap<String, Vec<String>> {
    let page = svc.generation.list_history(None, "", 100).unwrap();
    page["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|j| {
            let items = j["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()).collect();
            (j["id"].as_str().unwrap().to_string(), items)
        })
        .collect()
}

fn item_id(items: &[Value], i: usize) -> String {
    items[i]["id"].as_str().unwrap().to_string()
}

#[test]
fn delete_history_keeps_blobs_and_album_items() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let (job_a, items_a) = finish_with_images(&svc, "studio", 1000, &[(300, 400), (320, 420)]);
    let (job_b, items_b) = finish_with_images(&svc, "studio", 2000, &[(340, 440)]);
    let (job_lot, items_lot) = finish_with_images(&svc, "lottery", 3000, &[(360, 460)]);

    let saved_hash = items_a[0]["blobHash"].as_str().unwrap().to_string();
    svc.generation
        .promote("default", &[saved_hash.clone()], &json!({"prompt": "1girl", "name": "nai.png", "artists": ["x"]}))
        .unwrap();
    let before = svc.kernel.blobs.get(&saved_hash).unwrap();

    let refs = json!([
        {"jobId": job_a, "itemId": item_id(&items_a, 0)},
        {"jobId": job_lot, "itemId": item_id(&items_lot, 0)}, // 抽奖任务不属于历史，必须被忽略
        {"jobId": "nope", "itemId": "x"},
        {"jobId": job_a, "itemId": "not-there"},
    ]);
    assert_eq!(svc.generation.delete_history(&refs).unwrap(), 1);
    let expect: BTreeMap<String, Vec<String>> =
        [(job_b.clone(), vec![item_id(&items_b, 0)]), (job_a.clone(), vec![item_id(&items_a, 1)])].into_iter().collect();
    assert_eq!(history_map(&svc), expect);
    let lot = svc.generation.get_job(&job_lot).unwrap().unwrap();
    assert!(!lot["items"].as_array().unwrap().is_empty(), "抽奖任务的图不能被历史删除动到");

    // 收藏夹里的图和图片文件都还在，内容没变。
    assert!(svc.kernel.blobs.exists(&saved_hash));
    assert_eq!(svc.kernel.blobs.get(&saved_hash).unwrap(), before);
    let album_hashes: Vec<String> = svc
        .gallery
        .list_items("default", false, None, 0, "added_desc")
        .unwrap()
        .iter()
        .map(|i| i["hash"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(album_hashes, [saved_hash.clone()]);

    // 全删光的任务从历史里消失；重复删除是空操作。
    let gone = json!([{"jobId": job_b, "itemId": item_id(&items_b, 0)}]);
    assert_eq!(svc.generation.delete_history(&gone).unwrap(), 1);
    assert_eq!(svc.generation.delete_history(&gone).unwrap(), 0);
    assert!(!history_map(&svc).contains_key(&job_b));

    // 重建投影后删除结果仍然生效，事件和图片校验都通过。
    let expected = history_map(&svc);
    let k = &svc.kernel;
    rebuild_projections(&k.store, &k.projectors).unwrap();
    assert_eq!(history_map(&svc), expected);
    let report = verify_all(&k.store, &k.blobs, &k.projectors).unwrap();
    assert_eq!(report["ok"], json!(true), "{report}");
}
