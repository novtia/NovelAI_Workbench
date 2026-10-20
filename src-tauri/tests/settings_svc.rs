//! 对应 Python 的 test_settings.py（设置服务、投影重放、相册排序、缩略图尺寸）。

mod common;

use common::{bare, err, import, png};
use serde_json::{json, Value};
use std::sync::Arc;
use workbench_lib::contexts::settings::schema::{defaults, py_eq, SCHEMA};
use workbench_lib::kernel::integrity::{projection_checksum, rebuild_projections};

fn settings_of(v: &Value) -> &Value {
    &v["settings"]
}

#[test]
fn defaults_when_nothing_saved() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let data = svc.settings.public();
    assert_eq!(data["version"], 0);
    assert_eq!(data["settings"], defaults());
    assert_eq!(data["settings"]["generation"]["concurrency"], 1);
}

#[test]
fn update_clamps_and_drops_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let out = svc
        .settings
        .update(&json!({
            "appearance": {"theme": "dark", "toastMs": 500000, "font": "comic", "bogus": 1},
            "generation": {"steps": "abc", "concurrency": 9, "model": "nope"},
            "gallery": {"pageSize": 200, "thumbQuality": 1},
            "nonsense": {"a": 1},
        }))
        .unwrap();
    let out = settings_of(&out);
    assert_eq!(out["appearance"]["theme"], "dark");
    assert_eq!(out["appearance"]["toastMs"], 10000);
    assert_eq!(out["appearance"]["font"], "serif");
    assert!(out["appearance"].get("bogus").is_none());
    assert_eq!(out["generation"]["steps"], 28); // 非法值回到默认
    assert_eq!(out["generation"]["concurrency"], 3);
    assert_eq!(out["generation"]["model"], "nai-diffusion-5-full");
    assert_eq!(out["gallery"]["pageSize"], 200);
    assert_eq!(out["gallery"]["thumbQuality"], 40);
    assert!(out.get("nonsense").is_none());
}

#[test]
fn bool_and_choice_type_strictness() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let out = svc
        .settings
        .update(&json!({"appearance": {"liveInk": "yes", "reduceMotion": true}, "gallery": {"pageSize": "100"}}))
        .unwrap();
    let out = settings_of(&out);
    assert_eq!(out["appearance"]["liveInk"], true);
    assert_eq!(out["appearance"]["reduceMotion"], true);
    assert_eq!(out["gallery"]["pageSize"], 0);
}

#[test]
fn text_and_seed_settings_are_validated() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let out = svc
        .settings
        .update(&json!({"artistTest": {"prompt": "x".repeat(5000), "character": 5, "seed": 99999999999i64, "steps": 30, "quality": "bogus"}}))
        .unwrap();
    let out = &settings_of(&out)["artistTest"];
    assert_eq!(out["prompt"].as_str().unwrap().chars().count(), 2000);
    assert_eq!(out["character"], "girl, solo"); // 非字符串回到默认
    assert_eq!(out["seed"], 4294967295u64);
    assert_eq!(out["steps"], 30);
    assert_eq!(out["quality"], "gallery");
    let cleared = svc.settings.update(&json!({"artistTest": {"prompt": ""}})).unwrap();
    assert_eq!(settings_of(&cleared)["artistTest"]["prompt"], "");
}

#[test]
fn noop_update_writes_no_event() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    svc.settings.update(&json!({"appearance": {"theme": "dark"}})).unwrap();
    let before = svc.kernel.store.load_all().unwrap().len();
    svc.settings.update(&json!({"appearance": {"theme": "dark"}})).unwrap();
    svc.settings.update(&json!({"appearance": {}})).unwrap();
    assert_eq!(svc.kernel.store.load_all().unwrap().len(), before);
}

#[test]
fn reset_section_and_all() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    svc.settings.update(&json!({"appearance": {"theme": "dark"}, "gallery": {"density": "compact"}})).unwrap();
    let out = svc.settings.reset(Some("appearance")).unwrap();
    assert_eq!(settings_of(&out)["appearance"]["theme"], "light");
    assert_eq!(settings_of(&out)["gallery"]["density"], "compact");
    let out = svc.settings.reset(None).unwrap();
    // 按 Python 的 == 比较：重置回来的 5.0 和默认值 5 是同一个数
    assert!(py_eq(settings_of(&out), &defaults()), "{out}");
    err(svc.settings.reset(Some("nope")));
}

#[test]
fn replace_imports_whole_document() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    svc.settings.update(&json!({"appearance": {"theme": "dark"}, "gallery": {"density": "compact"}})).unwrap();
    let out = svc.settings.replace(&json!({"gallery": {"thumbSize": 600}})).unwrap();
    let out = settings_of(&out);
    assert_eq!(out["gallery"]["thumbSize"], 600);
    assert_eq!(out["gallery"]["density"], "comfortable");
    assert_eq!(out["appearance"]["theme"], "light");
    err(svc.settings.replace(&json!([])));
}

#[test]
fn projection_replays_identically_after_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let s = &svc.settings;
    s.update(&json!({"appearance": {"theme": "auto", "toastMs": 4000}, "lottery": {"draws": 12, "jitter": 0.25}})).unwrap();
    s.update(&json!({"generation": {"steps": 35}})).unwrap();
    s.reset(Some("appearance")).unwrap();
    let k = &svc.kernel;
    let before = projection_checksum(&k.store).unwrap();
    let snapshot = s.public()["settings"].clone();
    rebuild_projections(&k.store, &k.projectors).unwrap();
    assert_eq!(projection_checksum(&k.store).unwrap(), before);
    // 空补丁不写事件，只让服务重新从投影读一遍（等价于 Python 的 invalidate）
    let reloaded = s.update(&json!({})).unwrap();
    assert_eq!(settings_of(&reloaded), &snapshot);
    assert_eq!(snapshot["lottery"]["draws"], 12);
    assert_eq!(snapshot["generation"]["steps"], 35);
    assert_eq!(snapshot["appearance"]["theme"], "light");
}

#[test]
fn schema_defaults_are_valid() {
    for (section, keys) in SCHEMA.iter() {
        for (key, spec) in keys {
            assert!(py_eq(&spec.coerce(&spec.default), &spec.default), "{section}.{key}");
        }
    }
}

#[test]
fn gallery_list_items_sort_and_paging() {
    let dir = tempfile::tempdir().unwrap();
    let svc = common::boot(dir.path());
    let album = svc.gallery.list_albums(false).unwrap()[0]["id"].as_str().unwrap().to_string();
    let mut made = Vec::new();
    for i in 1..=3u8 {
        made.push(import(&svc, &album, &png(i), json!({"name": format!("{i}.png")})).unwrap()["id"].as_str().unwrap().to_string());
    }
    let list = |sort: &str| -> Vec<String> {
        svc.gallery.list_items(&album, false, None, 0, sort).unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()).collect()
    };
    let desc = list("added_desc");
    let asc = list("added_asc");
    assert_eq!(asc, desc.iter().rev().cloned().collect::<Vec<_>>());
    let mut sorted = asc.clone();
    sorted.sort();
    made.sort();
    assert_eq!(sorted, made);
    assert_eq!(svc.gallery.list_items(&album, false, Some(2), 0, "added_desc").unwrap().len(), 2);
    assert_eq!(svc.gallery.list_items(&album, false, Some(2), 2, "added_desc").unwrap().len(), 1);
}

#[test]
fn thumb_provider_controls_size() {
    use image::GenericImageView;
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let big = common::png_image((900, 600));
    let blobs = &svc.kernel.blobs;
    blobs.set_thumb_provider(Arc::new(|| (200, 50)));
    let small = image::load_from_memory(&blobs.thumb(&big).expect("缩略图")).unwrap();
    let (w, h) = small.dimensions();
    assert_eq!(w.max(h), 200);
    blobs.set_thumb_provider(Arc::new(|| (600, 90)));
    let large = image::load_from_memory(&blobs.thumb(&big).expect("缩略图")).unwrap();
    let (w, h) = large.dimensions();
    assert_eq!(w.max(h), 600);
}

#[test]
fn system_info_reports_data_dir_and_events() {
    let dir = tempfile::tempdir().unwrap();
    let svc = common::boot(dir.path());
    let info = svc.settings.system_info(dir.path(), &svc.kernel.blobs).unwrap();
    assert!(info["events"].as_i64().unwrap() >= 1, "{info}");
    assert!(info.get("dataDir").is_some());
}
