//! 对应 Python 的 test_artist_basket.py / test_single_artist.py / test_test_sets.py。

mod common;

use common::{bare, boot, err, ids, import, names, png};
use serde_json::{json, Value};
use workbench_lib::contexts::gallery::application::{ensure_default_album, ensure_single_artist_album};
use workbench_lib::contexts::gallery::rules::{SINGLE_ARTIST_ALBUM_ID, SINGLE_ARTIST_ALBUM_NAME, TEST_SET_ID_PREFIX};
use workbench_lib::kernel::integrity::rebuild_projections;

fn strs(v: &[&str]) -> Value {
    json!(v)
}

// ---------- 画师篮 ----------

#[test]
fn basket_add_dedupes_and_keeps_order() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    assert!(g.basket().unwrap().is_empty());
    let out = g.basket_add(&strs(&["artist:hiro_(dismaless)", "foo", "Hiro (dismaless)", "  ", "artist:artist:bar"])).unwrap();
    assert_eq!(names(&out), ["hiro_(dismaless)", "foo", "bar"]);
    // 再次添加已有的（大小写 / 下划线 / 前缀不同）不会重复
    let out = g.basket_add(&strs(&["FOO", "artist:hiro (dismaless)", "baz"])).unwrap();
    assert_eq!(names(&out), ["hiro_(dismaless)", "foo", "bar", "baz"]);
}

#[test]
fn basket_add_multiple_artists_in_one_call() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let out = svc.gallery.basket_add(&strs(&["a", "b", "c"])).unwrap();
    let keys: Vec<_> = out.iter().map(|i| i["key"].as_str().unwrap().to_string()).collect();
    assert_eq!(keys, ["a", "b", "c"]);
    assert!(out.iter().all(|i| i["addedAt"].as_i64().unwrap() > 0));
}

#[test]
fn basket_remove_and_clear() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    g.basket_add(&strs(&["a", "b", "c"])).unwrap();
    assert_eq!(names(&g.basket_remove("B").unwrap()), ["a", "c"]);
    assert_eq!(names(&g.basket_remove("not-there").unwrap()), ["a", "c"]);
    // 移除后可以再次加入，排到最后
    assert_eq!(names(&g.basket_add(&strs(&["b"])).unwrap()), ["a", "c", "b"]);
    assert!(g.basket_clear().unwrap().is_empty());
    assert!(g.basket_clear().unwrap().is_empty());
}

#[test]
fn basket_survives_projection_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    g.basket_add(&strs(&["a", "b", "c"])).unwrap();
    g.basket_remove("b").unwrap();
    g.basket_add(&strs(&["d"])).unwrap();
    let before = g.basket().unwrap();
    rebuild_projections(&svc.kernel.store, &svc.kernel.projectors).unwrap();
    assert_eq!(g.basket().unwrap(), before);
    assert_eq!(names(&before), ["a", "c", "d"]);
}

// ---------- 单画师收藏夹 ----------

#[test]
fn single_artist_ensure_reuses_existing_named_album() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    let created = g.create_album("单画师", Some("legacy-uuid"), true, false).unwrap();
    assert_eq!(created["kind"], "singleArtist");
    assert_eq!(created["id"], "legacy-uuid");
    ensure_single_artist_album(g).unwrap();
    let albums: Vec<_> = g.list_albums(false).unwrap().into_iter().filter(|a| a["kind"] == "singleArtist").collect();
    assert_eq!(albums.len(), 1);
    assert_eq!(albums[0]["id"], created["id"]);
}

#[test]
fn single_artist_ensure_creates_reserved_id() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    ensure_default_album(g).unwrap();
    ensure_single_artist_album(g).unwrap();
    let album = g.find_single_artist_album(false).unwrap().expect("应该已创建");
    assert_eq!(album["id"], SINGLE_ARTIST_ALBUM_ID);
    assert_eq!(album["name"], SINGLE_ARTIST_ALBUM_NAME);
    assert_eq!(album["kind"], "singleArtist");
    ensure_single_artist_album(g).unwrap();
    assert_eq!(g.list_albums(false).unwrap().iter().filter(|a| a["kind"] == "singleArtist").count(), 1);
}

#[test]
fn system_album_cannot_be_renamed_or_deleted_or_duplicated() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    ensure_single_artist_album(g).unwrap();
    let album = g.find_single_artist_album(false).unwrap().unwrap();
    let id = album["id"].as_str().unwrap();
    assert!(err(g.rename_album(id, "别的名字")).contains("不可重命名"));
    assert!(err(g.delete_album(id)).contains("不可删除"));
    let other = g.create_album("普通夹", None, false, false).unwrap();
    assert!(err(g.rename_album(other["id"].as_str().unwrap(), SINGLE_ARTIST_ALBUM_NAME)).contains("系统收藏夹名称"));
    assert!(err(g.create_album(SINGLE_ARTIST_ALBUM_NAME, None, false, false)).contains("系统收藏夹"));
}

#[test]
fn single_artist_import_requires_one_artist() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    ensure_single_artist_album(g).unwrap();
    let album_id = g.find_single_artist_album(false).unwrap().unwrap()["id"].as_str().unwrap().to_string();
    assert!(err(import(&svc, &album_id, &png(1), json!({"name": "a.png", "artists": []}))).contains("单个画师串"));
    assert!(
        err(import(&svc, &album_id, &png(2), json!({"name": "b.png", "artists": ["hiro_(dismaless)", "foo"]})))
            .contains("单个画师串")
    );
    let first = import(
        &svc,
        &album_id,
        &png(3),
        json!({"name": "c.png", "artists": ["hiro_(dismaless)"], "artistLine": "artist:hiro_(dismaless)"}),
    )
    .unwrap();
    let second =
        import(&svc, &album_id, &png(4), json!({"name": "d.png", "artists": ["artist:hiro_(dismaless)"]})).unwrap();
    assert_eq!(first["albumId"], json!(album_id));
    assert_eq!(second["artists"], json!(["artist:hiro_(dismaless)"]));

    let other = g.create_album("普通夹", None, false, false).unwrap();
    let other_id = other["id"].as_str().unwrap();
    let multi = import(&svc, other_id, &png(5), json!({"name": "e.png", "artists": ["a", "b"]})).unwrap();
    assert!(err(g.move_item(multi["id"].as_str().unwrap(), &album_id)).contains("单个画师串"));
    g.move_item(first["id"].as_str().unwrap(), other_id).unwrap();
    assert_eq!(g.get_item(first["id"].as_str().unwrap(), false).unwrap().unwrap()["albumId"], json!(other_id));
}

#[test]
fn reimport_after_delete_or_clear() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    let album_id = g.create_album("单画师", Some(SINGLE_ARTIST_ALBUM_ID), true, false).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let meta = json!({"name": "a.png", "artists": ["foo"]});
    let first = import(&svc, &album_id, &png(7), meta.clone()).unwrap();
    g.delete_item(first["id"].as_str().unwrap()).unwrap();
    // 删除后再导入同一张图：不能因为旧事件的幂等键而静默失败
    let second = import(&svc, &album_id, &png(7), meta.clone()).unwrap();
    assert_ne!(second["id"], first["id"]);
    g.clear_album(&album_id).unwrap();
    let third = import(&svc, &album_id, &png(7), meta).unwrap();
    assert!(third["id"] != first["id"] && third["id"] != second["id"]);
    assert_eq!(ids(&g.list_items(&album_id, false, None, 0, "added_desc").unwrap()), [third["id"].as_str().unwrap()]);
}

// ---------- 测试集 ----------

#[test]
fn test_set_id_prefix_and_kind() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let created = svc.gallery.create_test_set("预设A").unwrap();
    assert!(created["id"].as_str().unwrap().starts_with(TEST_SET_ID_PREFIX));
    assert_eq!(created["kind"], "testSet");
    assert_eq!(created["count"], 0);
}

#[test]
fn test_set_name_rules() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    let first = g.create_test_set("预设A").unwrap();
    assert!(err(g.create_test_set("预设A")).contains("同名"));
    assert!(err(g.create_test_set(SINGLE_ARTIST_ALBUM_NAME)).contains("系统收藏夹名称"));
    let second = g.create_test_set("预设B").unwrap();
    assert!(err(g.rename_album(second["id"].as_str().unwrap(), "预设A")).contains("同名"));
    let renamed = g.rename_album(first["id"].as_str().unwrap(), "预设C").unwrap();
    assert_eq!(renamed["name"], "预设C");
}

#[test]
fn public_create_album_rejects_test_set_id() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let id = format!("{TEST_SET_ID_PREFIX}abc");
    err(svc.gallery.create_album("x", Some(&id), false, false));
}

#[test]
fn test_sets_do_not_count_as_regular_albums() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    g.create_test_set("预设A").unwrap();
    assert_eq!(g.active_album_count().unwrap(), 0);
    ensure_default_album(g).unwrap();
    assert_eq!(g.active_album_count().unwrap(), 1);
    let only_test = g.create_test_set("预设B").unwrap();
    assert!(err(g.delete_album("default")).contains("至少保留"));
    let id = only_test["id"].as_str().unwrap();
    g.delete_album(id).unwrap();
    assert_eq!(g.get_album(id).unwrap().unwrap()["deleted"], json!(true));
}

#[test]
fn test_set_requires_single_artist() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let album = svc.gallery.create_test_set("预设A").unwrap();
    let id = album["id"].as_str().unwrap();
    assert!(err(import(&svc, id, &png(1), json!({"name": "a.png", "artists": ["a", "b"]}))).contains("单个画师串"));
    let item = import(&svc, id, &png(2), json!({"name": "b.png", "artists": ["a"]})).unwrap();
    assert_eq!(item["albumId"], json!(id));
}

#[test]
fn gallery_job_completion_binds_into_test_set() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    ensure_single_artist_album(g).unwrap();
    let album = g.create_test_set("预设A").unwrap();
    let id = album["id"].as_str().unwrap();
    let digest = svc.kernel.blobs.put(&png(7)).unwrap();
    let client = json!({
        "testSetId": id,
        "testIndex": 3,
        "artists": ["hiro"],
        "artistLine": "artist:hiro",
        "form": {"prompt": "1girl", "steps": 28},
    });
    let items = [json!({"blobHash": digest})];
    let saved = svc.generation.bind_test_set_items("gallery", &client, &items, &json!({}));
    assert_eq!(saved.len(), 1);
    let listed = g.list_items(id, false, None, 0, "added_desc").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["artists"], json!(["hiro"]));
    assert_eq!(listed[0]["params"]["testIndex"], 3);
    assert_eq!(listed[0]["params"]["prompt"], "artist:hiro, 1girl");
    // 同一张图重复完成不会重复绑定，也不会抛错
    assert!(svc.generation.bind_test_set_items("gallery", &client, &items, &json!({})).is_empty());
    assert_eq!(g.list_items(id, false, None, 0, "added_desc").unwrap().len(), 1);
}

#[test]
fn target_album_job_binds_straight_into_single_artist_album() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    ensure_single_artist_album(g).unwrap();
    let album = g.find_single_artist_album(false).unwrap().unwrap();
    let id = album["id"].as_str().unwrap();
    let digest = svc.kernel.blobs.put(&png(11)).unwrap();
    let client = json!({
        "targetAlbumId": id,
        "artists": ["new_artist"],
        "artistLine": "artist:new_artist",
        "form": {"prompt": "", "seed": -1},
    });
    let saved = svc.generation.bind_test_set_items("gallery", &client, &[json!({"blobHash": digest})], &json!({}));
    assert_eq!(saved.len(), 1);
    let listed = g.list_items(id, false, None, 0, "added_desc").unwrap();
    let artists: Vec<_> = listed.iter().map(|i| i["artists"].clone()).collect();
    assert_eq!(artists, [json!(["new_artist"])]);
    assert!(listed[0]["params"].get("testSetId").is_none());
}

#[test]
fn bound_image_keeps_generation_meta_with_characters() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    ensure_single_artist_album(g).unwrap();
    let album = g.create_test_set("预设B").unwrap();
    let id = album["id"].as_str().unwrap();
    let digest = svc.kernel.blobs.put(&png(9)).unwrap();
    let client = json!({
        "testSetId": id,
        "testIndex": 0,
        "artists": ["hiro"],
        "artistLine": "artist:hiro",
        "form": {"prompt": "1girl", "seed": -1, "characters": [{"prompt": "girl, solo", "uc": "", "x": 0.5, "y": 0.5}]},
    });
    let gen_meta = json!({
        "prompt": "artist:hiro, 1girl",
        "seed": 123456,
        "v4Prompt": {"caption": {"base_caption": "artist:hiro, 1girl", "char_captions": [{"char_caption": "girl, solo", "centers": [{"x": 0.5, "y": 0.5}]}]}},
        "v4Negative": {"caption": {"base_caption": "lowres", "char_captions": [{"char_caption": "", "centers": [{"x": 0.5, "y": 0.5}]}]}},
    });
    svc.generation.bind_test_set_items("gallery", &client, &[json!({"blobHash": digest})], &gen_meta);
    let params = g.list_items(id, false, None, 0, "added_desc").unwrap()[0]["params"].clone();
    assert_eq!(params["seed"], 123456);
    assert_eq!(params["v4Prompt"]["caption"]["char_captions"][0]["char_caption"], "girl, solo");
    // 测试集自己的记录不被覆盖
    assert_eq!(params["testSetId"], json!(id));
    assert_eq!(params["testIndex"], 0);
}

#[test]
fn other_sources_are_not_bound() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let album = svc.gallery.create_test_set("预设A").unwrap();
    let id = album["id"].as_str().unwrap();
    let digest = svc.kernel.blobs.put(&png(8)).unwrap();
    let items = [json!({"blobHash": digest})];
    let client = json!({"testSetId": id, "artists": ["hiro"], "artistLine": "artist:hiro"});
    assert!(svc.generation.bind_test_set_items("lottery", &client, &items, &json!({})).is_empty());
    assert!(svc.generation.bind_test_set_items("gallery", &json!({}), &items, &json!({})).is_empty());
    assert!(svc.gallery.list_items(id, false, None, 0, "added_desc").unwrap().is_empty());
}

#[test]
fn gallery_view_selection_is_persisted_in_database() {
    let dir = tempfile::tempdir().unwrap();
    let svc = bare(dir.path());
    let g = &svc.gallery;
    ensure_single_artist_album(g).unwrap();
    let empty = g.view().unwrap();
    assert_eq!((empty["albumId"].as_str(), empty["testSetId"].as_str(), empty["presetId"].as_str()), (Some(""), Some(""), Some("")));
    let album = g.find_single_artist_album(false).unwrap().unwrap();
    let test_set = g.create_test_set("预设A").unwrap();
    let ts_id = test_set["id"].as_str().unwrap();
    let saved = g.select_view(&json!({"albumId": album["id"], "testSetId": ts_id, "presetId": "p1"})).unwrap();
    assert_eq!(saved["albumId"], album["id"]);
    assert_eq!(saved["testSetId"], json!(ts_id));
    assert_eq!(saved["presetId"], "p1");
    // 只改一项时，其它保持
    assert_eq!(g.select_view(&json!({"presetId": "p2"})).unwrap()["testSetId"], json!(ts_id));
    // 事件重放重建投影后仍在
    rebuild_projections(&svc.kernel.store, &svc.kernel.projectors).unwrap();
    let again = g.view().unwrap();
    assert!(again["testSetId"] == json!(ts_id) && again["presetId"] == "p2");
    // 切回「无」也会持久化
    assert_eq!(g.select_view(&json!({"testSetId": ""})).unwrap()["testSetId"], "");
    // 选中的测试集被删除后，不会再返回它
    g.select_view(&json!({"testSetId": ts_id})).unwrap();
    g.delete_album(ts_id).unwrap();
    assert_eq!(g.view().unwrap()["testSetId"], "");
}

#[test]
fn promote_extracts_artists_from_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let svc = boot(dir.path());
    let digest = svc.kernel.blobs.put(&png(7)).unwrap();
    let prompt = "1.40::artist:ge_tianzun::, 0.35::artist:nnk_(nongnong)::, [artist:foo bar], 1girl";
    let items = svc.generation.promote("default", &[digest], &json!({"prompt": prompt, "name": "nai.png"})).unwrap();
    assert_eq!(items[0]["artists"], json!(["ge_tianzun", "nnk_(nongnong)", "foo bar"]));
    assert!(items[0]["artistLine"].as_str().unwrap().starts_with("1.40::artist:ge_tianzun::"));
    // 已经带画师列表的不被覆盖
    let digest2 = svc.kernel.blobs.put(&png(8)).unwrap();
    let items = svc.generation.promote("default", &[digest2], &json!({"prompt": prompt, "artists": ["solo"]})).unwrap();
    assert_eq!(items[0]["artists"], json!(["solo"]));
}
