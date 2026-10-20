use super::schema::{clean_patch, defaults, has_section, normalize, py_eq, section_defaults};
use crate::kernel::{Aggregate, Core};
use serde_json::{json, Map, Value};

pub const SETTINGS_ID: &str = "app-settings";

/// 聚合与投影共用的纯函数，保证重放结果一致。
pub fn apply_change(data: &Value, event_type: &str, payload: &Value) -> Value {
    let mut out = normalize(data);
    match event_type {
        "SettingsUpdated" => {
            let patch = payload.get("patch").cloned().unwrap_or(Value::Null);
            for (section, part) in clean_patch(&patch) {
                if let (Some(target), Some(part)) = (out.get_mut(&section).and_then(|v| v.as_object_mut()), part.as_object()) {
                    for (k, v) in part {
                        target.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        "SettingsReset" => {
            match payload.get("section").and_then(|v| v.as_str()) {
                Some(s) if has_section(s) => out[s] = section_defaults(s),
                _ => out = defaults(),
            }
        }
        _ => {}
    }
    out
}

/// 全局设置：一个聚合，事件只记录变更的字段，重放后得到当前设置。
pub struct AppSettings {
    core: Core,
    pub data: Value,
}

impl AppSettings {
    pub fn update(&mut self, patch: &Value) -> bool {
        let cleaned = clean_patch(patch);
        let mut changed = Map::new();
        for (section, part) in cleaned {
            let mut diff = Map::new();
            if let Some(part) = part.as_object() {
                for (k, v) in part {
                    let same = self.data.get(&section).and_then(|s| s.get(k)).map(|cur| py_eq(cur, v)).unwrap_or(false);
                    if !same {
                        diff.insert(k.clone(), v.clone());
                    }
                }
            }
            if !diff.is_empty() {
                changed.insert(section, Value::Object(diff));
            }
        }
        if changed.is_empty() {
            return false;
        }
        self.record("SettingsUpdated", json!({"patch": changed}));
        true
    }

    pub fn reset(&mut self, section: Option<&str>) -> bool {
        let target = section.filter(|s| has_section(s));
        let fresh = defaults();
        match target {
            Some(t) => {
                if py_eq(&self.data[t], &fresh[t]) {
                    return false;
                }
            }
            None => {
                if py_eq(&self.data, &fresh) {
                    return false;
                }
            }
        }
        self.record("SettingsReset", json!({"section": target}));
        true
    }
}

impl Aggregate for AppSettings {
    const TYPE: &'static str = "AppSettings";
    fn create(id: &str) -> Self {
        AppSettings { core: Core::new(id), data: defaults() }
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn on(&mut self, t: &str, p: &Value) {
        if t == "SettingsUpdated" || t == "SettingsReset" {
            self.data = apply_change(&self.data, t, p);
        }
    }
}
