use crate::kernel::{Aggregate, Core, DomainError, Res};
use crate::util::{get, py_str, to_int, truthy};
use serde_json::{json, Map, Value};

pub const BOARD_ID: &str = "lottery-board";

pub fn default_controls() -> Map<String, Value> {
    let v = json!({
        "min": 3, "max": 5, "draws": 8, "target": 1, "wmin": 0.05, "wmax": 1, "jitter": 0.6, "boost": 0.4
    });
    v.as_object().cloned().unwrap()
}

fn list_of(v: &Value) -> Value {
    if truthy(v) {
        v.as_array().map(|a| Value::Array(a.clone())).unwrap_or_else(|| json!([]))
    } else {
        json!([])
    }
}

fn dict_of(v: &Value) -> Value {
    if truthy(v) {
        v.as_object().map(|a| Value::Object(a.clone())).unwrap_or_else(|| json!({}))
    } else {
        json!({})
    }
}

fn merged_controls(extra: &Value) -> Value {
    let mut out = default_controls();
    if truthy(extra) {
        if let Some(o) = extra.as_object() {
            for (k, v) in o {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

pub struct LotteryBoard {
    core: Core,
}

impl LotteryBoard {
    pub fn configure(&mut self, data: &Value) {
        let payload = json!({
            "albumId": get(data, "albumId"),
            "excluded": list_of(get(data, "excluded")),
            "pinned": list_of(get(data, "pinned")),
            "weightCaps": dict_of(get(data, "weightCaps")),
            "controls": merged_controls(get(data, "controls")),
        });
        self.record("BoardConfigured", payload);
    }
}

impl Aggregate for LotteryBoard {
    const TYPE: &'static str = "LotteryBoard";
    fn create(id: &str) -> Self {
        LotteryBoard { core: Core::new(id) }
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn on(&mut self, _t: &str, _p: &Value) {}
}

/// 给每条画师串一个稳定 id，已有的 id 不改。返回是否有改动。
pub fn stamp_draw_ids(draws: &mut [Value], batch_id: &str) -> bool {
    let mut changed = false;
    for (i, raw) in draws.iter_mut().enumerate() {
        let Some(obj) = raw.as_object_mut() else { continue };
        let existing = obj.get("id").map(|v| if truthy(v) { py_str(v) } else { String::new() }).unwrap_or_default();
        if !existing.trim().is_empty() {
            continue;
        }
        obj.insert("id".into(), json!(format!("{batch_id}:{i}")));
        changed = true;
    }
    changed
}

pub fn lottery_client_draw_id(batch_id: &str, client: &Value) -> String {
    let draw_id = if truthy(get(client, "drawId")) { py_str(get(client, "drawId")).trim().to_string() } else { String::new() };
    if !draw_id.is_empty() {
        return draw_id;
    }
    let idx = get(client, "drawIndex");
    if idx.is_null() || py_str(idx).trim().is_empty() {
        return String::new();
    }
    match to_int(idx) {
        Some(i) => format!("{batch_id}:{i}"),
        None => String::new(),
    }
}

pub fn preview_items(items: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(list) = items.as_array() else { return out };
    for raw in list {
        if !raw.is_object() {
            continue;
        }
        let s = |k: &str| if truthy(get(raw, k)) { py_str(get(raw, k)) } else { String::new() };
        let digest = {
            let a = s("blobHash");
            if a.is_empty() { s("id") } else { a }
        };
        let digest = digest.trim().to_string();
        if digest.is_empty() {
            continue;
        }
        let mut url = s("url").trim().to_string();
        if url.is_empty() {
            url = format!("/api/blobs/{digest}");
        }
        let mut thumb = s("thumbUrl").trim().to_string();
        if thumb.is_empty() {
            thumb = url.clone();
        }
        let id = {
            let x = s("id");
            if x.is_empty() { digest.chars().take(32).collect() } else { x }
        };
        let mut rec = Map::new();
        rec.insert("id".into(), json!(id));
        rec.insert("blobHash".into(), json!(digest));
        rec.insert("url".into(), json!(url));
        rec.insert("thumbUrl".into(), json!(thumb));
        for key in ["width", "height", "thumbHash"] {
            let v = get(raw, key);
            let empty = v.is_null() || v.as_str() == Some("");
            if !empty {
                rec.insert(key.into(), v.clone());
            }
        }
        out.push(Value::Object(rec));
    }
    out
}

/// 把完成的抽奖出图按画师串 id 绑上去，不按列表顺序。
pub fn attach_job_previews(
    draws: &mut [Value],
    batch_id: &str,
    job_id: &str,
    client: &Value,
    items: &Value,
    only_if_empty: bool,
) -> bool {
    let draw_id = lottery_client_draw_id(batch_id, client);
    if draw_id.is_empty() {
        return false;
    }
    let shots = preview_items(items);
    if shots.is_empty() {
        return false;
    }
    for raw in draws.iter_mut() {
        let Some(obj) = raw.as_object_mut() else { continue };
        let cur = obj.get("id").map(|v| if truthy(v) { py_str(v) } else { String::new() }).unwrap_or_default();
        if cur != draw_id {
            continue;
        }
        if only_if_empty && obj.get("previews").map(truthy).unwrap_or(false) {
            return false;
        }
        obj.insert("previews".into(), Value::Array(shots));
        obj.insert("jobId".into(), json!(job_id));
        return true;
    }
    false
}

pub struct DrawBatch {
    core: Core,
    pub album_id: String,
    pub seed: i64,
    pub pool_revision: i64,
    pub pool_hash: String,
    pub params: Value,
    pub draws: Vec<Value>,
    pub deleted: bool,
    pub created_at: i64,
}

impl DrawBatch {
    pub fn create_batch(&mut self, data: Value) -> Res<()> {
        if self.core.version > 0 && !self.deleted {
            return Err(DomainError::conflict("批次已存在"));
        }
        if !truthy(get(&data, "draws")) {
            return Err(DomainError::bad("抽奖结果为空"));
        }
        self.record("DrawBatchCreated", data);
        Ok(())
    }

    pub fn remove_draw(&mut self, index: i64, draw_id: Option<&str>) -> Res<()> {
        self.ensure_active()?;
        if index < 0 || index as usize >= self.draws.len() {
            return Err(DomainError::not_found("条目不存在"));
        }
        let mut payload = Map::new();
        payload.insert("index".into(), json!(index));
        let rid = match draw_id {
            Some(d) if !d.is_empty() => d.to_string(),
            _ => {
                let v = get(&self.draws[index as usize], "id");
                if truthy(v) { py_str(v) } else { String::new() }
            }
        };
        let rid = rid.trim().to_string();
        if !rid.is_empty() {
            payload.insert("id".into(), json!(rid));
        }
        self.record("DrawRemoved", Value::Object(payload));
        Ok(())
    }

    pub fn delete(&mut self) -> Res<()> {
        self.ensure_active()?;
        self.record("DrawBatchDeleted", json!({}));
        Ok(())
    }

    pub fn restore(&mut self) -> Res<()> {
        if self.core.version == 0 {
            return Err(DomainError::not_found("批次不存在"));
        }
        if !self.deleted {
            return Ok(());
        }
        self.record("DrawBatchRestored", json!({}));
        Ok(())
    }

    fn ensure_active(&self) -> Res<()> {
        if self.core.version == 0 || self.deleted {
            return Err(DomainError::not_found("批次不存在"));
        }
        Ok(())
    }
}

impl Aggregate for DrawBatch {
    const TYPE: &'static str = "DrawBatch";
    fn create(id: &str) -> Self {
        DrawBatch {
            core: Core::new(id),
            album_id: String::new(),
            seed: 0,
            pool_revision: 0,
            pool_hash: String::new(),
            params: json!({}),
            draws: vec![],
            deleted: false,
            created_at: 0,
        }
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn on(&mut self, t: &str, p: &Value) {
        match t {
            "DrawBatchCreated" => {
                self.album_id = py_str(get(p, "albumId"));
                self.seed = to_int(get(p, "seed")).unwrap_or(0);
                self.pool_revision = to_int(get(p, "poolRevision")).unwrap_or(0);
                self.pool_hash = py_str(get(p, "poolHash"));
                self.params = dict_of(get(p, "params"));
                self.draws = list_of(get(p, "draws")).as_array().cloned().unwrap_or_default();
                self.created_at = to_int(get(p, "createdAt")).unwrap_or(0);
                self.deleted = false;
            }
            "DrawRemoved" => {
                let did = if truthy(get(p, "id")) { py_str(get(p, "id")).trim().to_string() } else { String::new() };
                if !did.is_empty() {
                    for i in 0..self.draws.len() {
                        let cur = get(&self.draws[i], "id");
                        let cur = if truthy(cur) { py_str(cur) } else { String::new() };
                        if cur == did {
                            self.draws.remove(i);
                            return;
                        }
                    }
                }
                if let Some(idx) = to_int(get(p, "index")) {
                    if idx >= 0 && (idx as usize) < self.draws.len() {
                        self.draws.remove(idx as usize);
                    }
                }
            }
            "DrawBatchDeleted" => self.deleted = true,
            "DrawBatchRestored" => self.deleted = false,
            _ => {}
        }
    }
}
