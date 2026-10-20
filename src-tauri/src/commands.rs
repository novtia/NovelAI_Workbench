//! Tauri 命令：和 Python 版 FastAPI 的路由一一对应，返回值形状保持不变（`{albums: [...]}` 之类），
//! 错误统一序列化成 `{error, status}`，前端 `src/api/client.ts` 会把它还原成 `ApiError`。
//!
//! 返回给前端的 JSON 一律过一遍 `to_client`，把库里保存的旧式 `/api/blobs/...` 地址换成 `wb://` 协议地址。

use crate::app::Services;
use crate::kernel::integrity::{backup_hint, rebuild_projections, verify_all};
use crate::kernel::bus::verify_chain;
use crate::kernel::transfer::{export_db, export_pack, import_db};
use tauri::{Emitter, Manager};
use crate::kernel::{DomainError, Res};
use crate::contexts::generation::nai_payload::uc_presets_json;
use crate::contexts::gallery::application::ImportOptions;
use crate::util::{get, py_str, to_client, truthy};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::ipc::{InvokeBody, Request};
use tauri::State;

type S<'a> = State<'a, Arc<Services>>;
type R = Result<Value, DomainError>;

fn out(v: Value) -> R {
    Ok(to_client(v))
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn raw_body<'a>(req: &'a Request<'_>) -> Res<&'a [u8]> {
    match req.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.as_slice()),
        _ => Err(DomainError::bad("请求格式错误")),
    }
}

fn text_of(v: &Value) -> String {
    if truthy(v) { py_str(v) } else { String::new() }
}

// ---------- 健康检查 / 完整性 ----------

#[tauri::command]
pub fn health() -> Value {
    json!({"ok": true})
}

#[tauri::command]
pub async fn integrity_verify(s: S<'_>) -> R {
    let svc = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        verify_all(&svc.kernel.store, &svc.kernel.blobs, &svc.kernel.projectors)
    })
    .await
    .map_err(|e| DomainError::internal(format!("任务异常：{e}")))?
}

#[tauri::command]
pub async fn integrity_rebuild(s: S<'_>) -> R {
    let svc = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> R {
        let count = rebuild_projections(&svc.kernel.store, &svc.kernel.projectors)?;
        let chain = verify_chain(&svc.kernel.store)?;
        Ok(json!({"rebuilt": count, "chain": chain}))
    })
    .await
    .map_err(|e| DomainError::internal(format!("任务异常：{e}")))?
}

#[tauri::command]
pub fn integrity_backup(s: S<'_>) -> R {
    Ok(backup_hint(&s.data_dir))
}

fn jobs_busy_error() -> DomainError {
    DomainError::conflict("还有生图任务在排队或进行中，请等它们结束或取消后再导入")
}

/// 导出/导入大文件时把进度推给前端：`transfer-progress` 事件，`{phase, done, total}`。
fn progress_emitter(app: &tauri::AppHandle) -> impl Fn(&str, u64, u64) + '_ {
    move |phase: &str, done: u64, total: u64| {
        let _ = app.emit("transfer-progress", json!({"phase": phase, "done": done, "total": total}));
    }
}

fn save_dialog(app: &tauri::AppHandle, title: &str, name: String, filter: (&str, &[&str])) -> Option<tauri_plugin_dialog::FilePath> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title(title).set_file_name(name).add_filter(filter.0, filter.1);
    if let Some(win) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&win);
    }
    dialog.blocking_save_file()
}

fn picked_path(p: tauri_plugin_dialog::FilePath) -> Res<std::path::PathBuf> {
    p.into_path().map_err(|e| DomainError::bad(format!("无法使用所选路径：{e}")))
}

/// 弹出系统「另存为」对话框，把事件库导出成单个 SQLite 文件（不含图片）。用户取消返回 `{cancelled: true}`。
#[tauri::command]
pub async fn db_export(app: tauri::AppHandle, s: S<'_>, suggested_name: Option<String>) -> R {
    let svc = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> R {
        let name = suggested_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| "workbench-events.sqlite".to_string());
        let Some(picked) = save_dialog(&app, "导出数据库", name, ("SQLite 数据库", &["sqlite", "db"])) else {
            return Ok(json!({"cancelled": true}));
        };
        let mut info = export_db(&svc.kernel.store, &picked_path(picked)?)?;
        info["cancelled"] = json!(false);
        Ok(info)
    })
    .await
    .map_err(|e| DomainError::internal(format!("任务异常：{e}")))?
}

/// 弹出系统「另存为」对话框，把数据库和图片打成一个 zip 完整包。进度走 `transfer-progress` 事件。
#[tauri::command]
pub async fn db_export_pack(app: tauri::AppHandle, s: S<'_>, suggested_name: Option<String>) -> R {
    let svc = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> R {
        let name = suggested_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| "workbench-pack.zip".to_string());
        let Some(picked) = save_dialog(&app, "导出数据库和图片", name, ("完整包 (zip)", &["zip"])) else {
            return Ok(json!({"cancelled": true}));
        };
        let emit = progress_emitter(&app);
        let mut info = export_pack(&svc.kernel.store, &svc.kernel.blobs, &svc.data_dir, &picked_path(picked)?, &emit)?;
        info["cancelled"] = json!(false);
        Ok(info)
    })
    .await
    .map_err(|e| DomainError::internal(format!("任务异常：{e}")))?
}

/// 弹出系统「打开文件」对话框，选一个数据库或完整包替换当前数据（先自动备份），再重建投影。
#[tauri::command]
pub async fn db_import(app: tauri::AppHandle, s: S<'_>) -> R {
    use tauri_plugin_dialog::DialogExt;
    let svc = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> R {
        if !svc.generation.list_jobs()?.is_empty() {
            return Err(jobs_busy_error());
        }
        let mut dialog = app
            .dialog()
            .file()
            .set_title("导入数据库")
            .add_filter("数据库或完整包", &["sqlite", "db", "sqlite3", "zip"])
            .add_filter("所有文件", &["*"]);
        if let Some(win) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&win);
        }
        let Some(picked) = dialog.blocking_pick_file() else {
            return Ok(json!({"cancelled": true}));
        };
        let path = picked_path(picked)?;
        // 再查一次：对话框开着的时候可能已经有人提交了任务。
        if !svc.generation.list_jobs()?.is_empty() {
            return Err(jobs_busy_error());
        }
        let emit = progress_emitter(&app);
        let mut info = import_db(&svc.kernel.store, &svc.kernel.blobs, &svc.kernel.projectors, &svc.data_dir, &path, &emit)?;
        svc.settings.reload()?;
        svc.generation.invalidate_status();
        crate::app::ensure_defaults(&svc)?;
        info["cancelled"] = json!(false);
        Ok(info)
    })
    .await
    .map_err(|e| DomainError::internal(format!("任务异常：{e}")))?
}

// ---------- 设置 ----------

#[tauri::command(async)]
pub fn settings_get(s: S<'_>) -> R {
    Ok(s.settings.public())
}

#[tauri::command(async)]
pub fn settings_put(s: S<'_>, patch: Value) -> R {
    Ok(s.settings.update(&patch)?)
}

#[tauri::command(async)]
pub fn settings_reset(s: S<'_>, section: Option<String>) -> R {
    Ok(s.settings.reset(section.as_deref().filter(|x| !x.is_empty()))?)
}

#[tauri::command(async)]
pub fn settings_import(s: S<'_>, settings: Value) -> R {
    Ok(s.settings.replace(&settings)?)
}

#[tauri::command(async)]
pub fn settings_system(s: S<'_>) -> R {
    let mut info = s.settings.system_info(&s.data_dir, &s.kernel.blobs)?;
    info["port"] = Value::Null;
    info["version"] = json!(env!("CARGO_PKG_VERSION"));
    Ok(info)
}

// ---------- 图库 ----------

#[tauri::command(async)]
pub fn gallery_list_albums(s: S<'_>) -> R {
    out(json!({"albums": s.gallery.list_albums(false)?}))
}

#[tauri::command(async)]
pub fn gallery_create_album(s: S<'_>, name: Option<String>, id: Option<String>) -> R {
    let album = s.gallery.create_album(name.as_deref().unwrap_or(""), id.as_deref().filter(|x| !x.is_empty()), false, false)?;
    out(json!({"album": album}))
}

#[tauri::command(async)]
pub fn gallery_get_view(s: S<'_>) -> R {
    out(json!({"view": s.gallery.view()?}))
}

#[tauri::command(async)]
pub fn gallery_put_view(s: S<'_>, view: Value) -> R {
    if !view.is_object() {
        return Err(DomainError::bad("参数格式错误"));
    }
    out(json!({"view": s.gallery.select_view(&view)?}))
}

#[tauri::command(async)]
pub fn gallery_get_basket(s: S<'_>) -> R {
    out(json!({"artists": s.gallery.basket()?}))
}

#[tauri::command(async)]
pub fn gallery_add_basket(s: S<'_>, names: Option<Value>) -> R {
    let names = names.unwrap_or_else(|| json!([]));
    out(json!({"artists": s.gallery.basket_add(&names)?}))
}

#[tauri::command(async)]
pub fn gallery_remove_basket(s: S<'_>, key: String) -> R {
    out(json!({"artists": s.gallery.basket_remove(&key)?}))
}

#[tauri::command(async)]
pub fn gallery_clear_basket(s: S<'_>) -> R {
    out(json!({"artists": s.gallery.basket_clear()?}))
}

#[tauri::command(async)]
pub fn gallery_create_test_set(s: S<'_>, name: Option<String>) -> R {
    out(json!({"album": s.gallery.create_test_set(name.as_deref().unwrap_or(""))?}))
}

#[tauri::command(async)]
pub fn gallery_rename_album(s: S<'_>, id: String, name: Option<String>) -> R {
    out(json!({"album": s.gallery.rename_album(&id, name.as_deref().unwrap_or(""))?}))
}

#[tauri::command(async)]
pub fn gallery_delete_album(s: S<'_>, id: String) -> R {
    s.gallery.delete_album(&id)?;
    Ok(Value::Null)
}

#[tauri::command(async)]
pub fn gallery_restore_album(s: S<'_>, id: String) -> R {
    out(json!({"album": s.gallery.restore_album(&id)?}))
}

#[tauri::command(async)]
pub fn gallery_list_items(
    s: S<'_>,
    album_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
    sort: Option<String>,
) -> R {
    let items = s.gallery.list_items(
        &album_id,
        false,
        limit,
        offset.unwrap_or(0),
        sort.as_deref().unwrap_or("added_desc"),
    )?;
    out(json!({"items": items}))
}

#[tauri::command(async)]
pub fn gallery_clear_album(s: S<'_>, album_id: String) -> R {
    s.gallery.clear_album(&album_id)?;
    Ok(Value::Null)
}

#[tauri::command(async)]
pub fn gallery_has_hash(s: S<'_>, album_id: String, hash: String) -> R {
    let digest = hash.trim().to_lowercase();
    if !is_hash(&digest) {
        return Err(DomainError::bad("无效的哈希"));
    }
    Ok(json!({"exists": s.gallery.has_hash(&album_id, &digest)?}))
}

/// 导入图片：请求体是自定义二进制帧（见前端 `api/gallery.ts` 的 `packImport`）：
/// `u32le 头长度 | 头 JSON {albumId, meta, thumbLen} | 缩略图字节 | 原图字节`。
#[tauri::command(async)]
pub fn gallery_import_item(s: S<'_>, request: Request<'_>) -> R {
    let body = raw_body(&request)?;
    if body.len() < 4 {
        return Err(DomainError::bad("缺少图片文件"));
    }
    let head_len = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if body.len() < 4 + head_len {
        return Err(DomainError::bad("请求格式错误"));
    }
    let head: Value = serde_json::from_slice(&body[4..4 + head_len]).map_err(|_| DomainError::bad("请求格式错误"))?;
    let rest = &body[4 + head_len..];
    let thumb_len = head["thumbLen"].as_u64().unwrap_or(0) as usize;
    if rest.len() < thumb_len {
        return Err(DomainError::bad("请求格式错误"));
    }
    let (thumb, file) = rest.split_at(thumb_len);
    if file.is_empty() {
        return Err(DomainError::bad("缺少图片文件"));
    }
    let meta = head.get("meta").cloned().unwrap_or_else(|| json!({}));
    if !meta.is_object() {
        return Err(DomainError::bad("元数据格式错误"));
    }
    let album_id = text_of(get(&head, "albumId"));
    let item = s.gallery.import_bytes(
        &album_id,
        file,
        &meta,
        ImportOptions { thumb: if thumb.is_empty() { None } else { Some(thumb) }, command_id: None, item_id: None },
    )?;
    out(json!({"item": item}))
}

#[tauri::command(async)]
pub fn gallery_move_item(s: S<'_>, id: String, album_id: Option<String>) -> R {
    out(json!({"item": s.gallery.move_item(&id, album_id.as_deref().unwrap_or(""))?}))
}

#[tauri::command(async)]
pub fn gallery_delete_item(s: S<'_>, id: String) -> R {
    s.gallery.delete_item(&id)?;
    Ok(Value::Null)
}

#[tauri::command(async)]
pub fn gallery_restore_item(s: S<'_>, id: String) -> R {
    out(json!({"item": s.gallery.restore_item(&id)?}))
}

#[tauri::command(async)]
pub fn gallery_artwork_at(s: S<'_>, id: String, version: i64) -> R {
    out(json!({"artwork": s.gallery.artwork_at(&id, version)?}))
}

// ---------- 抽奖 ----------

#[tauri::command(async)]
pub fn lottery_get_board(s: S<'_>) -> R {
    out(json!({"board": s.lottery.board()?}))
}

#[tauri::command(async)]
pub fn lottery_put_board(s: S<'_>, body: Value) -> R {
    out(json!({"board": s.lottery.configure(&body)?}))
}

#[tauri::command(async)]
pub fn lottery_list_batches(s: S<'_>) -> R {
    out(json!({"batches": s.lottery.list_batches()?}))
}

#[tauri::command(async)]
pub fn lottery_draw(s: S<'_>, body: Value) -> R {
    let album_id = text_of(get(&body, "albumId"));
    if album_id.is_empty() {
        return Err(DomainError::bad("缺少收藏夹"));
    }
    out(json!({"batch": s.lottery.draw(&album_id, &body)?}))
}

#[tauri::command(async)]
pub fn lottery_verify(s: S<'_>, id: String) -> R {
    Ok(s.lottery.verify(&id)?)
}

#[tauri::command(async)]
pub fn lottery_remove_draw(s: S<'_>, id: String, draw_ref: String) -> R {
    out(json!({"batch": s.lottery.remove_draw(&id, &draw_ref)?}))
}

#[tauri::command(async)]
pub fn lottery_delete_batch(s: S<'_>, id: String) -> R {
    s.lottery.delete_batch(&id)?;
    Ok(Value::Null)
}

#[tauri::command(async)]
pub fn lottery_restore_batch(s: S<'_>, id: String) -> R {
    out(json!({"batch": s.lottery.restore_batch(&id)?}))
}

// ---------- NovelAI / 生图 ----------

#[tauri::command]
pub async fn nai_status(s: S<'_>) -> R {
    out(s.generation.token_status().await)
}

#[tauri::command]
pub async fn nai_save_token(s: S<'_>, token: Option<String>) -> R {
    out(s.generation.set_token(token.as_deref().unwrap_or("")).await?)
}

#[tauri::command]
pub async fn nai_clear_token(s: S<'_>) -> R {
    out(s.generation.clear_token().await?)
}

#[tauri::command(async)]
pub fn uc_presets() -> R {
    Ok(json!({"presets": uc_presets_json()}))
}

#[tauri::command(async)]
pub fn param_sets_list(s: S<'_>) -> R {
    out(json!({"paramSets": s.generation.list_param_sets()?}))
}

#[tauri::command(async)]
pub fn param_sets_save(s: S<'_>, name: Option<String>, form: Option<Value>) -> R {
    let form = form.filter(truthy).unwrap_or_else(|| json!({}));
    out(json!({"paramSet": s.generation.save_param_set(name.as_deref().unwrap_or(""), &form)?}))
}

#[tauri::command(async)]
pub fn param_sets_update(s: S<'_>, id: String, form: Option<Value>) -> R {
    let form = form.filter(truthy).unwrap_or_else(|| json!({}));
    out(json!({"paramSet": s.generation.update_param_set(&id, &form)?}))
}

#[tauri::command(async)]
pub fn param_sets_delete(s: S<'_>, id: String) -> R {
    s.generation.delete_param_set(&id)?;
    Ok(Value::Null)
}

/// 上传底图 / 蒙版：请求体就是图片本身，后端统一转 PNG 入库。
#[tauri::command(async)]
pub fn nai_upload_blob(s: S<'_>, request: Request<'_>) -> R {
    let body = raw_body(&request)?;
    out(s.generation.store_upload(body)?)
}

#[tauri::command(async)]
pub fn nai_submit_job(s: S<'_>, body: Value) -> R {
    if !body.is_object() {
        return Err(DomainError::bad("请求格式错误"));
    }
    out(json!({"job": s.generation.enqueue(&body)?}))
}

#[tauri::command(async)]
pub fn nai_estimate(s: S<'_>, body: Value) -> R {
    Ok(s.generation.estimate(&body))
}

#[tauri::command(async)]
pub fn nai_cancel_job(s: S<'_>, id: String) -> R {
    out(json!({"job": s.generation.cancel(&id)?}))
}

#[tauri::command(async)]
pub fn nai_list_jobs(s: S<'_>) -> R {
    out(json!({"jobs": s.generation.list_jobs()?}))
}

/// 对应 SSE 流连上时的第一条 `snapshot` 消息。
#[tauri::command(async)]
pub fn nai_jobs_snapshot(s: S<'_>) -> R {
    out(json!({"type": "snapshot", "jobs": s.generation.list_jobs()?}))
}

#[tauri::command(async)]
pub fn nai_get_job(s: S<'_>, id: String) -> R {
    match s.generation.get_job(&id)? {
        Some(job) => out(json!({"job": job})),
        None => Err(DomainError::not_found("任务不存在")),
    }
}

#[tauri::command(async)]
pub fn nai_history(s: S<'_>, before: Option<i64>, before_id: Option<String>, limit: Option<i64>) -> R {
    out(s.generation.list_history(before, before_id.as_deref().unwrap_or(""), limit.unwrap_or(60))?)
}

#[tauri::command(async)]
pub fn nai_history_delete(s: S<'_>, items: Value) -> R {
    if !items.is_array() {
        return Err(DomainError::bad("请求格式错误"));
    }
    Ok(json!({"removed": s.generation.delete_history(&items)?}))
}

#[tauri::command(async)]
pub fn nai_promote(s: S<'_>, body: Value) -> R {
    let album_id = text_of(get(&body, "albumId"));
    let mut hashes: Vec<Value> = {
        let a = get(&body, "tempIds");
        let src = if truthy(a) { a } else { get(&body, "blobHashes") };
        src.as_array().cloned().unwrap_or_default()
    };
    if truthy(get(&body, "tempId")) {
        hashes.insert(0, get(&body, "tempId").clone());
    }
    let hashes: Vec<String> = hashes.iter().filter(|h| truthy(h)).map(py_str).collect();
    let mut resolved: Vec<String> = Vec::new();
    for h in hashes {
        if h.chars().count() == 64 {
            resolved.push(h);
            continue;
        }
        // 任务条目 id 是 blob 哈希的前 32 位：到任务里找
        for job in s.generation.list_jobs()? {
            for item in get(&job, "items").as_array().cloned().unwrap_or_default() {
                let id_match = get(&item, "id").as_str() == Some(h.as_str());
                let prefix_match = get(&item, "blobHash").as_str().map(|b| b.starts_with(&h)).unwrap_or(false);
                if id_match || prefix_match {
                    resolved.push(py_str(get(&item, "blobHash")));
                }
            }
        }
    }
    if album_id.is_empty() || resolved.is_empty() {
        return Err(DomainError::bad("缺少收藏夹或图片"));
    }
    let meta = if truthy(get(&body, "meta")) { get(&body, "meta").clone() } else { json!({}) };
    out(json!({"items": s.generation.promote(&album_id, &resolved, &meta)?, "saved": true}))
}
