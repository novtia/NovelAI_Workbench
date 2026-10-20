//! 生图任务执行：tokio 任务池，实际并发数由设置 `generation.concurrency` 动态限制。

use super::application::GenerationService;
use super::domain::GenerationJob;
use super::nai_images::{composite_infill, decode_image_b64, image_to_png};
use super::nai_payload::*;
use crate::kernel::blobs::png_size;
use crate::kernel::clock::now_ms;
use crate::util::{get, py_str, to_int, truthy};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Notify};

pub const MAX_WORKERS: usize = 3;

enum RunErr {
    Interrupted,
    Nai(NaiError),
    Other(String),
}

impl From<NaiError> for RunErr {
    fn from(e: NaiError) -> Self {
        RunErr::Nai(e)
    }
}

impl From<crate::kernel::DomainError> for RunErr {
    fn from(e: crate::kernel::DomainError) -> Self {
        RunErr::Other(e.message)
    }
}

type RunRes<T> = Result<T, RunErr>;

pub fn progress_text(sample: i64, step: &Value, steps: i64, n_samples: i64) -> String {
    if step.is_null() {
        return "生成中".into();
    }
    if n_samples > 1 {
        return format!("图 {} · {}/{}", sample + 1, py_str(step), steps);
    }
    format!("{} / {}", py_str(step), steps)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> RunRes<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| RunErr::Other(format!("任务异常：{e}")))
}

/// 局部重绘的接口结果是整张新图，蒙版外面要贴回原图，和官网一样。
async fn infill_png(svc: &Arc<GenerationService>, body: &Value, png: Vec<u8>) -> RunRes<Vec<u8>> {
    if get(body, "kind").as_str() != Some("infill") {
        return Ok(png);
    }
    let hash = |key: &str| {
        let v = get(body, key);
        if truthy(v) { py_str(v) } else { String::new() }
    };
    let original = svc.k.blobs.get(&hash("imageHash"));
    let mask = svc.k.blobs.get(&hash("maskHash"));
    let (Some(original), Some(mask)) = (original.filter(|d| !d.is_empty()), mask.filter(|d| !d.is_empty())) else {
        return Ok(png);
    };
    Ok(blocking(move || composite_infill(&original, &png, &mask)).await??)
}

async fn fetch_sub(svc: &Arc<GenerationService>) -> Value {
    svc.gateway.fetch_subscription(None).await.unwrap_or(Value::Null)
}

fn text_of(v: &Value) -> String {
    if truthy(v) { py_str(v) } else { String::new() }
}

/// 专用放大：不经过扩散模型，直接调 /ai/upscale。
async fn run_upscale(svc: &Arc<GenerationService>, job_id: &str, job: &GenerationJob, body: &Value) -> RunRes<()> {
    let src = svc
        .k
        .blobs
        .get(&text_of(get(body, "imageHash")))
        .filter(|d| !d.is_empty())
        .ok_or_else(|| NaiError::new(404, "底图已不存在"))?;
    let png = blocking(move || image_to_png(&src)).await??;
    if png_size(&png).is_none() {
        return Err(NaiError::new(400, "无法读取底图").into());
    }
    let factor = upscale_factor(body);
    svc.mutate_job(job_id, |j| j.preview(0, Value::Null, None, "放大中"));
    let inherit = if get(body, "inherit").is_object() { get(body, "inherit").clone() } else { json!({}) };
    let out = svc.gateway.upscale_image(&png, get(&inherit, "model")).await?;
    if svc.cancelled(job_id) {
        return Err(RunErr::Interrupted);
    }
    let rec = svc.store_image(&out)?;
    let mut meta = inherit.as_object().cloned().unwrap_or_default();
    meta.insert("requestType".into(), json!("upscale"));
    meta.insert("scale".into(), json!(factor));
    meta.insert("sourceHash".into(), json!(text_of(get(body, "imageHash"))));
    meta.insert("width".into(), get(&rec, "width").clone());
    meta.insert("height".into(), get(&rec, "height").clone());
    let meta = Value::Object(meta);
    let items = vec![rec];
    svc.bind_test_set_items(&job.source, &Value::Object(job.client.clone()), &items, &meta);
    let sub = fetch_sub(svc).await;
    svc.mutate_job(job_id, |j| j.complete(Value::Array(items), meta, sub, now_ms()));
    Ok(())
}

/// Enhance 的 Max 档：原尺寸 img2img 之后再接一次 2x 放大。
async fn post_upscale(
    svc: &Arc<GenerationService>,
    job_id: &str,
    items: Vec<Value>,
    meta: &mut Value,
) -> RunRes<Vec<Value>> {
    let factor = {
        let v = get(meta, "postUpscale");
        if truthy(v) { to_int(v).unwrap_or(0) } else { 0 }
    };
    if factor == 0 {
        return Ok(items);
    }
    svc.mutate_job(job_id, |j| j.preview(0, Value::Null, None, "放大中"));
    let mut out: Vec<Value> = Vec::new();
    for rec in items {
        if svc.cancelled(job_id) {
            return Err(RunErr::Interrupted);
        }
        let raw = svc.k.blobs.get(&text_of(get(&rec, "blobHash")));
        let valid = raw.as_ref().map(|r| png_size(r).is_some()).unwrap_or(false);
        let Some(raw) = raw.filter(|_| valid) else {
            out.push(rec);
            continue;
        };
        let upscaled = svc.gateway.upscale_image(&raw, get(meta, "model")).await?;
        out.push(svc.store_image(&upscaled)?);
    }
    if let Some(first) = out.first() {
        if truthy(get(first, "width")) {
            meta["width"] = get(first, "width").clone();
            meta["height"] = get(first, "height").clone();
        }
    }
    Ok(out)
}

async fn finish(
    svc: &Arc<GenerationService>,
    job_id: &str,
    job: &GenerationJob,
    items: Vec<Value>,
    mut meta: Value,
) -> RunRes<()> {
    let items = post_upscale(svc, job_id, items, &mut meta).await?;
    let sub = fetch_sub(svc).await;
    svc.bind_test_set_items(&job.source, &Value::Object(job.client.clone()), &items, &meta);
    svc.mutate_job(job_id, |j| j.complete(Value::Array(items), meta, sub, now_ms()));
    Ok(())
}

async fn run_inner(
    svc: &Arc<GenerationService>,
    job_id: &str,
    job: &GenerationJob,
    body: &Value,
    steps: i64,
    n_samples: i64,
) -> RunRes<()> {
    let kind = if truthy(get(body, "kind")) { py_str(get(body, "kind")) } else { "generate".into() };
    if kind == "upscale" {
        return run_upscale(svc, job_id, job, body).await;
    }
    let (payload, meta) = {
        let svc2 = svc.clone();
        let body2 = body.clone();
        blocking(move || svc2.prepare_request(&body2)).await??
    };
    let mut resp = match svc.gateway.open_stream(&payload).await {
        Ok(r) => r,
        Err(e) => {
            if matches!(e.status, 400 | 401 | 403) {
                return Err(e.into());
            }
            let images = svc.gateway.generate_images(&payload).await?;
            let mut items = Vec::new();
            for png in images {
                let png = infill_png(svc, body, png).await?;
                items.push(svc.store_image(&png)?);
            }
            return finish(svc, job_id, job, items, meta).await;
        }
    };

    let mut parser = super::nai_client::SseParser::new();
    let mut items: Vec<Value> = Vec::new();
    let mut ended = false;
    loop {
        if svc.cancelled(job_id) {
            return Err(RunErr::Interrupted);
        }
        let events = if ended {
            let tail = parser.finish();
            if tail.is_empty() {
                break;
            }
            tail
        } else {
            match tokio::time::timeout(Duration::from_millis(500), resp.chunk()).await {
                Err(_) => continue,
                Ok(Ok(Some(chunk))) => parser.feed(&chunk),
                Ok(Ok(None)) => {
                    ended = true;
                    continue;
                }
                Ok(Err(e)) => return Err(RunErr::Other(format!("读取 NovelAI 流失败：{e}"))),
            }
        };
        let last_batch = ended;
        for chunk in events {
            if svc.cancelled(job_id) {
                return Err(RunErr::Interrupted);
            }
            let et = text_of(get(&chunk, "event_type"));
            let sample = {
                let v = get(&chunk, "samp_ix");
                if truthy(v) { to_int(v).unwrap_or(0) } else { 0 }
            };
            let image = get(&chunk, "image").as_str().unwrap_or("").to_string();
            if et == "intermediate" && !image.is_empty() && truthy(&svc.cfg("generation", "streamPreview", json!(true))) {
                let step = get(&chunk, "step_ix").clone();
                let text = progress_text(sample, &step, steps, n_samples);
                let raw = decode_image_b64(&image)?;
                let url = svc.write_preview(job_id, sample, &raw);
                svc.emit(json!({"type": "preview", "id": job_id, "url": url, "step": step, "sample": sample, "text": text}));
            } else if et == "final" && !image.is_empty() {
                let png = infill_png(svc, body, decode_image_b64(&image)?).await?;
                let rec = svc.store_image(&png)?;
                svc.emit(json!({"type": "preview", "id": job_id, "url": get(&rec, "url"), "sample": sample, "final": true}));
                items.push(rec);
            }
        }
        if last_batch {
            break;
        }
    }
    if svc.cancelled(job_id) {
        return Err(RunErr::Interrupted);
    }
    if items.is_empty() {
        return Err(NaiError::new(502, "生图没有返回图片").into());
    }
    finish(svc, job_id, job, items, meta).await
}

pub async fn run_job(svc: Arc<GenerationService>, job_id: String) {
    let job: GenerationJob = match svc.k.load(&job_id) {
        Ok(j) => j,
        Err(_) => return,
    };
    if job.version() == 0 || matches!(job.status.as_str(), "cancelled" | "done" | "error") {
        return;
    }
    if svc.cancelled(&job_id) {
        svc.mutate_job(&job_id, |j| j.cancel(now_ms()));
        return;
    }
    svc.mutate_job(&job_id, |j| j.start(now_ms()));
    let body = Value::Object(job.payload.clone());
    let progress = Value::Object(job.progress.clone());
    let int_of = |key: &str, default: i64| {
        let v = get(&progress, key);
        if truthy(v) { to_int(v).unwrap_or(default) } else { default }
    };
    let steps = int_of("steps", 28);
    let n_samples = int_of("nSamples", 1);

    let result = run_inner(&svc, &job_id, &job, &body, steps, n_samples).await;
    match result {
        Ok(()) => {}
        Err(RunErr::Interrupted) => {
            svc.mutate_job(&job_id, |j| j.cancel(now_ms()));
        }
        Err(RunErr::Nai(e)) => {
            if svc.cancelled(&job_id) {
                svc.mutate_job(&job_id, |j| j.cancel(now_ms()));
            } else {
                svc.mutate_job(&job_id, |j| j.fail(&e.message, now_ms()));
            }
        }
        Err(RunErr::Other(msg)) => {
            if svc.cancelled(&job_id) {
                svc.mutate_job(&job_id, |j| j.cancel(now_ms()));
            } else {
                let msg = if msg.is_empty() { "生图失败".to_string() } else { msg };
                svc.mutate_job(&job_id, |j| j.fail(&msg, now_ms()));
            }
        }
    }
    svc.clear_previews(&job_id);
}

struct Gate {
    running: AtomicUsize,
    notify: Notify,
}

/// 起 MAX_WORKERS 个任务，实际并发数由设置 generation.concurrency 动态限制（默认 1）。
pub fn start_workers(svc: Arc<GenerationService>) {
    let Some(rx) = svc.take_receiver() else { return };
    let rx = Arc::new(Mutex::new(rx));
    let gate = Arc::new(Gate { running: AtomicUsize::new(0), notify: Notify::new() });
    for _ in 0..MAX_WORKERS {
        let (svc, rx, gate) = (svc.clone(), rx.clone(), gate.clone());
        tauri::async_runtime::spawn(async move {
            loop {
                let next = { rx.lock().await.recv().await };
                let Some(job_id) = next else { break };
                loop {
                    let limit = svc.settings.value_i64("generation", "concurrency", 1).max(1) as usize;
                    let cur = gate.running.load(Ordering::SeqCst);
                    if cur < limit && gate.running.compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                        break;
                    }
                    let _ = tokio::time::timeout(Duration::from_secs(1), gate.notify.notified()).await;
                }
                // 任务 panic 不能带走工作线程，单独 spawn 再等它结束。
                let handle = tauri::async_runtime::spawn(run_job(svc.clone(), job_id));
                let _ = handle.await;
                gate.running.fetch_sub(1, Ordering::SeqCst);
                gate.notify.notify_waiters();
            }
        });
    }
}
