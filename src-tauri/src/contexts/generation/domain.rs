use crate::kernel::{Aggregate, Core, DomainError, Res};
use crate::util::{get, py_str, to_int, truthy};
use serde_json::{json, Map, Value};

fn obj_of(v: &Value) -> Map<String, Value> {
    if truthy(v) { v.as_object().cloned().unwrap_or_default() } else { Map::new() }
}

pub struct ParamSet {
    core: Core,
    pub name: String,
    pub form: Map<String, Value>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted: bool,
}

impl ParamSet {
    pub fn save(&mut self, name: &str, form: &Value, created_at: i64) -> Res<()> {
        if self.core.version > 0 && !self.deleted {
            return Err(DomainError::conflict("预设已存在"));
        }
        let name: String = name.trim().chars().take(40).collect();
        if name.is_empty() {
            return Err(DomainError::bad("名称不能为空"));
        }
        self.record("ParamSetSaved", json!({"name": name, "form": form, "createdAt": created_at}));
        Ok(())
    }

    pub fn update(&mut self, form: &Value, updated_at: i64) -> Res<()> {
        if self.core.version == 0 || self.deleted {
            return Err(DomainError::not_found("预设不存在"));
        }
        let name = self.name.clone();
        self.record("ParamSetUpdated", json!({"form": form, "updatedAt": updated_at, "name": name}));
        Ok(())
    }

    pub fn delete(&mut self) -> Res<()> {
        if self.core.version == 0 || self.deleted {
            return Err(DomainError::not_found("预设不存在"));
        }
        self.record("ParamSetDeleted", json!({}));
        Ok(())
    }

    pub fn restore(&mut self) -> Res<()> {
        if self.core.version == 0 {
            return Err(DomainError::not_found("预设不存在"));
        }
        if !self.deleted {
            return Ok(());
        }
        self.record("ParamSetRestored", json!({}));
        Ok(())
    }
}

impl Aggregate for ParamSet {
    const TYPE: &'static str = "ParamSet";
    fn create(id: &str) -> Self {
        ParamSet {
            core: Core::new(id),
            name: String::new(),
            form: Map::new(),
            created_at: 0,
            updated_at: 0,
            deleted: false,
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
            "ParamSetSaved" => {
                self.name = py_str(get(p, "name"));
                self.form = obj_of(get(p, "form"));
                self.created_at = to_int(get(p, "createdAt")).unwrap_or(0);
                self.updated_at = self.created_at;
                self.deleted = false;
            }
            "ParamSetUpdated" => {
                self.form = obj_of(get(p, "form"));
                if truthy(get(p, "updatedAt")) {
                    self.updated_at = to_int(get(p, "updatedAt")).unwrap_or(self.updated_at);
                }
                if truthy(get(p, "name")) {
                    self.name = py_str(get(p, "name"));
                }
            }
            "ParamSetDeleted" => self.deleted = true,
            "ParamSetRestored" => self.deleted = false,
            _ => {}
        }
    }
}

pub struct GenerationJob {
    core: Core,
    pub source: String,
    pub status: String,
    pub payload: Map<String, Value>,
    pub client: Map<String, Value>,
    pub progress: Map<String, Value>,
    pub items: Vec<Value>,
    pub meta: Map<String, Value>,
    pub error: Option<String>,
    pub subscription: Option<Value>,
    pub preview_hash: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub cancel_requested: bool,
}

impl GenerationJob {
    pub fn version(&self) -> i64 {
        self.core.version
    }

    pub fn queue(&mut self, data: Value) -> Res<()> {
        if self.core.version > 0 {
            return Err(DomainError::conflict("任务已存在"));
        }
        self.record("JobQueued", data);
        Ok(())
    }

    pub fn start(&mut self, started_at: i64) {
        if self.status == "cancelled" || self.cancel_requested {
            return;
        }
        self.record("JobStarted", json!({"startedAt": started_at}));
    }

    pub fn preview(&mut self, sample: i64, step: Value, blob_hash: Option<&str>, text: &str) {
        self.record(
            "JobPreviewed",
            json!({"sample": sample, "step": step, "previewHash": blob_hash, "text": text}),
        );
    }

    pub fn complete(&mut self, items: Value, meta: Value, subscription: Value, finished_at: i64) {
        self.record(
            "JobCompleted",
            json!({"items": items, "meta": meta, "subscription": subscription, "finishedAt": finished_at}),
        );
    }

    pub fn fail(&mut self, error: &str, finished_at: i64) {
        self.record("JobFailed", json!({"error": error, "finishedAt": finished_at}));
    }

    pub fn cancel(&mut self, finished_at: i64) {
        if matches!(self.status.as_str(), "done" | "error" | "cancelled") {
            return;
        }
        self.record("JobCancelled", json!({"finishedAt": finished_at}));
    }

    /// 从历史里移除已完成任务的若干张图，只改记录，不碰 blob 文件。返回实际移除的 id。
    pub fn remove_items(&mut self, item_ids: &[String], removed_at: i64) -> Res<Vec<String>> {
        if self.core.version == 0 {
            return Err(DomainError::not_found("任务不存在"));
        }
        if self.status != "done" {
            return Err(DomainError::conflict("任务还没完成"));
        }
        let wanted: std::collections::HashSet<&str> =
            item_ids.iter().map(|s| s.as_str()).filter(|s| !s.is_empty()).collect();
        let hit: Vec<String> = self
            .items
            .iter()
            .map(|it| py_str(get(it, "id")))
            .filter(|id| wanted.contains(id.as_str()))
            .collect();
        if hit.is_empty() {
            return Ok(vec![]);
        }
        self.record("JobItemsRemoved", json!({"itemIds": hit, "removedAt": removed_at}));
        Ok(hit)
    }
}

impl Aggregate for GenerationJob {
    const TYPE: &'static str = "GenerationJob";
    fn create(id: &str) -> Self {
        GenerationJob {
            core: Core::new(id),
            source: "studio".into(),
            status: "queued".into(),
            payload: Map::new(),
            client: Map::new(),
            progress: Map::new(),
            items: vec![],
            meta: Map::new(),
            error: None,
            subscription: None,
            preview_hash: None,
            created_at: 0,
            started_at: None,
            finished_at: None,
            cancel_requested: false,
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
            "JobQueued" => {
                self.source = if truthy(get(p, "source")) { py_str(get(p, "source")) } else { "studio".into() };
                self.status = "queued".into();
                self.payload = obj_of(get(p, "payload"));
                self.client = obj_of(get(p, "client"));
                self.progress = obj_of(get(p, "progress"));
                self.created_at = to_int(get(p, "createdAt")).unwrap_or(0);
            }
            "JobStarted" => {
                self.status = "running".into();
                self.started_at = to_int(get(p, "startedAt"));
            }
            "JobPreviewed" => {
                self.preview_hash = get(p, "previewHash").as_str().map(|s| s.to_string());
                self.progress.insert("step".into(), get(p, "step").clone());
                self.progress.insert("sample".into(), get(p, "sample").clone());
                let text = if truthy(get(p, "text")) { py_str(get(p, "text")) } else { "生成中".into() };
                self.progress.insert("text".into(), json!(text));
            }
            "JobCompleted" => {
                self.status = "done".into();
                self.items = if truthy(get(p, "items")) { get(p, "items").as_array().cloned().unwrap_or_default() } else { vec![] };
                self.meta = obj_of(get(p, "meta"));
                self.subscription = match get(p, "subscription") {
                    Value::Null => None,
                    v => Some(v.clone()),
                };
                self.finished_at = to_int(get(p, "finishedAt"));
                self.progress.insert("text".into(), json!("完成"));
            }
            "JobFailed" => {
                self.status = "error".into();
                self.error = get(p, "error").as_str().map(|s| s.to_string());
                self.finished_at = to_int(get(p, "finishedAt"));
                self.progress.insert("text".into(), json!("失败"));
            }
            "JobCancelled" => {
                self.status = "cancelled".into();
                self.cancel_requested = true;
                self.error = Some("已取消".into());
                self.finished_at = to_int(get(p, "finishedAt"));
                self.progress.insert("text".into(), json!("已取消"));
            }
            "JobItemsRemoved" => {
                let gone: std::collections::HashSet<String> = get(p, "itemIds")
                    .as_array()
                    .map(|a| a.iter().map(py_str).collect())
                    .unwrap_or_default();
                self.items.retain(|it| !gone.contains(&py_str(get(it, "id"))));
            }
            _ => {}
        }
    }
}
