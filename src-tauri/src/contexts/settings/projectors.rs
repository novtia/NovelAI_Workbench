use super::domain::{apply_change, SETTINGS_ID};
use crate::kernel::bus::Projector;
use crate::kernel::{Res, StoredEvent};
use crate::pyjson::dumps_sorted;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub struct SettingsProjector;

impl Projector for SettingsProjector {
    fn handle(&self, event: &StoredEvent, conn: &Connection) -> Res<()> {
        if event.aggregate_id != SETTINGS_ID
            || (event.event_type != "SettingsUpdated" && event.event_type != "SettingsReset")
        {
            return Ok(());
        }
        let row: Option<String> = conn
            .query_row("SELECT data_json FROM projections_settings WHERE id=?1", params![SETTINGS_ID], |r| r.get(0))
            .ok();
        let current: Value = row.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}));
        let payload = if event.payload.is_null() { json!({}) } else { event.payload.clone() };
        let data = apply_change(&current, &event.event_type, &payload);
        conn.execute(
            "INSERT INTO projections_settings (id, data_json, version) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version",
            params![SETTINGS_ID, dumps_sorted(&data), event.version],
        )?;
        Ok(())
    }
}
