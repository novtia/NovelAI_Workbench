//! 图片按来源分桶、删除时连文件一起清掉、整理存储的清单和实际结果一致。

mod common;

use common::{boot, png, png_image};
use serde_json::{json, Value};
use std::path::Path;
use workbench_lib::app::Services;
use workbench_lib::contexts::generation::domain::GenerationJob;
use workbench_lib::contexts::storage;
use workbench_lib::kernel::blobs::{Bucket, Slot};
use workbench_lib::kernel::bus::verify_chain;
use workbench_lib::kernel::clock::now_ms;
use workbench_lib::kernel::integrity::verify_all;

fn booted(dir: &Path) -> Services {
    let svc = boot(dir);
    svc.generation.vault.save("pst-test-token");
    svc
}

fn finish(svc: &Services, source: &str, client: Value, bytes: &[u8]) -> (String, Value) {
    let mut body = json!({"prompt": "1girl", "source": source});
    body["client"] = client.clone();
    let job = svc.generation.enqueue(&body).unwrap();
    let id = job["id"].as_str().unwrap().to_string();
    let bucket = Bucket::for_job(source, &client);
    let item = svc.generation.store_image(&bucket, bytes).unwrap();
    let mut agg: GenerationJob = svc.kernel.load(&id).unwrap();
    agg.complete(
        json!([item.clone()]),
        json!({"prompt": "1girl"}),
        Value::Null,
        now_ms(),
    );
    svc.kernel.commit(&mut agg, None).unwrap();
    (id, item)
}

fn assert_chain(svc: &Services) {
    let chain = verify_chain(&svc.kernel.store).unwrap();
    assert_eq!(chain["ok"], json!(true), "{chain}");
    let report = verify_all(&svc.kernel.store, &svc.kernel.blobs, &svc.kernel.projectors).unwrap();
    assert_eq!(report["ok"], json!(true), "{report}");
}

#[test]
fn favorite_copy_survives_history_delete_and_history_survives_favorite_delete() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let (job_id, item) = finish(&svc, "studio", json!({}), &png_image((80, 60)));
    let hash = item["blobHash"].as_str().unwrap().to_string();
    let studio = Slot::image(Bucket::Studio);
    let favorites = Slot::image(Bucket::Favorites("default".into()));
    svc.generation
        .promote(
            "default",
            &[hash.clone()],
            &json!({"prompt": "1girl", "name": "n.png", "artists": ["x"]}),
        )
        .unwrap();
    assert!(svc.kernel.blobs.has(&studio, &hash));
    assert!(svc.kernel.blobs.has(&favorites, &hash));

    let artwork = svc
        .gallery
        .list_items("default", false, None, 0, "added_desc")
        .unwrap();
    let artwork_id = artwork[0]["id"].as_str().unwrap().to_string();
    svc.gallery.delete_item(&artwork_id).unwrap();
    assert!(
        !svc.kernel.blobs.has(&favorites, &hash),
        "收藏夹的副本应该删掉"
    );
    assert!(svc.kernel.blobs.has(&studio, &hash), "历史里的原图还在");
    assert!(
        svc.generation.get_job(&job_id).unwrap().unwrap()["items"]
            .as_array()
            .unwrap()
            .len()
            == 1
    );

    svc.generation
        .delete_history(&json!([{"jobId": job_id, "itemId": item["id"]}]))
        .unwrap();
    assert!(svc.generation.get_job(&job_id).unwrap().is_none());
    assert!(!svc.kernel.blobs.has(&studio, &hash));
    assert!(!svc.kernel.blobs.exists(&hash));
    assert_chain(&svc);
}

#[test]
fn removing_a_lottery_draw_purges_its_image_and_keeps_the_chain() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    for i in 0..6u8 {
        let artist = format!("artist{i}");
        common::import(&svc, "default", &png(i), json!({"name": format!("{i}.png"), "artists": [artist.clone()], "artistLine": format!("artist:{artist}")})).unwrap();
    }
    let batch = svc
        .lottery
        .draw(
            "default",
            &json!({"seed": 7, "controls": {"min": 2, "max": 2, "draws": 2}}),
        )
        .unwrap();
    let batch_id = batch["id"].as_str().unwrap().to_string();
    let draws = batch["draws"].as_array().unwrap();
    assert_eq!(draws.len(), 2);
    let draw_id = draws[0]["id"].as_str().unwrap().to_string();
    let (job_id, item) = finish(
        &svc,
        "lottery",
        json!({"batchId": batch_id, "drawId": draw_id}),
        &png_image((48, 48)),
    );
    let hash = item["blobHash"].as_str().unwrap().to_string();
    let slot = Slot::image(Bucket::Lottery);
    assert!(svc.kernel.blobs.has(&slot, &hash));

    let left = svc.lottery.remove_draw(&batch_id, &draw_id).unwrap();
    assert_eq!(left["draws"].as_array().unwrap().len(), 1);
    assert!(
        svc.generation.get_job(&job_id).unwrap().is_none(),
        "这条串的出图任务应该被清掉"
    );
    assert!(!svc.kernel.blobs.has(&slot, &hash));
    assert_chain(&svc);

    let rest = left["draws"][0]["id"].as_str().unwrap().to_string();
    assert!(svc.lottery.remove_draw(&batch_id, &rest).unwrap().is_null());
    assert!(svc.lottery.get_batch(&batch_id, false).unwrap().is_none());
    assert_chain(&svc);
}

#[test]
fn migrate_matches_its_plan_and_drops_failed_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let svc = booted(dir.path());
    let failed = svc
        .generation
        .enqueue(&json!({"prompt": "1girl", "source": "studio"}))
        .unwrap();
    let failed_id = failed["id"].as_str().unwrap().to_string();
    let mut agg: GenerationJob = svc.kernel.load(&failed_id).unwrap();
    agg.fail("生成失败", now_ms());
    svc.kernel.commit(&mut agg, None).unwrap();

    let (job_id, item) = finish(&svc, "studio", json!({}), &png_image((40, 40)));
    let hash = item["blobHash"].as_str().unwrap().to_string();

    let preview = storage::plan(&svc.kernel, dir.path()).unwrap();
    let done = storage::migrate(&svc.kernel, dir.path()).unwrap();
    for key in [
        "aggregates",
        "events",
        "rewritten",
        "rehashed",
        "filesMoved",
        "filesCopied",
        "filesDeleted",
        "bytesFreed",
        "filesMissing",
        "previewsDeleted",
    ] {
        assert_eq!(preview[key], done[key], "{key}: 清单 {preview} 实际 {done}");
    }
    assert_eq!(done["verify"]["ok"], json!(true), "{done}");
    assert!(svc.generation.get_job(&failed_id).unwrap().is_none());
    assert!(svc.generation.get_job(&job_id).unwrap().is_some());
    assert!(svc.kernel.blobs.has(&Slot::image(Bucket::Studio), &hash));
    assert!(done["aggregates"].as_u64().unwrap() >= 1);
    assert_chain(&svc);
}
