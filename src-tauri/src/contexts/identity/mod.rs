use crate::kernel::bus::Projector;
use crate::kernel::{Aggregate, Core, Res, StoredEvent};
use crate::util::{get, py_str, truthy};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub const CREDENTIAL_ID: &str = "nai";

pub struct Credential {
    core: Core,
    pub configured: bool,
    pub hint: String,
}

impl Credential {
    pub fn set_hint(&mut self, hint: &str) {
        self.record("CredentialSet", json!({"hint": hint}));
    }

    pub fn clear(&mut self) {
        self.record("CredentialCleared", json!({}));
    }
}

impl Aggregate for Credential {
    const TYPE: &'static str = "Credential";
    fn create(id: &str) -> Self {
        Credential { core: Core::new(id), configured: false, hint: String::new() }
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn on(&mut self, t: &str, p: &Value) {
        match t {
            "CredentialSet" => {
                self.configured = true;
                self.hint = if truthy(get(p, "hint")) { py_str(get(p, "hint")) } else { "已保存".into() };
            }
            "CredentialCleared" => {
                self.configured = false;
                self.hint.clear();
            }
            _ => {}
        }
    }
}

pub struct IdentityProjector;

impl Projector for IdentityProjector {
    fn handle(&self, event: &StoredEvent, conn: &Connection) -> Res<()> {
        match event.event_type.as_str() {
            "CredentialSet" => {
                let hint = if truthy(get(&event.payload, "hint")) { py_str(get(&event.payload, "hint")) } else { String::new() };
                conn.execute(
                    "INSERT INTO projections_identity (id, configured, hint, version) VALUES (?1, 1, ?2, ?3)
                     ON CONFLICT(id) DO UPDATE SET configured=1, hint=excluded.hint, version=excluded.version",
                    params![event.aggregate_id, hint, event.version],
                )?;
            }
            "CredentialCleared" => {
                conn.execute(
                    "INSERT INTO projections_identity (id, configured, hint, version) VALUES (?1, 0, '', ?2)
                     ON CONFLICT(id) DO UPDATE SET configured=0, hint='', version=excluded.version",
                    params![event.aggregate_id, event.version],
                )?;
            }
            _ => {}
        }
        Ok(())
    }
}
