//! 数据库（以及图片）的导出与导入。
//!
//! 两种导出：
//! - [`export_db`]：`VACUUM INTO` 生成一份一致的 SQLite 副本，只有事件和投影，不含图片。
//! - [`export_pack`]：一个 zip 完整包：`manifest.json` + `events.sqlite` + `blobs/<前两位>/<哈希>`。
//!   图片本身已经压缩过，所以一律用「仅存储」，不再压一遍。
//!
//! 导入 [`import_db`] 自动识别上面两种文件：
//! 1. 把数据库复制/解出到暂存位置并校验（是 SQLite、有 `events` 表、哈希链完好）；
//! 2. 完整包：把图片逐个解出并校验 SHA-256（只新增，已有的不覆盖）；
//! 3. 备份当前库到 `backups/`；
//! 4. 在一个事务里用导入的事件替换现有事件；
//! 5. 从事件重建投影（导入文件里的投影表不采用）。
//!
//! 图片解出放在替换数据库之前：它只会往 `blobs/` 里加文件，中途失败也不会破坏现有数据，重新导入即可续上。

use super::blobs::BlobStore;
use super::bus::{referenced_hashes, verify_chain, Projector};
use super::clock::now_ms;
use super::errors::{DomainError, Res};
use super::hashes::{hex_lower, is_hash64, sha256_bytes};
use super::integrity::rebuild_projections;
use super::store::{open_connection, EventStore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
const ZIP_MAGIC: &[u8; 4] = b"PK\x03\x04";
const APP_ID: &str = "minimax-workbench";
const PACK_FORMAT: i64 = 1;
const MANIFEST: &str = "manifest.json";
const DB_ENTRY: &str = "events.sqlite";

const EVENT_COLUMNS: [&str; 13] = [
    "global_seq",
    "event_id",
    "aggregate_id",
    "aggregate_type",
    "version",
    "event_type",
    "payload_json",
    "occurred_at",
    "causation_id",
    "correlation_id",
    "command_id",
    "prev_hash",
    "event_hash",
];

/// 进度回调：`(阶段, 已完成, 总数)`。阶段是 `database` / `blobs`。
pub type Progress<'a> = &'a dyn Fn(&str, u64, u64);

fn path_str(p: &Path) -> Res<String> {
    p.to_str().map(|s| s.to_string()).ok_or_else(|| DomainError::bad("文件路径包含无法识别的字符"))
}

fn zip_err(e: impl std::fmt::Display) -> DomainError {
    DomainError::internal(format!("压缩包错误：{e}"))
}

fn event_count(store: &EventStore) -> Res<i64> {
    let conn = store.connect()?;
    Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?)
}

fn same_file(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

/// 退出作用域时删掉暂存的数据库及其 WAL/SHM 旁文件。
struct Cleanup(PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let base = self.0.to_string_lossy().to_string();
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{base}{suffix}"));
        }
    }
}

/// 先写 `.part` 临时文件，成功后再换上；失败不会毁掉用户原有的同名文件。
fn part_path(dest: &Path) -> Res<PathBuf> {
    Ok(PathBuf::from(format!("{}.part", path_str(dest)?)))
}

fn replace_file(part: &Path, dest: &Path) -> Res<()> {
    if dest.exists() {
        std::fs::remove_file(dest)?;
    }
    std::fs::rename(part, dest)?;
    Ok(())
}

fn prepare_dest(store: &EventStore, dest: &Path) -> Res<()> {
    if same_file(dest, &store.db_path) {
        return Err(DomainError::bad("不能导出到正在使用的数据库文件本身"));
    }
    if let Some(parent) = dest.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn vacuum_into(store: &EventStore, dest: &Path) -> Res<()> {
    let conn = store.connect()?;
    conn.execute("VACUUM INTO ?1", [path_str(dest)?])?;
    Ok(())
}

/// 把当前事件库导出成单个 SQLite 文件（不含图片）。目标已存在会被覆盖（保存对话框里用户已确认）。
pub fn export_db(store: &EventStore, dest: &Path) -> Res<Value> {
    prepare_dest(store, dest)?;
    let part = part_path(dest)?;
    let _ = std::fs::remove_file(&part);
    vacuum_into(store, &part)?;
    replace_file(&part, dest)?;
    let size = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "path": path_str(dest)?,
        "events": event_count(store)?,
        "size": size,
    }))
}

fn stored() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(CompressionMethod::Stored)
}

/// 导出完整包：数据库 + 所有被事件引用且本机存在的图片，打成一个 zip。
pub fn export_pack(store: &EventStore, blobs: &BlobStore, data_dir: &Path, dest: &Path, progress: Progress) -> Res<Value> {
    prepare_dest(store, dest)?;
    std::fs::create_dir_all(data_dir)?;

    // 1. 先取一份一致的数据库快照；之后引用的图片以实时事件为准（只会多、不会少）。
    progress("database", 0, 1);
    let stage = data_dir.join(format!("export-{}.sqlite", now_ms()));
    let _cleanup = Cleanup(stage.clone());
    vacuum_into(store, &stage)?;
    let events: i64 = open_connection(&stage)?.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
    let empty = sha256_bytes(b"");
    let mut hashes: Vec<String> = Vec::new();
    let mut missing = 0usize;
    for h in referenced_hashes(store)? {
        if h == empty {
            continue;
        }
        if blobs.exists(&h) {
            hashes.push(h);
        } else {
            missing += 1;
        }
    }
    progress("database", 1, 1);

    // 2. 写 zip。
    let part = part_path(dest)?;
    let _ = std::fs::remove_file(&part);
    let file = File::create(&part)?;
    let mut zip = ZipWriter::new(BufWriter::with_capacity(1 << 20, file));
    let manifest = json!({
        "app": APP_ID,
        "format": PACK_FORMAT,
        "exportedAt": now_ms(),
        "version": env!("CARGO_PKG_VERSION"),
        "events": events,
        "blobs": hashes.len(),
    });
    let written = (|| -> Res<usize> {
        zip.start_file(MANIFEST, stored()).map_err(zip_err)?;
        zip.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
        zip.start_file(DB_ENTRY, stored().large_file(true)).map_err(zip_err)?;
        std::io::copy(&mut BufReader::new(File::open(&stage)?), &mut zip)?;

        let total = hashes.len() as u64;
        let mut written = 0usize;
        let mut vanished = 0usize;
        for (i, h) in hashes.iter().enumerate() {
            // 先打开再开条目：文件中途消失就跳过，不留空条目。
            let Ok(src) = File::open(blobs.path_for(h)) else {
                vanished += 1;
                continue;
            };
            zip.start_file(format!("blobs/{}/{}", &h[..2], h), stored()).map_err(zip_err)?;
            std::io::copy(&mut BufReader::new(src), &mut zip)?;
            written += 1;
            let done = (i + 1) as u64;
            if done % 25 == 0 || done == total {
                progress("blobs", done, total);
            }
        }
        missing += vanished;
        let mut inner = zip.finish().map_err(zip_err)?;
        inner.flush()?;
        Ok(written)
    })();
    let written = match written {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
    };
    replace_file(&part, dest)?;
    let size = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "path": path_str(dest)?,
        "events": events,
        "blobs": written,
        "missingBlobs": missing,
        "size": size,
    }))
}

// ---------------------------------------------------------------- 导入

type Pack = ZipArchive<BufReader<File>>;

fn read_head(src: &Path) -> Res<([u8; 16], usize)> {
    let mut head = [0u8; 16];
    let mut file = File::open(src).map_err(|e| DomainError::bad(format!("无法打开文件：{e}")))?;
    let mut n = 0;
    while n < head.len() {
        match file.read(&mut head[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) => return Err(DomainError::bad(format!("无法读取文件：{e}"))),
        }
    }
    Ok((head, n))
}

fn open_pack(src: &Path) -> Res<Pack> {
    let file = File::open(src).map_err(|e| DomainError::bad(format!("无法打开文件：{e}")))?;
    ZipArchive::new(BufReader::with_capacity(1 << 20, file)).map_err(|e| DomainError::bad(format!("无法读取压缩包：{e}")))
}

fn check_manifest(pack: &mut Pack) -> Res<()> {
    let Ok(mut entry) = pack.by_name(MANIFEST) else {
        return Ok(()); // 手工打的包没有清单也认，只要里面有 events.sqlite
    };
    let mut text = String::new();
    entry.read_to_string(&mut text).map_err(|_| DomainError::bad("压缩包里的 manifest.json 无法读取"))?;
    let v: Value = serde_json::from_str(&text).map_err(|_| DomainError::bad("压缩包里的 manifest.json 格式错误"))?;
    if let Some(app) = v.get("app").and_then(|a| a.as_str()) {
        if app != APP_ID {
            return Err(DomainError::bad("这不是画师串工作台导出的完整包"));
        }
    }
    if v.get("format").and_then(|f| f.as_i64()).unwrap_or(PACK_FORMAT) > PACK_FORMAT {
        return Err(DomainError::bad("这个完整包来自更新的版本，请先升级软件"));
    }
    Ok(())
}

fn extract_db(pack: &mut Pack, stage: &Path) -> Res<()> {
    let mut entry = pack
        .by_name(DB_ENTRY)
        .map_err(|_| DomainError::bad("压缩包里没有 events.sqlite，不是本软件导出的完整包"))?;
    let mut out = File::create(stage)?;
    std::io::copy(&mut entry, &mut out)?;
    Ok(())
}

/// `blobs/<前两位>/<64 位哈希>`，其余条目一律忽略（路径只由哈希拼出，不会被压缩包里的名字带出目录）。
fn blob_hash_of(name: &str) -> Option<String> {
    let rest = name.strip_prefix("blobs/")?;
    let (dir, file) = rest.split_once('/')?;
    (is_hash64(file) && dir == &file[..2]).then(|| file.to_string())
}

struct BlobStats {
    added: u64,
    skipped: u64,
    corrupt: u64,
}

fn extract_blobs(pack: &mut Pack, blobs: &BlobStore, progress: Progress) -> Res<BlobStats> {
    let total = pack.file_names().filter(|n| blob_hash_of(n).is_some()).count() as u64;
    let mut stats = BlobStats { added: 0, skipped: 0, corrupt: 0 };
    let mut done = 0u64;
    let mut buf = vec![0u8; 1 << 20];
    for i in 0..pack.len() {
        let mut entry = pack.by_index(i).map_err(zip_err)?;
        if entry.is_dir() {
            continue;
        }
        let Some(hash) = blob_hash_of(entry.name()) else {
            continue;
        };
        done += 1;
        if blobs.exists(&hash) {
            stats.skipped += 1;
        } else {
            let path = blobs.path_for(&hash);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let tmp = path.with_file_name(format!("{hash}.tmp{}", std::process::id()));
            let mut hasher = Sha256::new();
            {
                let mut out = BufWriter::new(File::create(&tmp)?);
                loop {
                    let n = entry.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buf[..n]);
                    out.write_all(&buf[..n])?;
                }
                out.flush()?;
            }
            if hex_lower(&hasher.finalize()) == hash {
                if std::fs::rename(&tmp, &path).is_err() {
                    if !path.exists() {
                        std::fs::copy(&tmp, &path)?;
                    }
                    let _ = std::fs::remove_file(&tmp);
                }
                stats.added += 1;
            } else {
                let _ = std::fs::remove_file(&tmp);
                stats.corrupt += 1;
            }
        }
        if done % 25 == 0 || done == total {
            progress("blobs", done, total);
        }
    }
    Ok(stats)
}

fn check_events_table(stage: &Path) -> Res<()> {
    let conn = open_connection(stage).map_err(|_| DomainError::bad("无法读取这个数据库文件"))?;
    let mut stmt = conn
        .prepare("PRAGMA table_info(events)")
        .map_err(|_| DomainError::bad("无法读取这个数据库文件"))?;
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|_| DomainError::bad("无法读取这个数据库文件"))?
        .flatten()
        .collect();
    if cols.is_empty() {
        return Err(DomainError::bad("这不是画师串工作台的数据库（缺少 events 表）"));
    }
    for name in EVENT_COLUMNS {
        if !cols.iter().any(|c| c == name) {
            return Err(DomainError::bad(format!("数据库的 events 表缺少字段 {name}，不是兼容的版本")));
        }
    }
    Ok(())
}

/// 用 `src`（SQLite 数据库或完整包）里的事件替换当前库的全部事件，并重建投影。
///
/// 调用方需要自己保证此刻没有正在运行的生图任务。
pub fn import_db(
    store: &EventStore,
    blobs: &BlobStore,
    projectors: &[Box<dyn Projector>],
    data_dir: &Path,
    src: &Path,
    progress: Progress,
) -> Res<Value> {
    if !src.is_file() {
        return Err(DomainError::bad("找不到所选的文件"));
    }
    if same_file(src, &store.db_path) {
        return Err(DomainError::bad("所选文件就是当前正在使用的数据库"));
    }
    let (head, n) = read_head(src)?;
    let is_sqlite = n >= 16 && &head == SQLITE_MAGIC;
    let is_pack = n >= 4 && &head[..4] == ZIP_MAGIC;
    if !is_sqlite && !is_pack {
        return Err(DomainError::bad("无法识别这个文件：它既不是 SQLite 数据库，也不是导出的完整包"));
    }

    // 1. 取出数据库到暂存位置（不改动用户的原文件）。
    std::fs::create_dir_all(data_dir)?;
    let stage = data_dir.join(format!("import-{}.sqlite", now_ms()));
    let _cleanup = Cleanup(stage.clone());
    let mut pack: Option<Pack> = None;
    if is_pack {
        let mut p = open_pack(src)?;
        check_manifest(&mut p)?;
        extract_db(&mut p, &stage)?;
        pack = Some(p);
    } else {
        // 连同 WAL 旁文件一起复制，旧版库可能还有没合并回主文件的内容。
        std::fs::copy(src, &stage)?;
        let wal = PathBuf::from(format!("{}-wal", path_str(src)?));
        if wal.is_file() {
            std::fs::copy(&wal, PathBuf::from(format!("{}-wal", path_str(&stage)?)))?;
        }
    }

    // 2. 校验：结构 + 哈希链。
    progress("database", 0, 1);
    check_events_table(&stage)?;
    let staged = EventStore::open(&stage)?;
    let incoming = event_count(&staged)?;
    if incoming == 0 {
        return Err(DomainError::bad("这个数据库里没有任何事件，无需导入"));
    }
    let chain = verify_chain(&staged)?;
    if !chain.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let first = chain
            .get("errors")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(DomainError::bad(format!("事件哈希链校验失败，已拒绝导入（{first}）")));
    }
    drop(staged);
    progress("database", 1, 1);

    // 3. 完整包：先把图片放进 blobs/（只新增，哈希对不上的丢弃）。
    let blob_stats = match pack.as_mut() {
        Some(p) => Some(extract_blobs(p, blobs, progress)?),
        None => None,
    };
    drop(pack);

    // 4. 先把现有数据库备份一份，导入出问题时可以拿回来。
    let backup_path = data_dir.join("backups").join(format!("events-before-import-{}.sqlite", now_ms()));
    let backup = export_db(store, &backup_path)?;

    // 5. 在写锁内用导入的事件整体替换。
    let stage_str = path_str(&stage)?;
    store.with_write_lock(|| -> Res<()> {
        let conn = store.connect()?;
        conn.execute("ATTACH DATABASE ?1 AS imp", [&stage_str])?;
        let cols = EVENT_COLUMNS.join(", ");
        let result = (|| -> Res<()> {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            conn.execute_batch("DELETE FROM events")?;
            conn.execute_batch("DELETE FROM sqlite_sequence WHERE name = 'events'")?;
            conn.execute_batch(&format!("INSERT INTO events ({cols}) SELECT {cols} FROM imp.events ORDER BY global_seq"))?;
            conn.execute_batch("COMMIT")?;
            Ok(())
        })();
        if result.is_err() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        let _ = conn.execute_batch("DETACH DATABASE imp");
        result
    })?;

    // 6. 以事件为准重建所有投影。
    let rebuilt = rebuild_projections(store, projectors).map_err(|e| {
        DomainError::internal(format!(
            "事件已导入，但重建投影失败：{}。原数据库已备份在 {}，可在设置里再点一次「重建投影」",
            e.message,
            backup_path.display()
        ))
    })?;

    // 7. 统计本机仍然缺失的图片。
    let empty = sha256_bytes(b"");
    let missing = referenced_hashes(store)?
        .into_iter()
        .filter(|h| *h != empty && !blobs.exists(h))
        .count();

    Ok(json!({
        "events": incoming,
        "rebuilt": rebuilt,
        "missingBlobs": missing,
        "backup": backup.get("path").cloned().unwrap_or(Value::Null),
        "pack": blob_stats.is_some(),
        "blobsAdded": blob_stats.as_ref().map(|s| s.added).unwrap_or(0),
        "blobsSkipped": blob_stats.as_ref().map(|s| s.skipped).unwrap_or(0),
        "blobsCorrupt": blob_stats.as_ref().map(|s| s.corrupt).unwrap_or(0),
    }))
}
