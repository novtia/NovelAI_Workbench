pub mod app;
pub mod assets;
pub mod commands;
pub mod contexts;
pub mod kernel;
pub mod protocol;
pub mod pyjson;
pub mod pyrandom;
pub mod util;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// 数据目录：环境变量 `WORKBENCH_DATA_DIR` > 开发模式的 `backend/data` > exe 旁的 `data/` > 系统应用数据目录。
fn resolve_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("WORKBENCH_DATA_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    if cfg!(debug_assertions) {
        if let Some(workbench) = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            return workbench.join("backend").join("data");
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent().map(|p| p.join("data")).filter(|p| p.is_dir()) {
            return dir;
        }
    }
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("data"))
}

/// 旧版 `ddd/data`（只在开发目录结构下存在），用于空库时的一次性迁入。
fn resolve_legacy_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("WORKBENCH_LEGACY_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    if cfg!(debug_assertions) {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        return manifest.parent()?.parent().map(|p| p.join("ddd").join("data"));
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("wb", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let response = match app.try_state::<Arc<app::Services>>() {
                    Some(svc) => protocol::handle(svc.inner(), &request),
                    None => {
                        let mut r = tauri::http::Response::new(std::borrow::Cow::Borrowed(&b"starting"[..]));
                        *r.status_mut() = tauri::http::StatusCode::SERVICE_UNAVAILABLE;
                        r
                    }
                };
                responder.respond(response);
            });
        })
        .setup(|app| {
            let data_dir = resolve_data_dir(app.handle());
            let services = Arc::new(app::build(&data_dir).map_err(|e| format!("无法打开数据目录 {}：{}", data_dir.display(), e))?);
            app::prepare(&services, resolve_legacy_dir().as_deref()).map_err(|e| format!("初始化数据失败：{e}"))?;
            {
                let handle = app.handle().clone();
                services.generation.set_emitter(Arc::new(move |payload| {
                    let _ = handle.emit("jobs-event", util::to_client(payload));
                }));
            }
            contexts::generation::worker::start_workers(services.generation.clone());
            app.manage(services);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::health,
            commands::integrity_verify,
            commands::integrity_rebuild,
            commands::integrity_backup,
            commands::db_export,
            commands::db_export_pack,
            commands::db_import,
            commands::settings_get,
            commands::settings_put,
            commands::settings_reset,
            commands::settings_import,
            commands::settings_system,
            commands::gallery_list_albums,
            commands::gallery_create_album,
            commands::gallery_get_view,
            commands::gallery_put_view,
            commands::gallery_get_basket,
            commands::gallery_add_basket,
            commands::gallery_remove_basket,
            commands::gallery_clear_basket,
            commands::gallery_create_test_set,
            commands::gallery_rename_album,
            commands::gallery_delete_album,
            commands::gallery_restore_album,
            commands::gallery_list_items,
            commands::gallery_clear_album,
            commands::gallery_has_hash,
            commands::gallery_import_item,
            commands::gallery_move_item,
            commands::gallery_delete_item,
            commands::gallery_restore_item,
            commands::gallery_artwork_at,
            commands::lottery_get_board,
            commands::lottery_put_board,
            commands::lottery_list_batches,
            commands::lottery_draw,
            commands::lottery_verify,
            commands::lottery_remove_draw,
            commands::lottery_delete_batch,
            commands::lottery_restore_batch,
            commands::nai_status,
            commands::nai_save_token,
            commands::nai_clear_token,
            commands::uc_presets,
            commands::param_sets_list,
            commands::param_sets_save,
            commands::param_sets_update,
            commands::param_sets_delete,
            commands::nai_upload_blob,
            commands::nai_submit_job,
            commands::nai_estimate,
            commands::nai_cancel_job,
            commands::nai_list_jobs,
            commands::nai_jobs_snapshot,
            commands::nai_get_job,
            commands::nai_history,
            commands::nai_history_delete,
            commands::nai_promote,
        ])
        .run(tauri::generate_context!())
        .expect("启动画师串工作台失败");
}
