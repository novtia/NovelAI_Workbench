use super::domain::{GenerationJob, ParamSet};
use super::nai_client::{NaiGateway, TokenVault};
use super::nai_images::{image_to_png};
use super::nai_payload::*;
use crate::assets;
use crate::contexts::gallery::application::{GalleryService, ImportOptions};
use crate::contexts::gallery::rules::extract_artists;
use crate::contexts::identity::Credential;
use crate::contexts::settings::application::SettingsService;
use crate::kernel::blobs::png_size;
use crate::kernel::bus::Kernel;
use crate::kernel::clock::{new_hex, new_id, now_ms};
use crate::kernel::{DomainError, Res};
use crate::util::{get, py_str, to_int, truthy};
use rusqlite::types::Value as S;
use rusqlite::{params_from_iter, Row};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

pub const JOB_SOURCES: [&str; 3] = ["studio", "lottery", "gallery"];

pub type Emitter = Arc<dyn Fn(Value) + Send + Sync>;

pub struct GenerationService {
    pub k: Arc<Kernel>,
    pub gallery: Arc<GalleryService>,
    pub gateway: Arc<NaiGateway>,
    pub vault: Arc<TokenVault>,
    pub settings: Arc<SettingsService>,
    emitter: RwLock<Option<Emitter>>,
    queue_tx: UnboundedSender<String>,
    queue_rx: Mutex<Option<UnboundedReceiver<String>>>,
    cancel: Mutex<HashSet<String>>,
    status_cache: Mutex<Option<(Instant, Value)>>,
}

fn text_json(raw: Option<String>, fallback: &str) -> Value {
    let text = raw.filter(|s| !s.is_empty()).unwrap_or_else(|| fallback.to_string());
    serde_json::from_str(&text).unwrap_or_else(|_| serde_json::from_str(fallback).unwrap())
}

impl GenerationService {
    pub fn new(
        k: Arc<Kernel>,
        gallery: Arc<GalleryService>,
        gateway: Arc<NaiGateway>,
        vault: Arc<TokenVault>,
        settings: Arc<SettingsService>,
    ) -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        GenerationService {
            k,
            gallery,
            gateway,
            vault,
            settings,
            emitter: RwLock::new(None),
            queue_tx: tx,
            queue_rx: Mutex::new(Some(rx)),
            cancel: Mutex::new(HashSet::new()),
            status_cache: Mutex::new(None),
        }
    }

    pub fn set_emitter(&self, e: Emitter) {
        *self.emitter.write().unwrap_or_else(|x| x.into_inner()) = Some(e);
    }

    pub fn emit(&self, payload: Value) {
        let e = self.emitter.read().unwrap_or_else(|x| x.into_inner()).clone();
        if let Some(e) = e {
            e(payload);
        }
    }

    pub fn take_receiver(&self) -> Option<UnboundedReceiver<String>> {
        self.queue_rx.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// 读取设置项；缺失时回落到默认值。
    pub fn cfg(&self, section: &str, key: &str, default: Value) -> Value {
        let v = self.settings.value(section, key);
        if v.is_null() { default } else { v }
    }

    pub async fn token_status(&self) -> Value {
        let ttl = crate::util::to_float(&self.cfg("account", "statusTtlSec", json!(45))).unwrap_or(45.0);
        {
            let cache = self.status_cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((at, v)) = cache.as_ref() {
                if at.elapsed().as_secs_f64() < ttl {
                    return v.clone();
                }
            }
        }
        let token = self.vault.load();
        let mut out = json!({
            "configured": !token.is_empty(),
            "hint": if token.is_empty() { String::new() } else { token_hint(&token) },
            "subscription": Value::Null,
        });
        if !token.is_empty() {
            match self.gateway.fetch_subscription(Some(&token)).await {
                Ok(sub) => out["subscription"] = sub,
                Err(e) => {
                    out["error"] = json!(e.message);
                    out["errorStatus"] = json!(e.status);
                }
            }
        }
        *self.status_cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), out.clone()));
        out
    }

    pub fn invalidate_status(&self) {
        *self.status_cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// 画布工具栏的 Anlas 估算；只是估算，以订阅余额的实际变化为准。
    pub fn estimate(&self, body: &Value) -> Value {
        estimate_costs(if body.is_object() { body } else { &Value::Null })
    }

    fn previews_dir(&self) -> PathBuf {
        let dir = self.k.blobs.root.parent().map(|p| p.join("previews")).unwrap_or_else(|| PathBuf::from("previews"));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    pub fn preview_path(&self, job_id: &str, sample: i64) -> PathBuf {
        self.previews_dir().join(format!("{job_id}-{sample}.png"))
    }

    pub fn write_preview(&self, job_id: &str, sample: i64, data: &[u8]) -> String {
        let _ = std::fs::write(self.preview_path(job_id, sample), data);
        assets::preview_path(job_id, sample)
    }

    pub fn clear_previews(&self, job_id: &str) {
        let dir = self.k.blobs.root.parent().map(|p| p.join("previews"));
        let Some(dir) = dir.filter(|d| d.is_dir()) else { return };
        let prefix = format!("{job_id}-");
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with(&prefix) && name.ends_with(".png") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }

    pub async fn set_token(&self, token: &str) -> Res<Value> {
        self.invalidate_status();
        let token = token.trim();
        if token.is_empty() {
            return Err(DomainError::bad("Token 不能为空"));
        }
        self.vault.save(token);
        let mut cred: Credential = self.k.load("nai")?;
        cred.set_hint(&token_hint(token));
        self.k.commit(&mut cred, Some(&format!("identity.set:{}", now_ms())))?;
        Ok(self.token_status().await)
    }

    pub async fn clear_token(&self) -> Res<Value> {
        self.invalidate_status();
        self.vault.save("");
        let mut cred: Credential = self.k.load("nai")?;
        cred.clear();
        self.k.commit(&mut cred, None)?;
        Ok(self.token_status().await)
    }

    // ---------- 参数预设 ----------

    pub fn list_param_sets(&self) -> Res<Vec<Value>> {
        let conn = self.k.store.connect()?;
        let mut stmt = conn.prepare("SELECT * FROM projections_param_sets WHERE deleted=0 ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], param_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn save_param_set(&self, name: &str, form: &Value) -> Res<Value> {
        let sid = new_id();
        let created = now_ms();
        let mut agg: ParamSet = self.k.load(&sid)?;
        agg.save(name, form, created)?;
        self.k.commit(&mut agg, None)?;
        self.get_param_set(&sid)?.ok_or_else(|| DomainError::internal("保存失败"))
    }

    pub fn update_param_set(&self, sid: &str, form: &Value) -> Res<Value> {
        let mut agg: ParamSet = self.k.load(sid)?;
        agg.update(form, now_ms())?;
        self.k.commit(&mut agg, None)?;
        self.get_param_set(sid)?.ok_or_else(|| DomainError::not_found("预设不存在"))
    }

    pub fn delete_param_set(&self, sid: &str) -> Res<()> {
        let mut agg: ParamSet = self.k.load(sid)?;
        agg.delete()?;
        self.k.commit(&mut agg, None)?;
        Ok(())
    }

    pub fn get_param_set(&self, sid: &str) -> Res<Option<Value>> {
        let conn = self.k.store.connect()?;
        let mut stmt = conn.prepare("SELECT * FROM projections_param_sets WHERE id=?1 AND deleted=0")?;
        let mut rows = stmt.query_map([sid], param_row)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    // ---------- 任务 ----------

    pub fn enqueue(&self, body: &Value) -> Res<Value> {
        if self.vault.load().is_empty() {
            return Err(DomainError::new("还没有配置 NovelAI Persistent API Token", 401));
        }
        let mut data: Map<String, Value> = body.as_object().cloned().unwrap_or_default();
        let source = {
            let raw = data.remove("source").unwrap_or(Value::Null);
            let s = if truthy(&raw) { py_str(&raw) } else { "studio".into() };
            let s = s.trim().to_string();
            let s = if s.is_empty() { "studio".to_string() } else { s };
            if JOB_SOURCES.contains(&s.as_str()) { s } else { "studio".to_string() }
        };
        let client = match data.remove("client") {
            Some(v) if v.is_object() && truthy(&v) => v,
            _ => json!({}),
        };
        for key in ["save", "albumId", "tempId", "tempIds"] {
            data.remove(key);
        }
        let kind = {
            let v = data.get("kind").cloned().unwrap_or(Value::Null);
            if truthy(&v) { py_str(&v) } else { "generate".into() }
        };
        if !JOB_KINDS.contains(&kind.as_str()) {
            return Err(DomainError::bad("不支持的任务类型"));
        }
        data.insert("kind".into(), json!(kind));
        let mut data_v = Value::Object(data);
        let mut size: Option<(i64, i64)> = None;
        if kind != "generate" {
            size = Some(self.validate_image_job(&kind, &mut data_v)?);
        }
        let job_id = new_hex(16);
        let created = now_ms();
        let steps = if uses_medium(&data_v) && kind != "infill" {
            14
        } else {
            let v = get(&data_v, "steps");
            let raw = if truthy(v) { to_int(v) } else { Some(28) };
            raw.map(|n| n.clamp(1, 50)).unwrap_or(28)
        };
        let mut n_samples = {
            let v = get(&data_v, "nSamples");
            let raw = if truthy(v) { to_int(v) } else { Some(1) };
            raw.map(|n| n.clamp(1, 4)).unwrap_or(1)
        };
        if kind == "enhance" || kind == "upscale" {
            n_samples = 1;
        } else if kind == "variation" {
            n_samples = VARIATION_SAMPLES;
        }
        let mut progress = json!({
            "step": Value::Null, "steps": steps, "sample": 0, "nSamples": n_samples, "text": "排队中", "kind": kind,
        });
        if let Some((w, h)) = size {
            progress["width"] = json!(w);
            progress["height"] = json!(h);
        }
        if kind != "generate" {
            // 前端画布用它在结果旁边放一张带 ORIGINAL 角标的原图。
            progress["sourceHash"] = get(&data_v, "imageHash").clone();
        }
        let mut job: GenerationJob = self.k.load(&job_id)?;
        job.queue(json!({
            "source": source,
            "payload": data_v,
            "client": client,
            "progress": progress,
            "createdAt": created,
        }))?;
        self.k.commit(&mut job, Some(&format!("job.queue:{job_id}")))?;
        let public = self.get_job(&job_id)?;
        self.emit(json!({"type": "job", "job": public}));
        let _ = self.queue_tx.send(job_id);
        public.ok_or_else(|| DomainError::internal("任务创建失败"))
    }

    pub fn requeue(&self, job_id: &str) {
        let _ = self.queue_tx.send(job_id.to_string());
    }

    fn blob_size(&self, digest: &str) -> Res<(i64, i64)> {
        let data = self.k.blobs.get(digest).ok_or_else(|| DomainError::new("底图不存在，请重新选择", 404))?;
        if let Some((w, h)) = png_size(&data) {
            return Ok((w as i64, h as i64));
        }
        image::load_from_memory(&data)
            .map(|img| (img.width() as i64, img.height() as i64))
            .map_err(|_| DomainError::bad("无法读取底图"))
    }

    fn validate_image_job(&self, kind: &str, data: &mut Value) -> Res<(i64, i64)> {
        let image_hash = {
            let v = get(data, "imageHash");
            (if truthy(v) { py_str(v) } else { String::new() }).trim().to_lowercase()
        };
        if image_hash.is_empty() {
            return Err(DomainError::bad("缺少底图"));
        }
        data["imageHash"] = json!(image_hash);
        let (width, height) = self.blob_size(&image_hash)?;
        if kind == "infill" {
            let mask_hash = {
                let v = get(data, "maskHash");
                (if truthy(v) { py_str(v) } else { String::new() }).trim().to_lowercase()
            };
            if mask_hash.is_empty() || !self.k.blobs.exists(&mask_hash) {
                return Err(DomainError::bad("局部重绘需要蒙版"));
            }
            data["maskHash"] = json!(mask_hash);
        } else if let Some(o) = data.as_object_mut() {
            o.remove("maskHash");
        }
        Ok(plan_size(kind, data, width, height))
    }

    /// 按任务类型构造发给 NovelAI 的请求；图片和蒙版从 blob 读取。
    pub fn prepare_request(&self, body: &Value) -> NaiRes<(Value, Value)> {
        let kind = {
            let v = get(body, "kind");
            if truthy(v) { py_str(v) } else { "generate".into() }
        };
        if kind == "generate" {
            return build_payload(body);
        }
        let hash_of = |key: &str| {
            let v = get(body, key);
            if truthy(v) { py_str(v) } else { String::new() }
        };
        let image = self
            .k
            .blobs
            .get(&hash_of("imageHash"))
            .filter(|d| !d.is_empty())
            .ok_or_else(|| NaiError::new(404, "底图已不存在"))?;
        let mut mask = None;
        if kind == "infill" {
            mask = Some(
                self.k
                    .blobs
                    .get(&hash_of("maskHash"))
                    .filter(|d| !d.is_empty())
                    .ok_or_else(|| NaiError::new(404, "蒙版已不存在"))?,
            );
        }
        super::nai_images::build_image_payload(body, &image, mask.as_deref())
    }

    /// 前端上传的底图 / 蒙版：统一转成 PNG 后入库。
    pub fn store_upload(&self, data: &[u8]) -> Res<Value> {
        if data.is_empty() {
            return Err(DomainError::bad("没有收到图片"));
        }
        if data.len() > 48 * 1024 * 1024 {
            return Err(DomainError::new("图片太大", 413));
        }
        let png = if png_size(data).is_some() {
            data.to_vec()
        } else {
            image_to_png(data).map_err(|e| DomainError::bad(e.message))?
        };
        let digest = self.k.blobs.put(&png)?;
        let size = png_size(&png);
        Ok(json!({
            "blobHash": digest,
            "url": assets::blob_path(&digest),
            "width": size.map(|s| Value::from(s.0)).unwrap_or(Value::Null),
            "height": size.map(|s| Value::from(s.1)).unwrap_or(Value::Null),
        }))
    }

    pub fn list_jobs(&self) -> Res<Vec<Value>> {
        let keep = crate::util::to_int(&self.cfg("generation", "jobsKeep", json!(80))).unwrap_or(80);
        let conn = self.k.store.connect()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM projections_jobs
             WHERE status IN ('queued', 'running')
                OR id IN (SELECT id FROM projections_jobs ORDER BY created_at DESC LIMIT ?1)
             ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([keep], job_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 生图室已完成的全部任务，按创建时间倒序分页。不受 jobsKeep 截断。
    pub fn list_history(&self, before: Option<i64>, before_id: &str, limit: i64) -> Res<Value> {
        let size = limit.clamp(1, 200);
        let mut clauses = vec!["source='studio'", "status='done'", "json_array_length(items_json) > 0"];
        let mut args: Vec<S> = Vec::new();
        if let Some(cursor) = before {
            if !before_id.is_empty() {
                clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
                args.extend([S::Integer(cursor), S::Integer(cursor), S::Text(before_id.to_string())]);
            } else {
                clauses.push("created_at < ?");
                args.push(S::Integer(cursor));
            }
        }
        args.push(S::Integer(size + 1));
        let sql = format!(
            "SELECT * FROM projections_jobs WHERE {} ORDER BY created_at DESC, id DESC LIMIT ?",
            clauses.join(" AND ")
        );
        let conn = self.k.store.connect()?;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), job_row)?;
        let mut all = Vec::new();
        for r in rows {
            all.push(r?);
        }
        let more = all.len() as i64 > size;
        all.truncate(size as usize);
        let tail = if more { all.last().cloned() } else { None };
        Ok(json!({
            "jobs": all,
            "nextBefore": tail.as_ref().map(|t| t["createdAt"].clone()).unwrap_or(Value::Null),
            "nextBeforeId": tail.as_ref().map(|t| t["id"].clone()).unwrap_or(Value::Null),
        }))
    }

    /// 把若干张图从历史里移除。只改任务记录：blob 文件一律保留，收藏夹里的图不受影响。
    pub fn delete_history(&self, refs: &Value) -> Res<i64> {
        let mut by_job: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        for r in refs.as_array().cloned().unwrap_or_default() {
            if !r.is_object() {
                continue;
            }
            let job_id = {
                let v = get(&r, "jobId");
                (if truthy(v) { py_str(v) } else { String::new() }).trim().to_string()
            };
            let item_id = {
                let v = get(&r, "itemId");
                (if truthy(v) { py_str(v) } else { String::new() }).trim().to_string()
            };
            if !job_id.is_empty() && !item_id.is_empty() {
                if !by_job.contains_key(&job_id) {
                    order.push(job_id.clone());
                }
                by_job.entry(job_id).or_default().push(item_id);
            }
        }
        let mut removed = 0;
        for job_id in order {
            let item_ids = &by_job[&job_id];
            let mut job: GenerationJob = self.k.load(&job_id)?;
            if job.version() == 0 || job.source != "studio" || job.status != "done" {
                continue;
            }
            removed += job.remove_items(item_ids, now_ms())?.len() as i64;
            self.k.commit(&mut job, None)?;
        }
        Ok(removed)
    }

    pub fn get_job(&self, job_id: &str) -> Res<Option<Value>> {
        let conn = self.k.store.connect()?;
        let mut stmt = conn.prepare("SELECT * FROM projections_jobs WHERE id=?1")?;
        let mut rows = stmt.query_map([job_id], job_row)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    pub fn cancel(&self, job_id: &str) -> Res<Value> {
        self.cancel.lock().unwrap_or_else(|e| e.into_inner()).insert(job_id.to_string());
        let mut job: GenerationJob = self.k.load(job_id)?;
        if job.version() == 0 {
            return Err(DomainError::not_found("任务不存在"));
        }
        job.cancel(now_ms());
        self.k.commit(&mut job, None)?;
        let public = self.get_job(job_id)?;
        self.emit(json!({"type": "job", "job": public}));
        public.ok_or_else(|| DomainError::not_found("任务不存在"))
    }

    pub fn cancelled(&self, job_id: &str) -> bool {
        self.cancel.lock().unwrap_or_else(|e| e.into_inner()).contains(job_id)
    }

    pub fn mutate_job(&self, job_id: &str, mutator: impl FnOnce(&mut GenerationJob)) -> Option<Value> {
        let mut job: GenerationJob = self.k.load(job_id).ok()?;
        if job.version() == 0 {
            return None;
        }
        mutator(&mut job);
        if let Err(e) = self.k.commit(&mut job, None) {
            eprintln!("[generation] 写入任务事件失败：{}", e.message);
        }
        let public = self.get_job(job_id).ok().flatten();
        if let Some(p) = &public {
            self.emit(json!({"type": "job", "job": p}));
        }
        public
    }

    pub fn store_image(&self, data: &[u8]) -> Res<Value> {
        let digest = self.k.blobs.put(data)?;
        let thumb = self.k.blobs.thumb(data);
        let thumb_hash = match thumb {
            Some(t) if !t.is_empty() => self.k.blobs.put(&t)?,
            _ => String::new(),
        };
        let size = png_size(data);
        Ok(json!({
            "id": digest.chars().take(32).collect::<String>(),
            "blobHash": digest,
            "thumbHash": thumb_hash,
            "url": assets::blob_path(&digest),
            "thumbUrl": assets::blob_path(if thumb_hash.is_empty() { &digest } else { &thumb_hash }),
            "width": size.map(|s| Value::from(s.0)).unwrap_or(Value::Null),
            "height": size.map(|s| Value::from(s.1)).unwrap_or(Value::Null),
        }))
    }

    pub fn promote(&self, album_id: &str, blob_hashes: &[String], meta: &Value) -> Res<Vec<Value>> {
        let mut items = Vec::new();
        let mut artists: Vec<String> = match get(meta, "artists") {
            Value::Array(a) => a.iter().map(py_str).collect(),
            _ => vec![],
        };
        let mut artist_line = get(meta, "artistLine").clone();
        if let Some(text) = get(meta, "artists").as_str() {
            // 上游有时传的是画师串文本而不是列表
            if !truthy(&artist_line) {
                artist_line = json!(text);
            }
            artists = extract_artists(text).0;
        }
        if artists.is_empty() {
            // 生图台里画师直接写在 prompt 里，没有单独的画师列表：从 prompt 里识别，否则图库会显示「未识别画师」
            let prompt = if truthy(get(meta, "prompt")) { py_str(get(meta, "prompt")) } else { String::new() };
            let (a, chain) = extract_artists(&prompt);
            artists = a;
            if !truthy(&artist_line) {
                artist_line = json!(chain);
            }
        }
        let line_text = if truthy(&artist_line) {
            py_str(&artist_line)
        } else if !artists.is_empty() {
            artists.iter().map(|n| format!("artist:{n}")).collect::<Vec<_>>().join(", ")
        } else {
            String::new()
        };
        for digest in blob_hashes {
            let data = self.k.blobs.get(digest).ok_or_else(|| DomainError::not_found("预览文件不存在"))?;
            let mut params_v = meta.as_object().cloned().unwrap_or_default();
            let source = if truthy(get(meta, "source")) { get(meta, "source").clone() } else { json!("nai-v5") };
            params_v.insert("source".into(), source);
            let payload_meta = json!({
                "name": if truthy(get(meta, "name")) { get(meta, "name").clone() } else { json!("nai.png") },
                "artists": artists,
                "artistLine": line_text,
                "params": Value::Object(params_v),
                "width": get(meta, "width").clone(),
                "height": get(meta, "height").clone(),
            });
            match self.gallery.import_bytes(
                album_id,
                &data,
                &payload_meta,
                ImportOptions { thumb: None, command_id: None, item_id: None },
            ) {
                Ok(item) => items.push(item),
                Err(e) if e.status == 409 => {}
                Err(e) => return Err(e),
            }
        }
        if items.is_empty() {
            return Err(DomainError::conflict("重复"));
        }
        Ok(items)
    }

    /// 图库测试图任务完成时，把图自动绑定进对应测试集。返回新写入的图库条目。
    ///
    /// gen_meta 是这次生图实际发给 NovelAI 的参数（含 v4Prompt / v4Negative / 角色 / 真实 seed），
    /// 写进图片元数据后，图片详情里才有角色信息。
    pub fn bind_test_set_items(&self, source: &str, client: &Value, items: &[Value], gen_meta: &Value) -> Vec<Value> {
        let client = if client.is_object() { client } else { &Value::Null };
        // testSetId：测试集里的批量生图；targetAlbumId：悬停给缺图画师补一张，直接存进「单画师」收藏夹。
        let pick = |key: &str| {
            let v = get(client, key);
            if truthy(v) { py_str(v) } else { String::new() }
        };
        let set_id = {
            let a = pick("testSetId");
            (if a.is_empty() { pick("targetAlbumId") } else { a }).trim().to_string()
        };
        if source != "gallery" || set_id.is_empty() || items.is_empty() {
            return vec![];
        }
        let hashes: Vec<String> = items
            .iter()
            .filter(|it| truthy(get(it, "blobHash")))
            .map(|it| py_str(get(it, "blobHash")))
            .collect();
        if hashes.is_empty() {
            return vec![];
        }
        let form = if get(client, "form").is_object() { get(client, "form").clone() } else { json!({}) };
        let artists: Vec<Value> = match get(client, "artists") {
            Value::Array(a) => a.iter().map(|x| json!(py_str(x))).collect(),
            _ => vec![],
        };
        let artist_line = pick("artistLine");
        let base_prompt = {
            let v = get(&form, "prompt");
            (if truthy(v) { py_str(v) } else { String::new() }).trim().to_string()
        };
        let prompt = if !artist_line.is_empty() && !base_prompt.is_empty() {
            format!("{artist_line}, {base_prompt}")
        } else if !artist_line.is_empty() {
            artist_line.clone()
        } else {
            base_prompt
        };
        let mut meta = form.as_object().cloned().unwrap_or_default();
        meta.insert("prompt".into(), json!(prompt));
        if let Some(used) = gen_meta.as_object() {
            for (k, v) in used {
                meta.insert(k.clone(), v.clone());
            }
        }
        meta.insert("name".into(), json!("nai.png"));
        meta.insert("artists".into(), Value::Array(artists));
        meta.insert("artistLine".into(), json!(artist_line));
        meta.insert("source".into(), json!("nai-v5"));
        meta.insert("testIndex".into(), get(client, "testIndex").clone());
        if truthy(get(client, "testSetId")) {
            meta.insert("testSetId".into(), json!(set_id));
        }
        self.promote(&set_id, &hashes, &Value::Object(meta)).unwrap_or_default()
    }
}

fn param_row(row: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "name": row.get::<_, String>("name")?,
        "form": text_json(row.get("form_json")?, "{}"),
        "createdAt": row.get::<_, i64>("created_at")?,
        "updatedAt": row.get::<_, i64>("updated_at")?,
        "version": row.get::<_, i64>("version")?,
    }))
}

pub fn job_row(row: &Row) -> rusqlite::Result<Value> {
    let preview: Option<String> = row.get("preview_hash")?;
    let mut items = text_json(row.get("items_json")?, "[]");
    if let Some(list) = items.as_array_mut() {
        for item in list.iter_mut() {
            if truthy(get(item, "blobHash")) && !truthy(get(item, "url")) {
                item["url"] = json!(assets::blob_path(&py_str(get(item, "blobHash"))));
            }
            if truthy(get(item, "thumbHash")) && !truthy(get(item, "thumbUrl")) {
                item["thumbUrl"] = json!(assets::blob_path(&py_str(get(item, "thumbHash"))));
            }
        }
    }
    let preview_url = match preview.filter(|p| !p.is_empty()) {
        Some(p) => json!(assets::blob_path(&p)),
        None => items.get(0).map(|i| get(i, "url").clone()).unwrap_or(Value::Null),
    };
    let subscription: Option<String> = row.get("subscription_json")?;
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "source": row.get::<_, String>("source")?,
        "status": row.get::<_, String>("status")?,
        "progress": text_json(row.get("progress_json")?, "{}"),
        "items": items,
        "meta": text_json(row.get("meta_json")?, "{}"),
        "error": row.get::<_, Option<String>>("error")?,
        "subscription": match subscription.filter(|s| !s.is_empty()) {
            Some(s) => serde_json::from_str::<Value>(&s).unwrap_or(Value::Null),
            None => Value::Null,
        },
        "client": text_json(row.get("client_json")?, "{}"),
        "previewUrl": preview_url,
        "createdAt": row.get::<_, i64>("created_at")?,
        "startedAt": row.get::<_, Option<i64>>("started_at")?,
        "finishedAt": row.get::<_, Option<i64>>("finished_at")?,
        "version": row.get::<_, i64>("version")?,
    }))
}
