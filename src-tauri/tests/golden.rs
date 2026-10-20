//! Golden 测试：用真实的 `events.sqlite` 副本验证 Rust 实现与 Python 版逐位一致。
//!
//! 这个测试默认跳过。Python 后端源码已从仓库中移除，只存在备份
//! `workbench-python-backend-backup.zip`（在 minimax 根目录）。要重新生成基线，需先把压缩包里的
//! `app/ contexts/ kernel/ server.py pyproject.toml` 解压回 `workbench/backend/`，并用 `uv sync`
//! 建好 `.venv`；之后 `py_*.py` 脚本才能 import 到 Python 版。
//!
//! 运行方式（PowerShell，在 `workbench/src-tauri` 下）：
//!
//! ```text
//! # 1. 复制一份事件库（测试和基线脚本都会改动投影表，绝不要直接用原文件）
//! Copy-Item ..\backend\data\events.sqlite $env:TEMP\wbgolden\events.rs.sqlite
//! Copy-Item ..\backend\data\events.sqlite $env:TEMP\wbgolden\events.py.sqlite
//! # 2. 用 Python 版生成基线
//! cd ..\backend
//! .\.venv\Scripts\python ..\src-tauri\tests\py_baseline.py $env:TEMP\wbgolden\events.py.sqlite $env:TEMP\wbgolden\baseline.json
//! # 3. 跑 Rust 的 golden
//! cd ..\src-tauri
//! $env:WB_GOLDEN_DB = "$env:TEMP\wbgolden\events.rs.sqlite"
//! $env:WB_GOLDEN_BASELINE = "$env:TEMP\wbgolden\baseline.json"
//! cargo test --release --test golden -- --nocapture
//! ```

use serde_json::Value;
use workbench_lib::app;
use workbench_lib::kernel::bus::verify_chain;
use workbench_lib::kernel::integrity::{projection_checksum, rebuild_projections};

fn env_path(name: &str) -> Option<std::path::PathBuf> {
    std::env::var_os(name).map(std::path::PathBuf::from).filter(|p| p.is_file())
}

#[test]
fn matches_python_on_real_data() {
    let (Some(db), Some(baseline)) = (env_path("WB_GOLDEN_DB"), env_path("WB_GOLDEN_BASELINE")) else {
        eprintln!("跳过：未设置 WB_GOLDEN_DB / WB_GOLDEN_BASELINE");
        return;
    };
    let base: Value = serde_json::from_slice(&std::fs::read(baseline).unwrap()).unwrap();

    let dir = tempfile::tempdir().unwrap();
    std::fs::copy(&db, dir.path().join("events.sqlite")).unwrap();
    let services = app::build(dir.path()).unwrap();
    let store = &services.kernel.store;

    // 1. 哈希链（同时覆盖 canonical JSON 与 Python 逐字节一致：event_hash 对不上就会报错）
    let chain = verify_chain(store).unwrap();
    assert_eq!(chain["ok"], base["chain"]["ok"], "哈希链结果不一致：{}", chain["errors"]);
    assert_eq!(chain["events"], base["chain"]["events"]);
    assert_eq!(chain["head"], base["chain"]["head"]);

    // 2. 现有投影（Python 写的）的 checksum：验证 Rust 的 checksum 算法和 Python 一致
    let before = projection_checksum(store).unwrap();
    assert_eq!(before, base["before"].as_str().unwrap(), "投影 checksum（重建前）不一致");

    // 3. 用 Rust 投影器重建后，必须与 Python 重建后的结果逐行一致
    let n = rebuild_projections(store, &services.kernel.projectors).unwrap();
    assert_eq!(n as u64, base["chain"]["events"].as_u64().unwrap());
    if let Some(dump) = std::env::var_os("WB_GOLDEN_DUMP") {
        // 排查差异用：把重建后的库留下来，配合 py_diff.py 逐表逐行对比
        let _ = store.connect().unwrap().execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        std::fs::copy(dir.path().join("events.sqlite"), dump).unwrap();
    }
    let after = projection_checksum(store).unwrap();
    assert_eq!(after, base["after"].as_str().unwrap(), "投影 checksum（重建后）不一致");

    // 4. 抽奖批次 verify：池哈希必须和 Python 完全一致。
    //    Rust 修正了 Python 重放时漏掉每条先 randint 的错位问题，所以 drawsMatch / ok 只要求
    //    「Python 判对的 Rust 也判对」，Rust 额外判对的批次只统计。
    let verifies = base["verifies"].as_object().unwrap();
    let (mut checked, mut rust_ok) = (0, 0);
    for (id, expected) in verifies {
        let got = services.lottery.verify(id).unwrap();
        for key in ["poolHashMatch", "expectedPoolHash", "storedPoolHash"] {
            assert_eq!(got[key], expected[key], "批次 {id} 的 {key} 不一致");
        }
        for key in ["ok", "drawsMatch"] {
            if expected[key] == Value::Bool(true) {
                assert_eq!(got[key], Value::Bool(true), "批次 {id}：Python 判对而 Rust 判错（{key}）");
            }
        }
        if got["ok"] == Value::Bool(true) {
            rust_ok += 1;
        }
        checked += 1;
    }
    eprintln!("golden: {} 条事件、{} 个抽奖批次对得上（其中 Rust 重放通过 {} 个）", n, checked, rust_ok);
}
