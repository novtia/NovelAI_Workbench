//! 数据库导出 / 导入。
mod common;

use common::*;
use serde_json::json;
use workbench_lib::kernel::integrity::projection_checksum;
use workbench_lib::kernel::transfer::{export_db, export_pack, import_db};

fn album_names(svc: &workbench_lib::app::Services) -> Vec<String> {
    let albums = svc.gallery.list_albums(false).unwrap();
    let mut v: Vec<String> = albums.iter().map(|a| a["name"].as_str().unwrap_or("").to_string()).collect();
    v.sort();
    v
}

fn do_import(dst: &workbench_lib::app::Services, src: &std::path::Path) -> workbench_lib::kernel::Res<serde_json::Value> {
    import_db(&dst.kernel.store, &dst.kernel.blobs, &dst.kernel.projectors, &dst.data_dir, src, &|_, _, _| {})
}

#[test]
fn export_then_import_into_fresh_dir_reproduces_everything() {
    let a_dir = tempfile::tempdir().unwrap();
    let a = boot(a_dir.path());
    let album = a.gallery.create_album("导出测试", None, false, false).unwrap();
    let id = album["id"].as_str().unwrap().to_string();
    import(&a, &id, &png(1), json!({"name": "a.png"})).unwrap();
    import(&a, &id, &png(2), json!({"name": "b.png"})).unwrap();

    let out = a_dir.path().join("out").join("export.sqlite");
    let info = export_db(&a.kernel.store, &out).unwrap();
    assert!(out.is_file());
    assert!(info["events"].as_i64().unwrap() > 0);
    assert!(!out.with_extension("sqlite.part").exists(), "不应留下临时文件");
    let sum_a = projection_checksum(&a.kernel.store).unwrap();

    // 导入到另一个全新的数据目录（只有默认收藏夹），图片文件没有拷过去。
    let b_dir = tempfile::tempdir().unwrap();
    let b = boot(b_dir.path());
    assert!(!album_names(&b).contains(&"导出测试".to_string()));
    let res = do_import(&b, &out).unwrap();
    workbench_lib::app::ensure_defaults(&b).unwrap();

    assert_eq!(res["events"], info["events"]);
    assert_eq!(res["missingBlobs"].as_i64().unwrap() > 0, true, "图片没拷过来，应当报缺失");
    assert!(album_names(&b).contains(&"导出测试".to_string()));
    assert_eq!(projection_checksum(&b.kernel.store).unwrap(), sum_a, "重建后的投影应与原库一致");
    assert!(std::path::Path::new(res["backup"].as_str().unwrap()).is_file(), "导入前应备份原库");

    // 导入后还能继续写入，哈希链不断。
    b.gallery.create_album("导入后新建", None, false, false).unwrap();
    let chain = workbench_lib::kernel::bus::verify_chain(&b.kernel.store).unwrap();
    assert_eq!(chain["ok"], json!(true));
    // 暂存文件已清理。
    let leftovers: Vec<_> = std::fs::read_dir(b_dir.path())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("import-"))
        .collect();
    assert!(leftovers.is_empty());
}

#[test]
fn import_replaces_existing_events() {
    let a_dir = tempfile::tempdir().unwrap();
    let a = boot(a_dir.path());
    a.gallery.create_album("只在A", None, false, false).unwrap();
    let out = a_dir.path().join("a.sqlite");
    export_db(&a.kernel.store, &out).unwrap();

    let b_dir = tempfile::tempdir().unwrap();
    let b = boot(b_dir.path());
    b.gallery.create_album("只在B", None, false, false).unwrap();
    do_import(&b, &out).unwrap();

    let names = album_names(&b);
    assert!(names.contains(&"只在A".to_string()));
    assert!(!names.contains(&"只在B".to_string()), "导入是整体替换，不是合并");

    // 备份里还能找回 B 的数据。
    let backups: Vec<_> = std::fs::read_dir(b_dir.path().join("backups")).unwrap().flatten().collect();
    assert_eq!(backups.len(), 1);
    let c_dir = tempfile::tempdir().unwrap();
    let c = boot(c_dir.path());
    do_import(&c, &backups[0].path()).unwrap();
    assert!(album_names(&c).contains(&"只在B".to_string()));
}

#[test]
fn tampered_database_is_rejected_and_current_data_untouched() {
    let a_dir = tempfile::tempdir().unwrap();
    let a = boot(a_dir.path());
    a.gallery.create_album("原样", None, false, false).unwrap();
    let out = a_dir.path().join("bad.sqlite");
    export_db(&a.kernel.store, &out).unwrap();
    {
        let conn = rusqlite::Connection::open(&out).unwrap();
        conn.execute("UPDATE events SET payload_json = '{\"name\":\"被篡改\"}' WHERE global_seq = 2", []).unwrap();
    }

    let b_dir = tempfile::tempdir().unwrap();
    let b = boot(b_dir.path());
    b.gallery.create_album("本地数据", None, false, false).unwrap();
    let before = projection_checksum(&b.kernel.store).unwrap();
    let msg = err(do_import(&b, &out));
    assert!(msg.contains("哈希链"), "{msg}");
    assert_eq!(projection_checksum(&b.kernel.store).unwrap(), before);
    assert!(album_names(&b).contains(&"本地数据".to_string()));
    assert!(!b_dir.path().join("backups").exists(), "校验失败不应产生备份");
}

#[test]
fn non_sqlite_and_foreign_sqlite_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let svc = boot(dir.path());

    let text = dir.path().join("note.sqlite");
    std::fs::write(&text, "hello world, definitely not a database").unwrap();
    assert!(err(do_import(&svc, &text)).contains("SQLite"));

    let foreign = dir.path().join("foreign.sqlite");
    {
        let conn = rusqlite::Connection::open(&foreign).unwrap();
        conn.execute_batch("CREATE TABLE other (id INTEGER); INSERT INTO other VALUES (1);").unwrap();
    }
    assert!(err(do_import(&svc, &foreign)).contains("events"));

    assert!(err(do_import(&svc, &dir.path().join("missing.sqlite"))).contains("找不到"));
}

#[test]
fn refuses_the_live_database_itself() {
    let dir = tempfile::tempdir().unwrap();
    let svc = boot(dir.path());
    let live = dir.path().join("events.sqlite");
    assert!(err(do_import(&svc, &live)).contains("正在使用"));
    assert!(err(export_db(&svc.kernel.store, &live)).contains("正在使用"));
}

fn sorted_hashes(svc: &workbench_lib::app::Services) -> Vec<String> {
    let mut v = svc.kernel.blobs.iter_hashes();
    v.sort();
    v
}

fn seeded(dir: &std::path::Path) -> workbench_lib::app::Services {
    let a = boot(dir);
    let album = a.gallery.create_album("完整包", None, false, false).unwrap();
    let id = album["id"].as_str().unwrap().to_string();
    import(&a, &id, &png_image((64, 48)), json!({"name": "a.png"})).unwrap();
    import(&a, &id, &png_image((32, 32)), json!({"name": "b.png"})).unwrap();
    a
}

/// 把一个 zip 重新打包，`edit` 可以改名/改内容/丢弃条目。
fn rewrite_zip(
    src: &std::path::Path,
    dst: &std::path::Path,
    mut edit: impl FnMut(&str, Vec<u8>) -> Option<(String, Vec<u8>)>,
    extra: Vec<(String, Vec<u8>)>,
) {
    use std::io::{Read, Write};
    let mut ar = zip::ZipArchive::new(std::fs::File::open(src).unwrap()).unwrap();
    let mut out = zip::ZipWriter::new(std::fs::File::create(dst).unwrap());
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for i in 0..ar.len() {
        let mut e = ar.by_index(i).unwrap();
        let mut data = Vec::new();
        e.read_to_end(&mut data).unwrap();
        if let Some((name, data)) = edit(e.name(), data) {
            out.start_file(name, opts).unwrap();
            out.write_all(&data).unwrap();
        }
    }
    for (name, data) in extra {
        out.start_file(name, opts).unwrap();
        out.write_all(&data).unwrap();
    }
    out.finish().unwrap();
}

#[test]
fn pack_roundtrip_carries_images() {
    let a_dir = tempfile::tempdir().unwrap();
    let a = seeded(a_dir.path());
    let pack = a_dir.path().join("pack.zip");
    let seen = std::sync::Mutex::new(Vec::<(String, u64, u64)>::new());
    let info = export_pack(&a.kernel.store, &a.kernel.blobs, &a.data_dir, &pack, &|p, d, t| {
        seen.lock().unwrap().push((p.to_string(), d, t));
    })
    .unwrap();
    assert!(pack.is_file());
    assert!(!std::path::Path::new(&format!("{}.part", pack.display())).exists());
    assert_eq!(info["missingBlobs"], json!(0));
    assert_eq!(info["blobs"].as_u64().unwrap() as usize, sorted_hashes(&a).len());
    assert!(seen.lock().unwrap().iter().any(|(p, d, t)| p == "blobs" && d == t), "最后应报告 blobs 完成");
    // 导出时的暂存库已清理。
    assert!(std::fs::read_dir(&a.data_dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with("export-")));

    // 里面是 manifest + events.sqlite + blobs/xx/hash
    let mut ar = zip::ZipArchive::new(std::fs::File::open(&pack).unwrap()).unwrap();
    let names: Vec<String> = ar.file_names().map(|s| s.to_string()).collect();
    assert!(names.contains(&"manifest.json".to_string()) && names.contains(&"events.sqlite".to_string()));
    assert!(names.iter().filter(|n| n.starts_with("blobs/")).count() == sorted_hashes(&a).len());
    drop(ar.by_name("events.sqlite").unwrap());

    let b_dir = tempfile::tempdir().unwrap();
    let b = boot(b_dir.path());
    let sum = projection_checksum(&a.kernel.store).unwrap();
    let res = do_import(&b, &pack).unwrap();
    assert_eq!(res["pack"], json!(true));
    assert_eq!(res["missingBlobs"], json!(0), "图片随包带过来，不应缺失");
    assert_eq!(res["blobsAdded"].as_u64().unwrap() as usize, sorted_hashes(&a).len());
    assert_eq!(res["blobsCorrupt"], json!(0));
    assert_eq!(sorted_hashes(&b), sorted_hashes(&a));
    assert_eq!(projection_checksum(&b.kernel.store).unwrap(), sum);
    for h in sorted_hashes(&a) {
        assert!(b.kernel.blobs.verify(&h), "图片内容应与哈希一致");
    }

    // 再导一次：图片已在，全部跳过。
    let again = do_import(&b, &pack).unwrap();
    assert_eq!(again["blobsAdded"], json!(0));
    assert_eq!(again["blobsSkipped"].as_u64().unwrap() as usize, sorted_hashes(&a).len());
}

#[test]
fn pack_with_corrupt_blob_drops_it_and_reports() {
    let a_dir = tempfile::tempdir().unwrap();
    let a = seeded(a_dir.path());
    let pack = a_dir.path().join("pack.zip");
    export_pack(&a.kernel.store, &a.kernel.blobs, &a.data_dir, &pack, &|_, _, _| {}).unwrap();
    let bad = a_dir.path().join("bad.zip");
    let mut flipped = false;
    rewrite_zip(
        &pack,
        &bad,
        |name, mut data| {
            if !flipped && name.starts_with("blobs/") {
                flipped = true;
                data.push(0xAB);
            }
            Some((name.to_string(), data))
        },
        vec![],
    );

    let b_dir = tempfile::tempdir().unwrap();
    let b = boot(b_dir.path());
    let res = do_import(&b, &bad).unwrap();
    assert_eq!(res["blobsCorrupt"], json!(1));
    assert_eq!(res["missingBlobs"], json!(1), "损坏的那张不落盘，所以仍算缺失");
    assert_eq!(sorted_hashes(&b).len() + 1, sorted_hashes(&a).len());
    for h in sorted_hashes(&b) {
        assert!(b.kernel.blobs.verify(&h));
    }
}

#[test]
fn pack_rejects_foreign_archives_and_ignores_odd_entries() {
    let a_dir = tempfile::tempdir().unwrap();
    let a = seeded(a_dir.path());
    let pack = a_dir.path().join("pack.zip");
    export_pack(&a.kernel.store, &a.kernel.blobs, &a.data_dir, &pack, &|_, _, _| {}).unwrap();

    let b_dir = tempfile::tempdir().unwrap();
    let b = boot(b_dir.path());
    let before = projection_checksum(&b.kernel.store).unwrap();

    // 没有 events.sqlite
    let no_db = a_dir.path().join("no_db.zip");
    rewrite_zip(&pack, &no_db, |n, d| (n != "events.sqlite").then(|| (n.to_string(), d)), vec![]);
    assert!(err(do_import(&b, &no_db)).contains("events.sqlite"));

    // 清单标明是别的程序
    let other = a_dir.path().join("other.zip");
    rewrite_zip(
        &pack,
        &other,
        |n, d| if n == "manifest.json" { Some((n.to_string(), br#"{"app":"someone-else","format":1}"#.to_vec())) } else { Some((n.to_string(), d)) },
        vec![],
    );
    assert!(err(do_import(&b, &other)).contains("不是画师串工作台"));

    // 来自更新版本
    let newer = a_dir.path().join("newer.zip");
    rewrite_zip(
        &pack,
        &newer,
        |n, d| if n == "manifest.json" { Some((n.to_string(), br#"{"app":"minimax-workbench","format":99}"#.to_vec())) } else { Some((n.to_string(), d)) },
        vec![],
    );
    assert!(err(do_import(&b, &newer)).contains("升级"));
    assert_eq!(projection_checksum(&b.kernel.store).unwrap(), before, "被拒绝的包不应改动数据");

    // 带路径穿越和杂项条目的包：杂项忽略，正常导入，也不会写出 blobs/ 之外
    let odd = a_dir.path().join("odd.zip");
    rewrite_zip(
        &pack,
        &odd,
        |n, d| Some((n.to_string(), d)),
        vec![
            ("blobs/../../evil.txt".to_string(), b"x".to_vec()),
            ("../evil2.txt".to_string(), b"x".to_vec()),
            (format!("blobs/zz/{}", "a".repeat(64)), b"x".to_vec()),
            ("readme.txt".to_string(), b"hi".to_vec()),
        ],
    );
    let res = do_import(&b, &odd).unwrap();
    assert_eq!(res["blobsAdded"].as_u64().unwrap() as usize, sorted_hashes(&a).len());
    assert!(!b_dir.path().join("evil.txt").exists());
    assert!(!b_dir.path().parent().unwrap().join("evil.txt").exists());
    assert!(!b_dir.path().parent().unwrap().join("evil2.txt").exists());
    assert_eq!(sorted_hashes(&b), sorted_hashes(&a));
}