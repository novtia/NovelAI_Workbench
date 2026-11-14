use super::domain::{GenerationJob, ParamSet};
use super::accounts::{Account, AccountStore};
use super::nai_client::{NaiGateway, TokenVault};
use super::nai_images::image_to_png;
use super::nai_payload::*;
use crate::assets;
use crate::contexts::gallery::application::{GalleryService, ImportOptions};
use crate::contexts::gallery::rules::extract_artists;
use crate::contexts::identity::Credential;
use crate::contexts::lottery::domain::lottery_client_draw_id;
use crate::contexts::settings::application::SettingsService;
use crate::kernel::blobs::{png_size, Bucket, Slot};
use crate::kernel::bus::Kernel;
use crate::kernel::clock::{new_hex, new_id, now_ms};
use crate::kernel::logger::{AppLogger, ScopedLogger};
use crate::kernel::purge::{plan_job_items, Purge};
use crate::kernel::{DomainError, Res};
use crate::util::{get, py_str, to_int, truthy};
use rusqlite::types::Value as S;
use rusqlite::{params_from_iter, Row};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
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
    pub accounts: Arc<AccountStore>,
    pub settings: Arc<SettingsService>,
    pub logger: Arc<AppLogger>,
    log: ScopedLogger,
    emitter: RwLock<Option<Emitter>>,
    queue_tx: UnboundedSender<String>,
    queue_rx: Mutex<Option<UnboundedReceiver<String>>>,
    cancel: Arc<Mutex<HashSet<String>>>,
    /// 这次任务写过、但完成事件未必引用的文件。任务结束时删掉没人用的。
    staged: Mutex<HashMap<String, Vec<(String, Slot)>>>,
    /// 每个账号最近一次查到的订阅/额度，按设置里的缓存时间复用。
    status_cache: Mutex<HashMap<String, (Instant, Value)>>,
}

fn text_json(raw: Option<String>, fallback: &str) -> Value {
    let text = raw
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string());
    serde_json::from_str(&text).unwrap_or_else(|_| serde_json::from_str(fallback).unwrap())
}

impl GenerationService {
    pub fn new(
        k: Arc<Kernel>,
        gallery: Arc<GalleryService>,
        gateway: Arc<NaiGateway>,
        vault: Arc<TokenVault>,
        accounts: Arc<AccountStore>,
        settings: Arc<SettingsService>,
        logger: Arc<AppLogger>,
    ) -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let log = logger.scoped("generation");
        GenerationService {
            k,
            gallery,
            gateway,
            vault,
            accounts,
            settings,
            logger,
            log,
            emitter: RwLock::new(None),
            queue_tx: tx,
            queue_rx: Mutex::new(Some(rx)),
            cancel: Arc::new(Mutex::new(HashSet::new())),
            staged: Mutex::new(HashMap::new()),
            status_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_emitter(&self, e: Emitter) {
        *self.emitter.write().unwrap_or_else(|x| x.into_inner()) = Some(e);
    }

    pub fn emit(&self, payload: Value) {
        let e = self
            .emitter
            .read()
            .unwrap_or_else(|x| x.into_inner())
            .clone();
        if let Some(e) = e {
            e(payload);
        }
    }

    pub fn take_receiver(&self) -> Option<UnboundedReceiver<String>> {
        self.queue_rx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    /// 读取设置项；缺失时回落到默认值。
    pub fn cfg(&self, section: &str, key: &str, default: Value) -> Value {
        let v = self.settings.value(section, key);
        if v.is_null() {
            default
        } else {
            v
        }
    }

    fn status_ttl(&self) -> f64 {
        crate::util::to_float(&self.cfg("account", "statusTtlSec", json!(45))).unwrap_or(45.0)
    }

    /// 一个账号的订阅/额度：先看缓存，过期了才访问网络。`subscription` 为空表示查不到
    /// （自建网关没有这个接口，或者 Token 失效），原因在 `error`。
    async fn account_live(&self, acct: &Account) -> Value {
        let ttl = self.status_ttl();
        {
            let cache = self.status_cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((at, v)) = cache.get(&acct.id) {
                if at.elapsed().as_secs_f64() < ttl {
                    return v.clone();
                }
            }
        }
        let mut out = json!({"subscription": Value::Null});
        if acct.usable() {
            match self.gateway.fetch_subscription_for(acct).await {
                Ok(sub) => out["subscription"] = sub,
                Err(e) => {
                    out["error"] = json!(e.message);
                    out["errorStatus"] = json!(e.status);
                }
            }
        }
        self.status_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(acct.id.clone(), (Instant::now(), out.clone()));
        out
    }

    fn account_view(acct: &Account, live: &Value) -> Value {
        let mut v = acct.public();
        v["subscription"] = get(live, "subscription").clone();
        if let Some(e) = live.get("error") {
            v["error"] = e.clone();
            v["errorStatus"] = get(live, "errorStatus").clone();
        }
        v
    }

    /// 账号设置页：所有账号 + 各自的实时额度，并行查询。
    pub async fn accounts_status(&self) -> Value {
        let list = self.accounts.list();
        let lives = futures_util::future::join_all(list.iter().map(|a| self.account_live(a))).await;
        let accounts: Vec<Value> = list
            .iter()
            .zip(lives.iter())
            .map(|(a, l)| Self::account_view(a, l))
            .collect();
        json!({"accounts": accounts, "file": self.accounts.path().display().to_string()})
    }

    /// 侧栏电池、生图室工具栏用的单账号状态：取排在最前面、能用的那个账号（都不能用就取第一个）。
    pub async fn token_status(&self) -> Value {
        let list = self.accounts.list();
        let Some(acct) = list.iter().find(|a| a.usable()).or_else(|| list.first()) else {
            return self.local_status();
        };
        let live = self.account_live(acct).await;
        let mut out = Self::account_view(acct, &live);
        out["tokenFile"] = json!(self.accounts.path().display().to_string());
        out
    }

    pub fn invalidate_status(&self) {
        self.status_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// 按顺序挑第一个能干这件事的账号：开着、开关允许、点数够。
    /// `need(opus, bump)` 返回 (会不会动用免费额度, 要花多少点数)；`bump` 表示把请求推出免费范围。
    /// 账号关了免费额度、开着点数，而这次本来会走免费时，返回的第二项为 true，调用方要把请求推出免费范围。
    pub async fn pick_account(
        &self,
        need: impl Fn(bool, bool) -> (bool, i64),
    ) -> Result<(Account, bool), NaiError> {
        let list = self.accounts.list();
        if !list.iter().any(Account::usable) {
            return Err(NaiError::new(
                401,
                "没有可用的 NovelAI 账号：请先在「账号与额度」里添加账号并保持启用",
            ));
        }
        let mut why: Vec<String> = Vec::new();
        for acct in list.iter().filter(|a| a.usable()) {
            self.log.debug(
                "pick_account.try",
                json!({"account": acct.name, "id": acct.id, "useFree": acct.use_free, "usePoints": acct.use_points}),
            );
            // 额度查询最多等 8 秒：查不到就当「额度未知」继续，不能让生图卡在选账号上。
            let live = match tokio::time::timeout(
                std::time::Duration::from_secs(8),
                self.account_live(acct),
            )
            .await
            {
                Ok(v) => v,
                Err(_) => {
                    self.log.warn("pick_account.timeout", json!({"account": acct.name}));
                    json!({"subscription": Value::Null, "error": "额度查询超时"})
                }
            };
            let sub = get(&live, "subscription");
            if !sub.is_object() {
                // 查不到额度（自建网关等）：只能信开关，真不够会由服务端报错。
                if acct.use_free || acct.use_points {
                    return Ok((acct.clone(), false));
                }
                why.push(format!("「{}」免费额度和点数都已关闭", acct.name));
                continue;
            }
            let opus = truthy(get(sub, "opus"));
            let anlas = to_int(get(sub, "anlas")).unwrap_or(0);
            let (mut free, mut points) = need(opus, false);
            let mut bump = false;
            if free && !acct.use_free {
                if !acct.use_points {
                    why.push(format!("「{}」已关闭免费额度，而这次生图会用到", acct.name));
                    continue;
                }
                // 只用点数：把请求推出免费范围，让它按点数计费
                bump = true;
                (free, points) = need(opus, true);
            }
            if free && !acct.use_free {
                why.push(format!("「{}」已关闭免费额度，而这次生图会用到", acct.name));
            } else if points > 0 && !acct.use_points {
                why.push(format!("「{}」已关闭点数，而这次生图要 {points} 点", acct.name));
            } else if points > anlas {
                why.push(format!("「{}」点数不足（剩 {anlas}，需要 {points}）", acct.name));
            } else {
                return Ok((acct.clone(), bump));
            }
        }
        Err(NaiError::new(
            402,
            format!("没有账号能承担这次生图：{}", why.join("；")),
        ))
    }

    /// 生图后额度有变化：让所有账号的缓存失效，并查一遍指定账号作为任务结果里的额度快照。
    pub async fn subscription_after(&self, acct: &Account) -> Value {
        self.invalidate_status();
        let live = self.account_live(acct).await;
        get(&live, "subscription").clone()
    }
    /// 画布工具栏的 Anlas 估算；只是估算，以订阅余额的实际变化为准。
    pub fn estimate(&self, body: &Value) -> Value {
        estimate_costs(if body.is_object() { body } else { &Value::Null })
    }

    fn previews_dir(&self) -> PathBuf {
        let dir = self
            .k
            .blobs
            .root
            .parent()
            .map(|p| p.join("previews"))
            .unwrap_or_else(|| PathBuf::from("previews"));
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
        let Some(dir) = dir.filter(|d| d.is_dir()) else {
            return;
        };
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

    /// 生图室弹窗的老入口：写到排在最前面的账号；还没有账号就新建一个。
    pub async fn set_token(&self, token: &str) -> Res<Value> {
        self.invalidate_status();
        let token = token.trim();
        if token.is_empty() {
            return Err(DomainError::bad("Token 不能为空"));
        }
        let list = self.accounts.list();
        let id = list.first().map(|a| a.id.clone()).unwrap_or_default();
        self.accounts
            .upsert(&id, &json!({"token": token, "enabled": true}))
            .map_err(|m| DomainError::new(m, 500))?;
        let mut cred: Credential = self.k.load("nai")?;
        cred.set_hint(&token_hint(token));
        self.k
            .commit(&mut cred, Some(&format!("identity.set:{}", now_ms())))?;
        Ok(self.local_status())
    }

    /// 清除排在最前面的账号（等于删掉它）。
    pub async fn clear_token(&self) -> Res<Value> {
        self.invalidate_status();
        if let Some(first) = self.accounts.list().first() {
            self.accounts
                .remove(&first.id)
                .map_err(|m| DomainError::new(m, 500))?;
        }
        let mut cred: Credential = self.k.load("nai")?;
        cred.clear();
        self.k.commit(&mut cred, None)?;
        Ok(self.local_status())
    }

    /// 保存/新增一个账号（`id` 为空是新增）。只写本地，额度由前端随后刷新。
    pub fn save_account(&self, id: &str, patch: &Value) -> Res<Value> {
        self.invalidate_status();
        let acct = self
            .accounts
            .upsert(id, patch)
            .map_err(|m| DomainError::new(m, 400))?;
        Ok(acct.public())
    }

    pub fn delete_account(&self, id: &str) -> Res<()> {
        self.invalidate_status();
        self.accounts
            .remove(id)
            .map_err(|m| DomainError::new(m, 404))
    }

    pub fn reorder_accounts(&self, ids: &[String]) -> Res<()> {
        self.accounts
            .reorder(ids)
            .map_err(|m| DomainError::new(m, 500))
    }

    /// 只看本地：不访问网络，保存/清除后立刻返回；额度由前端随后后台刷新。
    pub fn local_status(&self) -> Value {
        let list = self.accounts.list();
        let first = list.iter().find(|a| a.usable()).or_else(|| list.first());
        let mut out = match first {
            Some(a) => a.public(),
            None => json!({"configured": false, "hint": ""}),
        };
        out["subscription"] = Value::Null;
        out["tokenFile"] = json!(self.accounts.path().display().to_string());
        out
    }
    // ---------- 参数预设 ----------

    pub fn list_param_sets(&self) -> Res<Vec<Value>> {
        let conn = self.k.store.connect()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM projections_param_sets WHERE deleted=0 ORDER BY updated_at DESC",
        )?;
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
        self.get_param_set(&sid)?
            .ok_or_else(|| DomainError::internal("保存失败"))
    }

    pub fn update_param_set(&self, sid: &str, form: &Value) -> Res<Value> {
        let mut agg: ParamSet = self.k.load(sid)?;
        agg.update(form, now_ms())?;
        self.k.commit(&mut agg, None)?;
        self.get_param_set(sid)?
            .ok_or_else(|| DomainError::not_found("预设不存在"))
    }

    pub fn delete_param_set(&self, sid: &str) -> Res<()> {
        if self.get_param_set(sid)?.is_none() {
            return Err(DomainError::not_found("预设不存在"));
        }
        let mut plan = Purge::default();
        plan.drop_aggregate(sid);
        self.k.purge(&plan)?;
        Ok(())
    }

    pub fn get_param_set(&self, sid: &str) -> Res<Option<Value>> {
        let conn = self.k.store.connect()?;
        let mut stmt =
            conn.prepare("SELECT * FROM projections_param_sets WHERE id=?1 AND deleted=0")?;
        let mut rows = stmt.query_map([sid], param_row)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    // ---------- 任务 ----------

    pub fn enqueue(&self, body: &Value) -> Res<Value> {
        if !self.accounts.has_usable() {
            return Err(DomainError::new(
                "没有可用的 NovelAI 账号：请先在「账号与额度」里添加账号并保持启用",
                401,
            ));
        }
        let mut data: Map<String, Value> = body.as_object().cloned().unwrap_or_default();
        let source = {
            let raw = data.remove("source").unwrap_or(Value::Null);
            let s = if truthy(&raw) {
                py_str(&raw)
            } else {
                "studio".into()
            };
            let s = s.trim().to_string();
            let s = if s.is_empty() {
                "studio".to_string()
            } else {
                s
            };
            if JOB_SOURCES.contains(&s.as_str()) {
                s
            } else {
                "studio".to_string()
            }
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
            if truthy(&v) {
                py_str(&v)
            } else {
                "generate".into()
            }
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
        self.own_inputs(&data_v)?;
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
        self.k
            .commit(&mut job, Some(&format!("job.queue:{job_id}")))?;
        let public = self.get_job(&job_id)?;
        self.emit(json!({"type": "job", "job": public}));
        let send_ok = self.queue_tx.send(job_id.clone()).is_ok();
        self.log.debug(
            "submit_job",
            json!({"jobId": job_id, "source": source, "kind": kind, "sendOk": send_ok}),
        );
        public.ok_or_else(|| DomainError::internal("任务创建失败"))
    }

    pub fn requeue(&self, job_id: &str) {
        let _ = self.queue_tx.send(job_id.to_string());
    }

    /// 启动时按创建顺序把没跑完的任务放回内存队列。正在跑的退回「排队中」，避免界面停在中断前的步数。
    pub fn resume_pending(&self) -> Res<usize> {
        let pending = {
            let conn = self.k.store.connect()?;
            let mut stmt = conn.prepare(
                "SELECT id, status FROM projections_jobs
                 WHERE status IN ('queued', 'running')
                 ORDER BY created_at ASC, rowid ASC",
            )?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            out
        };
        for (id, status) in &pending {
            if status == "running" {
                self.mutate_job(id, |job| job.park());
            }
            self.requeue(id);
        }
        Ok(pending.len())
    }

    fn blob_size(&self, digest: &str) -> Res<(i64, i64)> {
        let data = self
            .k
            .blobs
            .get(digest)
            .ok_or_else(|| DomainError::new("底图不存在，请重新选择", 404))?;
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
            (if truthy(v) { py_str(v) } else { String::new() })
                .trim()
                .to_lowercase()
        };
        if image_hash.is_empty() {
            return Err(DomainError::bad("缺少底图"));
        }
        data["imageHash"] = json!(image_hash);
        let (width, height) = self.blob_size(&image_hash)?;
        if kind == "infill" {
            let mask_hash = {
                let v = get(data, "maskHash");
                (if truthy(v) { py_str(v) } else { String::new() })
                    .trim()
                    .to_lowercase()
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

    /// 图生图的底图和蒙版归这个任务所有：从别的桶复制一份到 inputs。
    fn own_inputs(&self, data: &Value) -> Res<()> {
        for key in ["imageHash", "maskHash"] {
            let v = get(data, key);
            let hash = if truthy(v) {
                py_str(v).trim().to_lowercase()
            } else {
                String::new()
            };
            if hash.is_empty() {
                continue;
            }
            if !self
                .k
                .blobs
                .copy_into(&Slot::image(Bucket::Inputs), &hash)?
            {
                return Err(DomainError::new("底图不存在，请重新选择", 404));
            }
        }
        Ok(())
    }

    fn prune_superseded(&self, job_id: &str) -> Res<()> {
        let Some(job) = self.get_job(job_id)? else {
            return Ok(());
        };
        if job["source"].as_str() != Some("lottery") || job["status"].as_str() != Some("done") {
            return Ok(());
        }
        let batch = {
            let v = get(&job["client"], "batchId");
            if truthy(v) {
                py_str(v).trim().to_string()
            } else {
                String::new()
            }
        };
        let draw = lottery_client_draw_id(&batch, &job["client"]);
        if batch.is_empty() || draw.is_empty() {
            return Ok(());
        }
        let conn = self.k.store.connect()?;
        let mut stmt = conn.prepare(
            "SELECT id, status, client_json, finished_at, created_at FROM projections_jobs WHERE source='lottery'",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<i64>>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        let mut group: Vec<(String, String, i64, i64)> = Vec::new();
        for row in rows {
            let (id, status, client_json, finished, created) = row?;
            let client = client_json
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .unwrap_or(Value::Null);
            let row_batch = {
                let v = get(&client, "batchId");
                if truthy(v) {
                    py_str(v).trim().to_string()
                } else {
                    String::new()
                }
            };
            if row_batch == batch && lottery_client_draw_id(&batch, &client) == draw {
                group.push((id, status, finished.unwrap_or(0), created));
            }
        }
        let mut keep = job_id.to_string();
        let mut best = (0i64, 0i64, String::new());
        for (id, status, finished, created) in &group {
            if matches!(status.as_str(), "queued" | "running") {
                continue;
            }
            let rank = (*finished, *created, id.clone());
            if rank > best {
                best = rank;
                keep = id.clone();
            }
        }
        let mut plan = Purge::default();
        for (id, status, _, _) in &group {
            if id != &keep && !matches!(status.as_str(), "queued" | "running") {
                plan.drop_aggregate(id);
            }
        }
        self.k.purge(&plan)?;
        Ok(())
    }

    fn prune_failed(&self) -> Res<usize> {
        let keep = to_int(&self.cfg("generation", "jobsKeep", json!(80)))
            .unwrap_or(80)
            .max(0);
        let conn = self.k.store.connect()?;
        let ids: Vec<String> = conn
            .prepare(
                "SELECT id FROM projections_jobs
                 WHERE status IN ('error', 'cancelled')
                   AND id NOT IN (SELECT id FROM projections_jobs ORDER BY created_at DESC, id DESC LIMIT ?1)",
            )?
            .query_map([keep], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        if ids.is_empty() {
            return Ok(0);
        }
        let mut plan = Purge::default();
        for id in &ids {
            plan.drop_aggregate(id);
        }
        let n = ids.len();
        drop(conn);
        self.k.purge(&plan)?;
        Ok(n)
    }

    /// 按任务类型构造发给 NovelAI 的请求；图片和蒙版从 blob 读取。
    pub fn prepare_request(&self, body: &Value) -> NaiRes<(Value, Value)> {
        let kind = {
            let v = get(body, "kind");
            if truthy(v) {
                py_str(v)
            } else {
                "generate".into()
            }
        };
        if kind == "generate" {
            return build_payload(body);
        }
        let hash_of = |key: &str| {
            let v = get(body, key);
            if truthy(v) {
                py_str(v)
            } else {
                String::new()
            }
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
        let digest = self.k.blobs.put(&Bucket::Inputs, &png)?;
        let size = png_size(&png);
        Ok(json!({
            "blobHash": digest,
            "url": assets::blob_path(&digest),
            "width": size.map(|s| Value::from(s.0)).unwrap_or(Value::Null),
            "height": size.map(|s| Value::from(s.1)).unwrap_or(Value::Null),
        }))
    }

    pub fn list_jobs(&self) -> Res<Vec<Value>> {
        let keep =
            crate::util::to_int(&self.cfg("generation", "jobsKeep", json!(80))).unwrap_or(80);
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
        let mut clauses = vec![
            "source='studio'",
            "status='done'",
            "json_array_length(items_json) > 0",
        ];
        let mut args: Vec<S> = Vec::new();
        if let Some(cursor) = before {
            if !before_id.is_empty() {
                clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
                args.extend([
                    S::Integer(cursor),
                    S::Integer(cursor),
                    S::Text(before_id.to_string()),
                ]);
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

    /// 把若干张图从历史里移除。对应的生图文件一起删掉；收藏夹里的副本不受影响。
    pub fn delete_history(&self, refs: &Value) -> Res<i64> {
        let mut by_job: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        for r in refs.as_array().cloned().unwrap_or_default() {
            if !r.is_object() {
                continue;
            }
            let job_id = {
                let v = get(&r, "jobId");
                (if truthy(v) { py_str(v) } else { String::new() })
                    .trim()
                    .to_string()
            };
            let item_id = {
                let v = get(&r, "itemId");
                (if truthy(v) { py_str(v) } else { String::new() })
                    .trim()
                    .to_string()
            };
            if !job_id.is_empty() && !item_id.is_empty() {
                if !by_job.contains_key(&job_id) {
                    order.push(job_id.clone());
                }
                by_job.entry(job_id).or_default().push(item_id);
            }
        }
        let mut removed = 0i64;
        let mut plan = Purge::default();
        {
            let conn = self.k.store.connect()?;
            for job_id in order {
                let item_ids = &by_job[&job_id];
                let job: GenerationJob = self.k.load(&job_id)?;
                if job.version() == 0 || job.source != "studio" || job.status != "done" {
                    continue;
                }
                let wanted: HashSet<&str> = item_ids.iter().map(|s| s.as_str()).collect();
                let keep: Vec<Value> = job
                    .items
                    .iter()
                    .filter(|it| !wanted.contains(py_str(get(it, "id")).as_str()))
                    .cloned()
                    .collect();
                let hit = job.items.len() as i64 - keep.len() as i64;
                if hit <= 0 {
                    continue;
                }
                removed += hit;
                plan_job_items(&conn, &job_id, &keep, &mut plan)?;
            }
        }
        self.k.purge(&plan)?;
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
        self.cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(job_id.to_string());
        let mut job: GenerationJob = self.k.load(job_id)?;
        if job.version() == 0 {
            return Err(DomainError::not_found("任务不存在"));
        }
        let prev_status = job.status.clone();
        job.cancel(now_ms());
        self.k.commit(&mut job, None)?;
        let public = self.get_job(job_id)?;
        self.emit(json!({"type": "job", "job": public}));
        self.log.info(
            "cancel_job",
            json!({"jobId": job_id, "prevStatus": prev_status, "nextStatus": job.status}),
        );
        public.ok_or_else(|| DomainError::not_found("任务不存在"))
    }

    pub fn cancelled(&self, job_id: &str) -> bool {
        self.cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(job_id)
    }

    pub fn cancelled_set(&self) -> Arc<Mutex<HashSet<String>>> {
        self.cancel.clone()
    }

    pub fn has_active_jobs(&self) -> Res<bool> {
        let n: i64 = self.k.store.connect()?.query_row(
            "SELECT COUNT(*) FROM projections_jobs WHERE status IN ('queued', 'running')",
            [],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn mutate_job(
        &self,
        job_id: &str,
        mutator: impl FnOnce(&mut GenerationJob),
    ) -> Option<Value> {
        if self.cancelled(job_id) {
            let mut job: GenerationJob = self.k.load(job_id).ok()?;
            if job.version() == 0 {
                return None;
            }
            if !matches!(job.status.as_str(), "done" | "error" | "cancelled") {
                job.cancel(now_ms());
                let _ = self.k.commit(&mut job, None);
            }
            return self.get_job(job_id).ok().flatten();
        }
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

    pub fn store_image(&self, bucket: &Bucket, data: &[u8]) -> Res<Value> {
        let (digest, thumb_hash) = self.k.blobs.put_image(bucket, data, None)?;
        let size = png_size(data);
        Ok(json!({
            "id": digest.chars().take(32).collect::<String>(),
            "blobHash": digest,
            "thumbHash": thumb_hash,
            "bucket": bucket.label(),
            "url": assets::blob_path(&digest),
            "thumbUrl": assets::blob_path(if thumb_hash.is_empty() { &digest } else { &thumb_hash }),
            "width": size.map(|s| Value::from(s.0)).unwrap_or(Value::Null),
            "height": size.map(|s| Value::from(s.1)).unwrap_or(Value::Null),
        }))
    }

    /// 记下这次任务写出的文件，结束时把没被完成事件引用的删掉。
    pub fn stage(&self, job_id: &str, item: &Value) {
        let bucket = get(item, "bucket")
            .as_str()
            .and_then(Bucket::parse)
            .unwrap_or(Bucket::Studio);
        let mut staged = self.staged.lock().unwrap_or_else(|e| e.into_inner());
        let list = staged.entry(job_id.to_string()).or_default();
        let hash = |key: &str| {
            let v = get(item, key);
            if truthy(v) {
                py_str(v).trim().to_lowercase()
            } else {
                String::new()
            }
        };
        let blob = hash("blobHash");
        if !blob.is_empty() {
            list.push((blob, Slot::image(bucket.clone())));
        }
        let thumb = hash("thumbHash");
        if !thumb.is_empty() {
            list.push((thumb, Slot::thumb(bucket)));
        }
    }

    pub fn release_staged(&self, job_id: &str) {
        let files = self
            .staged
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(job_id)
            .unwrap_or_default();
        let _ = self.k.release_files(&files);
    }

    /// 抽奖同一条串只留最新的成功任务；失败和取消的记录只保留最近若干条。
    pub fn settle(&self, job_id: &str) {
        let _ = self.prune_superseded(job_id);
        let _ = self.prune_failed();
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
            let prompt = if truthy(get(meta, "prompt")) {
                py_str(get(meta, "prompt"))
            } else {
                String::new()
            };
            let (a, chain) = extract_artists(&prompt);
            artists = a;
            if !truthy(&artist_line) {
                artist_line = json!(chain);
            }
        }
        let line_text = if truthy(&artist_line) {
            py_str(&artist_line)
        } else if !artists.is_empty() {
            artists
                .iter()
                .map(|n| format!("artist:{n}"))
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            String::new()
        };
        for digest in blob_hashes {
            let data = self
                .k
                .blobs
                .get(digest)
                .ok_or_else(|| DomainError::not_found("预览文件不存在"))?;
            let mut params_v = meta.as_object().cloned().unwrap_or_default();
            let source = if truthy(get(meta, "source")) {
                get(meta, "source").clone()
            } else {
                json!("nai-v5")
            };
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
                ImportOptions {
                    thumb: None,
                    command_id: None,
                    item_id: None,
                },
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
    pub fn bind_test_set_items(
        &self,
        source: &str,
        client: &Value,
        items: &[Value],
        gen_meta: &Value,
    ) -> Vec<Value> {
        let client = if client.is_object() {
            client
        } else {
            &Value::Null
        };
        // testSetId：测试集里的批量生图；targetAlbumId：悬停给缺图画师补一张，直接存进「单画师」收藏夹。
        let pick = |key: &str| {
            let v = get(client, key);
            if truthy(v) {
                py_str(v)
            } else {
                String::new()
            }
        };
        let set_id = {
            let a = pick("testSetId");
            (if a.is_empty() {
                pick("targetAlbumId")
            } else {
                a
            })
            .trim()
            .to_string()
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
        let form = if get(client, "form").is_object() {
            get(client, "form").clone()
        } else {
            json!({})
        };
        let artists: Vec<Value> = match get(client, "artists") {
            Value::Array(a) => a.iter().map(|x| json!(py_str(x))).collect(),
            _ => vec![],
        };
        let artist_line = pick("artistLine");
        let base_prompt = {
            let v = get(&form, "prompt");
            (if truthy(v) { py_str(v) } else { String::new() })
                .trim()
                .to_string()
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
        let saved = self
            .promote(&set_id, &hashes, &Value::Object(meta))
            .unwrap_or_default();
        // 重绘：新图已经落库，再删掉被替换的旧图（新图没存成功就保留旧图）。
        let replace_id = pick("replaceItemId");
        if !saved.is_empty() && !replace_id.is_empty() && truthy(get(client, "testSetId")) {
            let rid = replace_id.trim();
            // 只允许删同一个测试集里的图，防止误删别的收藏夹。
            let same_set = matches!(self.gallery.get_item(rid, false), Ok(Some(it)) if it["albumId"].as_str() == Some(set_id.as_str()));
            if same_set {
                let _ = self.gallery.delete_item(rid);
            }
        }
        saved
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
        None => items
            .get(0)
            .map(|i| get(i, "url").clone())
            .unwrap_or(Value::Null),
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
