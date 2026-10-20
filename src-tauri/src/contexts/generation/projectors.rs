use crate::kernel::bus::Projector;
use crate::kernel::{Res, StoredEvent};
use crate::pyjson::dumps;
use crate::util::{get, or_else, py_str, sql, truthy};
use rusqlite::types::Value as S;
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Value};

pub struct GenerationProjector;

fn nz<'a>(v: &'a Value, fallback: &'a Value) -> &'a Value {
    or_else(v, fallback)
}

impl Projector for GenerationProjector {
    fn handle(&self, event: &StoredEvent, conn: &Connection) -> Res<()> {
        let p = &event.payload;
        let id = &event.aggregate_id;
        let empty_obj = json!({});
        let empty_list = json!([]);
        match event.event_type.as_str() {
            "ParamSetSaved" => {
                conn.execute(
                    "INSERT INTO projections_param_sets
                        (id, name, form_json, created_at, updated_at, deleted, version)
                     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
                     ON CONFLICT(id) DO UPDATE SET
                        name=excluded.name, form_json=excluded.form_json,
                        created_at=excluded.created_at, updated_at=excluded.updated_at,
                        deleted=0, version=excluded.version",
                    params_from_iter([
                        S::Text(id.clone()),
                        sql(get(p, "name")),
                        S::Text(dumps(nz(get(p, "form"), &empty_obj))),
                        sql(get(p, "createdAt")),
                        sql(get(p, "createdAt")),
                        S::Integer(event.version),
                    ]),
                )?;
            }
            "ParamSetUpdated" => {
                conn.execute(
                    "UPDATE projections_param_sets SET form_json=?1, updated_at=?2, version=?3 WHERE id=?4",
                    params_from_iter([
                        S::Text(dumps(nz(get(p, "form"), &empty_obj))),
                        if truthy(get(p, "updatedAt")) { sql(get(p, "updatedAt")) } else { S::Integer(0) },
                        S::Integer(event.version),
                        S::Text(id.clone()),
                    ]),
                )?;
            }
            "ParamSetDeleted" => {
                conn.execute(
                    "UPDATE projections_param_sets SET deleted=1, version=?1 WHERE id=?2",
                    params![event.version, id],
                )?;
            }
            "ParamSetRestored" => {
                conn.execute(
                    "UPDATE projections_param_sets SET deleted=0, version=?1 WHERE id=?2",
                    params![event.version, id],
                )?;
            }
            "JobQueued" => {
                conn.execute(
                    "INSERT INTO projections_jobs (
                        id, source, status, progress_json, items_json, meta_json, error,
                        subscription_json, client_json, preview_hash, created_at, started_at,
                        finished_at, version
                     ) VALUES (?1, ?2, 'queued', ?3, '[]', '{}', NULL, NULL, ?4, NULL, ?5, NULL, NULL, ?6)
                     ON CONFLICT(id) DO UPDATE SET
                        source=excluded.source, status='queued', progress_json=excluded.progress_json,
                        client_json=excluded.client_json, created_at=excluded.created_at,
                        version=excluded.version",
                    params_from_iter([
                        S::Text(id.clone()),
                        S::Text(if truthy(get(p, "source")) { py_str(get(p, "source")) } else { "studio".into() }),
                        S::Text(dumps(nz(get(p, "progress"), &empty_obj))),
                        S::Text(dumps(nz(get(p, "client"), &empty_obj))),
                        if truthy(get(p, "createdAt")) { sql(get(p, "createdAt")) } else { S::Integer(0) },
                        S::Integer(event.version),
                    ]),
                )?;
            }
            "JobStarted" => {
                conn.execute(
                    "UPDATE projections_jobs SET status='running', started_at=?1, version=?2 WHERE id=?3",
                    params_from_iter([sql(get(p, "startedAt")), S::Integer(event.version), S::Text(id.clone())]),
                )?;
            }
            "JobPreviewed" => {
                let row: Option<Option<String>> = conn
                    .query_row("SELECT progress_json FROM projections_jobs WHERE id=?1", params![id], |r| r.get(0))
                    .ok();
                let mut progress = row
                    .flatten()
                    .filter(|s| !s.is_empty())
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .filter(|v| v.is_object())
                    .unwrap_or_else(|| json!({}));
                let text = if truthy(get(p, "text")) { py_str(get(p, "text")) } else { "生成中".into() };
                progress["step"] = get(p, "step").clone();
                progress["sample"] = get(p, "sample").clone();
                progress["text"] = json!(text);
                conn.execute(
                    "UPDATE projections_jobs SET progress_json=?1, preview_hash=?2, version=?3 WHERE id=?4",
                    params_from_iter([
                        S::Text(dumps(&progress)),
                        sql(get(p, "previewHash")),
                        S::Integer(event.version),
                        S::Text(id.clone()),
                    ]),
                )?;
            }
            "JobCompleted" => {
                let sub = get(p, "subscription");
                conn.execute(
                    "UPDATE projections_jobs SET status='done', items_json=?1, meta_json=?2,
                        subscription_json=?3, finished_at=?4, error=NULL, version=?5,
                        progress_json=?6
                     WHERE id=?7",
                    params_from_iter([
                        S::Text(dumps(nz(get(p, "items"), &empty_list))),
                        S::Text(dumps(nz(get(p, "meta"), &empty_obj))),
                        if sub.is_null() { S::Null } else { S::Text(dumps(sub)) },
                        sql(get(p, "finishedAt")),
                        S::Integer(event.version),
                        S::Text(dumps(&json!({"text": "完成"}))),
                        S::Text(id.clone()),
                    ]),
                )?;
            }
            "JobItemsRemoved" => {
                let row: Option<Option<String>> = conn
                    .query_row("SELECT items_json FROM projections_jobs WHERE id=?1", params![id], |r| r.get(0))
                    .ok();
                if let Some(text) = row {
                    let gone: std::collections::HashSet<String> = get(p, "itemIds")
                        .as_array()
                        .map(|a| a.iter().map(py_str).collect())
                        .unwrap_or_default();
                    let items: Vec<Value> = text
                        .filter(|s| !s.is_empty())
                        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                        .and_then(|v| v.as_array().cloned())
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|it| !gone.contains(&py_str(get(it, "id"))))
                        .collect();
                    conn.execute(
                        "UPDATE projections_jobs SET items_json=?1, version=?2 WHERE id=?3",
                        params![dumps(&Value::Array(items)), event.version, id],
                    )?;
                }
            }
            "JobFailed" => {
                conn.execute(
                    "UPDATE projections_jobs SET status='error', error=?1, finished_at=?2, version=?3 WHERE id=?4",
                    params_from_iter([
                        sql(get(p, "error")),
                        sql(get(p, "finishedAt")),
                        S::Integer(event.version),
                        S::Text(id.clone()),
                    ]),
                )?;
            }
            "JobCancelled" => {
                conn.execute(
                    "UPDATE projections_jobs SET status='cancelled', error='已取消', finished_at=?1, version=?2 WHERE id=?3",
                    params_from_iter([sql(get(p, "finishedAt")), S::Integer(event.version), S::Text(id.clone())]),
                )?;
            }
            _ => {}
        }
        Ok(())
    }
}
