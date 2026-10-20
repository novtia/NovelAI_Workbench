//! 对应 Python 的 test_hash_chain.py / test_integrity.py。

mod common;

use common::{boot, import, png};
use serde_json::json;
use workbench_lib::kernel::bus::verify_chain;
use workbench_lib::kernel::clock::new_id;
use workbench_lib::kernel::hashes::{event_hash, GENESIS_HASH};
use workbench_lib::kernel::integrity::{projection_checksum, rebuild_projections, verify_all};
use workbench_lib::kernel::store::EventStore;
use workbench_lib::kernel::NewEvent;

fn event(version: i64, kind: &str, payload: serde_json::Value, command: &str) -> NewEvent {
    NewEvent {
        aggregate_id: "a1".into(),
        aggregate_type: "Album".into(),
        version,
        event_type: kind.into(),
        payload,
        occurred_at: 1,
        event_id: new_id(),
        causation_id: None,
        correlation_id: None,
        command_id: Some(command.into()),
    }
}

#[test]
fn hash_chain_appends() {
    let dir = tempfile::tempdir().unwrap();
    let store = EventStore::open(&dir.path().join("events.sqlite")).unwrap();
    let e1 = event(1, "AlbumRegistered", json!({"name": "默认收藏夹", "createdAt": 1, "order": 1}), "c1");
    let stored = store.append(vec![e1.clone()], Some("c1"), &mut |_, _| Ok(())).unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].prev_hash, GENESIS_HASH);
    assert_eq!(stored[0].event_hash, event_hash(GENESIS_HASH, &e1.hash_body()));

    let e2 = event(2, "AlbumRenamed", json!({"name": "新名字"}), "c2");
    let stored2 = store.append(vec![e2], Some("c2"), &mut |_, _| Ok(())).unwrap();
    assert_eq!(stored2[0].prev_hash, stored[0].event_hash);

    // 同一个 command_id 再提交：幂等，直接返回旧事件
    let again = store.append(vec![e1], Some("c1"), &mut |_, _| Ok(())).unwrap();
    assert_eq!(again[0].event_id, stored[0].event_id);
    assert_eq!(store.load_all().unwrap().len(), 2);
}

#[test]
fn verify_after_album_and_blob() {
    let dir = tempfile::tempdir().unwrap();
    let svc = boot(dir.path());
    import(&svc, "default", &png(1), json!({"name": "t.png", "artists": ["x"], "artistLine": "artist:x"})).unwrap();
    let k = &svc.kernel;
    let report = verify_all(&k.store, &k.blobs, &k.projectors).unwrap();
    assert_eq!(report["chain"]["ok"], json!(true), "{report}");
    assert_eq!(report["blobs"]["missing"], json!([]), "{report}");
    assert_eq!(report["ok"], json!(true), "{report}");
}

#[test]
fn verify_detects_missing_blob_and_tampered_chain() {
    let dir = tempfile::tempdir().unwrap();
    let svc = boot(dir.path());
    let item = import(&svc, "default", &png(2), json!({"name": "t.png", "artists": ["x"]})).unwrap();
    let k = &svc.kernel;

    // 删掉一个被引用的图片文件：校验必须报缺失
    let hash = item["hash"].as_str().unwrap().to_string();
    std::fs::remove_file(k.blobs.path_for(&hash)).unwrap();
    let report = verify_all(&k.store, &k.blobs, &k.projectors).unwrap();
    assert_eq!(report["ok"], json!(false));
    assert!(report["blobs"]["missing"].as_array().unwrap().iter().any(|h| h == &json!(hash)), "{report}");

    // 篡改一条事件的内容：事件链必须断
    let conn = k.store.connect().unwrap();
    conn.execute("UPDATE events SET payload_json = '{\"x\":1}' WHERE global_seq = 1", []).unwrap();
    let chain = verify_chain(&k.store).unwrap();
    assert_eq!(chain["ok"], json!(false), "{chain}");
}

#[test]
fn rebuild_keeps_projection_checksum() {
    let dir = tempfile::tempdir().unwrap();
    let svc = boot(dir.path());
    import(&svc, "default", &png(3), json!({"name": "a.png", "artists": ["a"]})).unwrap();
    svc.gallery.basket_add(&json!(["a", "b"])).unwrap();
    let k = &svc.kernel;
    let before = projection_checksum(&k.store).unwrap();
    let n = rebuild_projections(&k.store, &k.projectors).unwrap();
    assert!(n > 0);
    assert_eq!(projection_checksum(&k.store).unwrap(), before);
}
