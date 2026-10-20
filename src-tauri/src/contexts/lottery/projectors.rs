use super::domain::attach_job_previews;
use crate::kernel::bus::Projector;
use crate::kernel::{Res, StoredEvent};
use crate::pyjson::dumps;
use crate::util::{get, or_else, py_str, sql, to_int, truthy};
use rusqlite::types::Value as S;
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Value};

pub struct LotteryProjector;

fn parse(text: Option<String>, fallback: Value) -> Value {
    text.filter(|s| !s.is_empty()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(fallback)
}

impl Projector for LotteryProjector {
    fn handle(&self, event: &StoredEvent, conn: &Connection) -> Res<()> {
        let p = &event.payload;
        let id = &event.aggregate_id;
        match event.event_type.as_str() {
            "BoardConfigured" => {
                let empty_list = json!([]);
                let empty_obj = json!({});
                conn.execute(
                    "INSERT INTO projections_lottery_board
                        (id, album_id, excluded_json, pinned_json, weight_caps_json, controls_json, version)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(id) DO UPDATE SET
                        album_id=excluded.album_id, excluded_json=excluded.excluded_json,
                        pinned_json=excluded.pinned_json, weight_caps_json=excluded.weight_caps_json,
                        controls_json=excluded.controls_json, version=excluded.version",
                    params_from_iter([
                        S::Text(id.clone()),
                        sql(get(p, "albumId")),
                        S::Text(dumps(or_else(get(p, "excluded"), &empty_list))),
                        S::Text(dumps(or_else(get(p, "pinned"), &empty_list))),
                        S::Text(dumps(or_else(get(p, "weightCaps"), &empty_obj))),
                        S::Text(dumps(or_else(get(p, "controls"), &empty_obj))),
                        S::Integer(event.version),
                    ]),
                )?;
            }
            "DrawBatchCreated" => {
                let empty_list = json!([]);
                let empty_obj = json!({});
                conn.execute(
                    "INSERT INTO projections_lottery_batches
                        (id, album_id, seed, pool_revision, pool_hash, params_json, draws_json,
                         created_at, deleted, version)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)
                     ON CONFLICT(id) DO UPDATE SET
                        album_id=excluded.album_id, seed=excluded.seed, pool_revision=excluded.pool_revision,
                        pool_hash=excluded.pool_hash, params_json=excluded.params_json,
                        draws_json=excluded.draws_json, created_at=excluded.created_at,
                        deleted=0, version=excluded.version",
                    params_from_iter([
                        S::Text(id.clone()),
                        sql(get(p, "albumId")),
                        sql(get(p, "seed")),
                        if truthy(get(p, "poolRevision")) { sql(get(p, "poolRevision")) } else { S::Integer(0) },
                        sql(get(p, "poolHash")),
                        S::Text(dumps(or_else(get(p, "params"), &empty_obj))),
                        S::Text(dumps(or_else(get(p, "draws"), &empty_list))),
                        if truthy(get(p, "createdAt")) { sql(get(p, "createdAt")) } else { S::Integer(0) },
                        S::Integer(event.version),
                    ]),
                )?;
            }
            "DrawRemoved" => {
                let row: Option<String> = conn
                    .query_row("SELECT draws_json FROM projections_lottery_batches WHERE id=?1", params![id], |r| r.get(0))
                    .ok();
                let Some(text) = row else { return Ok(()) };
                let mut draws: Vec<Value> =
                    parse(Some(text), json!([])).as_array().cloned().unwrap_or_default();
                let did = if truthy(get(p, "id")) { py_str(get(p, "id")).trim().to_string() } else { String::new() };
                let mut removed = false;
                if !did.is_empty() {
                    let kept: Vec<Value> = draws
                        .iter()
                        .filter(|d| {
                            let cur = get(d, "id");
                            (if truthy(cur) { py_str(cur) } else { String::new() }) != did
                        })
                        .cloned()
                        .collect();
                    if kept.len() != draws.len() {
                        draws = kept;
                        removed = true;
                    }
                }
                if !removed {
                    if let Some(idx) = to_int(get(p, "index")) {
                        if idx >= 0 && (idx as usize) < draws.len() {
                            draws.remove(idx as usize);
                        }
                    }
                }
                conn.execute(
                    "UPDATE projections_lottery_batches SET draws_json=?1, version=?2 WHERE id=?3",
                    params![dumps(&Value::Array(draws)), event.version, id],
                )?;
            }
            "DrawBatchDeleted" => {
                conn.execute(
                    "UPDATE projections_lottery_batches SET deleted=1, version=?1 WHERE id=?2",
                    params![event.version, id],
                )?;
            }
            "DrawBatchRestored" => {
                conn.execute(
                    "UPDATE projections_lottery_batches SET deleted=0, version=?1 WHERE id=?2",
                    params![event.version, id],
                )?;
            }
            "JobCompleted" => {
                let job: Option<(Option<String>, Option<String>)> = conn
                    .query_row("SELECT source, client_json FROM projections_jobs WHERE id=?1", params![id], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .ok();
                let Some((source, client_json)) = job else { return Ok(()) };
                if source.unwrap_or_default() != "lottery" {
                    return Ok(());
                }
                let client = parse(client_json, json!({}));
                if !client.is_object() {
                    return Ok(());
                }
                let batch_id = if truthy(get(&client, "batchId")) { py_str(get(&client, "batchId")).trim().to_string() } else { String::new() };
                if batch_id.is_empty() {
                    return Ok(());
                }
                let row: Option<String> = conn
                    .query_row(
                        "SELECT draws_json FROM projections_lottery_batches WHERE id=?1",
                        params![batch_id],
                        |r| r.get(0),
                    )
                    .ok();
                let Some(text) = row else { return Ok(()) };
                let parsed = parse(Some(text), json!([]));
                let Some(mut draws) = parsed.as_array().cloned() else { return Ok(()) };
                let items = or_else(get(p, "items"), &json!([])).clone();
                if attach_job_previews(&mut draws, &batch_id, id, &client, &items, false) {
                    conn.execute(
                        "UPDATE projections_lottery_batches SET draws_json=?1 WHERE id=?2",
                        params![dumps(&Value::Array(draws)), batch_id],
                    )?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
