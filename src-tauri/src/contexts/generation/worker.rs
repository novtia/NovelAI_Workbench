//! 生图任务执行：tokio 任务池，实际并发数由设置 `generation.concurrency` 动态限制。
//! 同一串队列里，从第二张起在拿到名额之后、请求 NovelAI 之前随机等一会儿。

use super::application::GenerationService;
use super::domain::GenerationJob;
use super::nai_images::{composite_infill, decode_image_b64, image_to_png};
use super::nai_payload::*;
use crate::kernel::blobs::{png_size, Bucket};
use crate::kernel::clock::now_ms;
use crate::util::{get, py_str, to_int, truthy};
use serde_json::{json, Value};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc::UnboundedReceiver, Notify};

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
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| RunErr::Other(format!("任务异常：{e}")))
}

/// 局部重绘的接口结果是整张新图，蒙版外面要贴回原图，和官网一样。
async fn infill_png(svc: &Arc<GenerationService>, body: &Value, png: Vec<u8>) -> RunRes<Vec<u8>> {
    if get(body, "kind").as_str() != Some("infill") {
        return Ok(png);
    }
    let hash = |key: &str| {
        let v = get(body, key);
        if truthy(v) {
            py_str(v)
        } else {
            String::new()
        }
    };
    let original = svc.k.blobs.get(&hash("imageHash"));
    let mask = svc.k.blobs.get(&hash("maskHash"));
    let (Some(original), Some(mask)) = (
        original.filter(|d| !d.is_empty()),
        mask.filter(|d| !d.is_empty()),
    ) else {
        return Ok(png);
    };
    Ok(blocking(move || composite_infill(&original, &png, &mask)).await??)
}

async fn fetch_sub(svc: &Arc<GenerationService>) -> Value {
    svc.gateway
        .fetch_subscription(None)
        .await
        .unwrap_or(Value::Null)
}

fn text_of(v: &Value) -> String {
    if truthy(v) {
        py_str(v)
    } else {
        String::new()
    }
}

/// 专用放大：不经过扩散模型，直接调 /ai/upscale。
async fn run_upscale(
    svc: &Arc<GenerationService>,
    job_id: &str,
    job: &GenerationJob,
    body: &Value,
    bucket: &Bucket,
) -> RunRes<()> {
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
    svc.emit(json!({"type": "preview", "id": job_id, "text": "放大中", "sample": 0}));
    let inherit = if get(body, "inherit").is_object() {
        get(body, "inherit").clone()
    } else {
        json!({})
    };
    let out = svc
        .gateway
        .upscale_image(&png, get(&inherit, "model"))
        .await?;
    if svc.cancelled(job_id) {
        return Err(RunErr::Interrupted);
    }
    let rec = svc.store_image(bucket, &out)?;
    svc.stage(job_id, &rec);
    let mut meta = inherit.as_object().cloned().unwrap_or_default();
    meta.insert("requestType".into(), json!("upscale"));
    meta.insert("scale".into(), json!(factor));
    meta.insert("sourceHash".into(), json!(text_of(get(body, "imageHash"))));
    meta.insert("width".into(), get(&rec, "width").clone());
    meta.insert("height".into(), get(&rec, "height").clone());
    let meta = Value::Object(meta);
    let items = vec![rec];
    svc.bind_test_set_items(
        &job.source,
        &Value::Object(job.client.clone()),
        &items,
        &meta,
    );
    let sub = fetch_sub(svc).await;
    svc.mutate_job(job_id, |j| {
        j.complete(Value::Array(items), meta, sub, now_ms())
    });
    Ok(())
}

/// Enhance 的 Max 档：原尺寸 img2img 之后再接一次 2x 放大。
async fn post_upscale(
    svc: &Arc<GenerationService>,
    job_id: &str,
    items: Vec<Value>,
    meta: &mut Value,
    bucket: &Bucket,
) -> RunRes<Vec<Value>> {
    let factor = {
        let v = get(meta, "postUpscale");
        if truthy(v) {
            to_int(v).unwrap_or(0)
        } else {
            0
        }
    };
    if factor == 0 {
        return Ok(items);
    }
    svc.emit(json!({"type": "preview", "id": job_id, "text": "放大中", "sample": 0}));
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
        let rec = svc.store_image(bucket, &upscaled)?;
        svc.stage(job_id, &rec);
        out.push(rec);
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
    bucket: &Bucket,
) -> RunRes<()> {
    let items = post_upscale(svc, job_id, items, &mut meta, bucket).await?;
    let sub = fetch_sub(svc).await;
    svc.bind_test_set_items(
        &job.source,
        &Value::Object(job.client.clone()),
        &items,
        &meta,
    );
    svc.mutate_job(job_id, |j| {
        j.complete(Value::Array(items), meta, sub, now_ms())
    });
    Ok(())
}

async fn run_inner(
    svc: &Arc<GenerationService>,
    job_id: &str,
    job: &GenerationJob,
    body: &Value,
    steps: i64,
    n_samples: i64,
    bucket: &Bucket,
) -> RunRes<()> {
    let kind = if truthy(get(body, "kind")) {
        py_str(get(body, "kind"))
    } else {
        "generate".into()
    };
    if kind == "upscale" {
        return run_upscale(svc, job_id, job, body, bucket).await;
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
                let rec = svc.store_image(bucket, &png)?;
                svc.stage(job_id, &rec);
                items.push(rec);
            }
            return finish(svc, job_id, job, items, meta, bucket).await;
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
                if truthy(v) {
                    to_int(v).unwrap_or(0)
                } else {
                    0
                }
            };
            let image = get(&chunk, "image").as_str().unwrap_or("").to_string();
            if et == "intermediate"
                && !image.is_empty()
                && truthy(&svc.cfg("generation", "streamPreview", json!(true)))
            {
                let step = get(&chunk, "step_ix").clone();
                let text = progress_text(sample, &step, steps, n_samples);
                let raw = decode_image_b64(&image)?;
                let url = svc.write_preview(job_id, sample, &raw);
                svc.emit(json!({"type": "preview", "id": job_id, "url": url, "step": step, "sample": sample, "text": text}));
            } else if et == "final" && !image.is_empty() {
                let png = infill_png(svc, body, decode_image_b64(&image)?).await?;
                let rec = svc.store_image(bucket, &png)?;
                svc.stage(job_id, &rec);
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
    finish(svc, job_id, job, items, meta, bucket).await
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
        if truthy(v) {
            to_int(v).unwrap_or(default)
        } else {
            default
        }
    };
    let steps = int_of("steps", 28);
    let n_samples = int_of("nSamples", 1);
    let bucket = Bucket::for_job(&job.source, &Value::Object(job.client.clone()));

    let result = run_inner(&svc, &job_id, &job, &body, steps, n_samples, &bucket).await;
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
                let msg = if msg.is_empty() {
                    "生图失败".to_string()
                } else {
                    msg
                };
                svc.mutate_job(&job_id, |j| j.fail(&msg, now_ms()));
            }
        }
    }
    svc.settle(&job_id);
    svc.release_staged(&job_id);
    svc.clear_previews(&job_id);
}

/// 还没有抽过间隔。真正的等待最长 180 秒，用不到这个值。
const NO_LAST_MS: u64 = u64::MAX;
/// 队列全部结束后再过这么久，下一张手动生成不再额外等待。
const QUEUE_IDLE: Duration = Duration::from_secs(2);

struct Gate {
    running: Arc<AtomicUsize>,
    notify: Notify,
    /// 并发名额回到 0 时调用。参数是同一份计数，空闲计时到期后再读一次。
    on_zero: Arc<dyn Fn(Arc<AtomicUsize>) + Send + Sync>,
}

/// 占着的并发名额。任务正常结束或 panic 都要还回去，否则后面的任务再也排不上。
struct Permit(Arc<Gate>);

impl Drop for Permit {
    fn drop(&mut self) {
        let prev = self.0.running.fetch_sub(1, Ordering::SeqCst);
        self.0.notify.notify_one();
        if prev == 1 {
            (self.0.on_zero)(Arc::clone(&self.0.running));
        }
    }
}

/// 这一串队列的间隔状态。只记住上一次等了多少毫秒，用来避开重复，不记住下一次该等多久。
struct Pace {
    burst: AtomicBool,
    gen: AtomicU64,
    last_ms: AtomicU64,
    rng: AtomicU64,
}

impl Pace {
    fn new() -> Self {
        Self {
            burst: AtomicBool::new(false),
            gen: AtomicU64::new(0),
            last_ms: AtomicU64::new(NO_LAST_MS),
            rng: AtomicU64::new(0),
        }
    }

    /// 在当前上下限里当场抽一个毫秒数。关闭时返回 `None`。
    fn draw(&self, min_sec: i64, max_sec: i64) -> Option<u64> {
        let (lo, hi) = delay_bounds(min_sec, max_sec)?;
        let last_raw = self.last_ms.load(Ordering::Relaxed);
        let last = if last_raw == NO_LAST_MS {
            None
        } else {
            Some(last_raw)
        };
        let ms = different_delay(lo, hi, last, || self.next_u64());
        self.last_ms.store(ms, Ordering::Relaxed);
        Some(ms)
    }

    fn next_u64(&self) -> u64 {
        let mut state = self.rng.load(Ordering::Relaxed);
        loop {
            if state == 0 {
                state = seed_rng();
            }
            let mut next = state;
            next ^= next >> 12;
            next ^= next << 25;
            next ^= next >> 27;
            if next == 0 {
                next = 0x9E37_79B9_7F4A_7C15;
            }
            match self
                .rng
                .compare_exchange_weak(state, next, Ordering::Relaxed, Ordering::Relaxed)
            {
                Ok(_) => return next.wrapping_mul(0x2545_F491_4F6C_DD1D),
                Err(cur) => state = cur,
            }
        }
    }
}

fn seed_rng() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0xA076_1D64_78BD_642F);
    let mixed = nanos ^ 0x9E37_79B9_7F4A_7C15;
    if mixed == 0 {
        0xA076_1D64_78BD_642F
    } else {
        mixed
    }
}

/// 上下限都是 0 时关闭。下限大于上限则对调。返回闭区间的毫秒数。
fn delay_bounds(min_sec: i64, max_sec: i64) -> Option<(u64, u64)> {
    let mut lo = min_sec.clamp(0, 120);
    let mut hi = max_sec.clamp(0, 180);
    if lo > hi {
        std::mem::swap(&mut lo, &mut hi);
    }
    if lo == 0 && hi == 0 {
        return None;
    }
    Some((lo as u64 * 1000, hi as u64 * 1000))
}

/// 在闭区间里均匀抽一个毫秒数。区间里还有别的长度时，不能和上一次相同。
fn different_delay(lo: u64, hi: u64, last: Option<u64>, mut roll: impl FnMut() -> u64) -> u64 {
    if lo >= hi {
        return lo;
    }
    let span = hi - lo + 1;
    for _ in 0..8 {
        let ms = lo + roll() % span;
        if Some(ms) != last {
            return ms;
        }
    }
    let prev = last.unwrap_or(lo);
    if prev >= hi {
        lo
    } else {
        prev + 1
    }
}

/// 空闲计时到期时，只有代数没变并且没有任务占着名额，才结束这一串。
fn should_end_burst(gen_now: u64, gen_at_schedule: u64, running: usize) -> bool {
    gen_now == gen_at_schedule && running == 0
}

fn concurrency_limit(svc: &GenerationService) -> usize {
    let n = svc
        .settings
        .value_i64("generation", "concurrency", 1)
        .max(1) as usize;
    n.clamp(1, MAX_WORKERS)
}

/// 先登记等待，再看名额，避免释放发生在两次检查之间时这一次唤醒丢失。
async fn acquire_slot(gate: &Gate, limit: &impl Fn() -> usize) {
    loop {
        let notified = std::pin::pin!(gate.notify.notified());
        let max = limit().clamp(1, MAX_WORKERS);
        let cur = gate.running.load(Ordering::SeqCst);
        if cur < max
            && gate
                .running
                .compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            return;
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), notified).await;
    }
}

/// 每 200ms 看一次取消。返回 `false` 表示等待被取消，调用方不要再请求 NovelAI。
async fn sleep_unless_cancelled(svc: &GenerationService, job_id: &str, total: Duration) -> bool {
    let step = Duration::from_millis(200);
    let start = tokio::time::Instant::now();
    loop {
        if svc.cancelled(job_id) {
            return false;
        }
        let left = total.saturating_sub(start.elapsed());
        if left.is_zero() {
            return !svc.cancelled(job_id);
        }
        tokio::time::sleep(left.min(step)).await;
    }
}

/// 这一串里已经发过请求时，当场抽一个新间隔再等。第一张，以及空闲约 2 秒后的下一张，直接过。
async fn wait_turn(svc: &GenerationService, pace: &Pace, job_id: &str) -> bool {
    if svc.cancelled(job_id) {
        return false;
    }
    if pace.burst.load(Ordering::SeqCst) {
        let min_sec = svc.settings.value_i64("generation", "queueDelayMinSec", 8);
        let max_sec = svc.settings.value_i64("generation", "queueDelayMaxSec", 30);
        if let Some(ms) = pace.draw(min_sec, max_sec) {
            if ms > 0 {
                svc.emit(json!({"type": "preview", "id": job_id, "text": "等待中"}));
                if !sleep_unless_cancelled(svc, job_id, Duration::from_millis(ms)).await {
                    return false;
                }
            }
        }
    }
    pace.burst.store(true, Ordering::SeqCst);
    true
}

/// 只有这一个消费者按入队顺序取任务：拿到名额才开始下一条。
/// 以前每个空闲 worker 都会先把任务抽走再抢名额，并发为 1 时后抽到的任务可能先跑，先抽到的一直停在「排队中」。
/// `before` 在占着名额时执行，返回 `false` 就放弃这一张、不再调用 `run`。
async fn dispatch_queue<L, B, BFut, F, Fut>(
    mut rx: UnboundedReceiver<String>,
    limit: L,
    mut before: B,
    run: F,
    on_zero: Arc<dyn Fn(Arc<AtomicUsize>) + Send + Sync>,
) where
    L: Fn() -> usize + Send,
    B: FnMut(String) -> BFut + Send,
    BFut: Future<Output = bool> + Send,
    F: Fn(String) -> Fut + Send,
    Fut: Future<Output = ()> + Send + 'static,
{
    let gate = Arc::new(Gate {
        running: Arc::new(AtomicUsize::new(0)),
        notify: Notify::new(),
        on_zero,
    });
    while let Some(job_id) = rx.recv().await {
        acquire_slot(&gate, &limit).await;
        let permit = Permit(gate.clone());
        if !before(job_id.clone()).await {
            drop(permit);
            continue;
        }
        let task = run(job_id);
        tokio::spawn(async move {
            let _permit = permit;
            task.await;
        });
    }
}

/// 实际并发数由设置 `generation.concurrency` 动态限制（默认 1，最多 MAX_WORKERS）。
/// 队列间隔由 `generation.queueDelayMinSec` / `queueDelayMaxSec` 决定，每次当场重抽。
pub fn start_workers(svc: Arc<GenerationService>) {
    let Some(rx) = svc.take_receiver() else {
        return;
    };
    if let Err(e) = svc.resume_pending() {
        eprintln!("[generation] 恢复排队任务失败：{}", e.message);
    }
    let svc_limit = svc.clone();
    let svc_run = svc.clone();
    let svc_wait = svc.clone();
    let pace = Arc::new(Pace::new());
    let pace_wait = pace.clone();
    let pace_idle = pace.clone();
    let on_zero: Arc<dyn Fn(Arc<AtomicUsize>) + Send + Sync> = Arc::new(move |running| {
        let gen = pace_idle.gen.fetch_add(1, Ordering::SeqCst) + 1;
        let pace = pace_idle.clone();
        tokio::spawn(async move {
            tokio::time::sleep(QUEUE_IDLE).await;
            if should_end_burst(
                pace.gen.load(Ordering::SeqCst),
                gen,
                running.load(Ordering::SeqCst),
            ) {
                pace.burst.store(false, Ordering::SeqCst);
            }
        });
    });
    tauri::async_runtime::spawn(async move {
        dispatch_queue(
            rx,
            move || concurrency_limit(&svc_limit),
            move |job_id| {
                let svc_wait = svc_wait.clone();
                let pace_wait = pace_wait.clone();
                async move { wait_turn(&svc_wait, &pace_wait, &job_id).await }
            },
            move |job_id| {
                let svc_run = svc_run.clone();
                async move { run_job(svc_run, job_id).await }
            },
            on_zero,
        )
        .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tokio::sync::{mpsc, Mutex as AsyncMutex};

    fn noop_zero() -> Arc<dyn Fn(Arc<AtomicUsize>) + Send + Sync> {
        Arc::new(|_| {})
    }

    async fn wait_until(mut pred: impl FnMut() -> bool) {
        for _ in 0..100 {
            if pred() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("调度没有在时限内推进");
    }

    async fn recorded_order(limit: usize) -> Vec<String> {
        let (tx, rx) = mpsc::unbounded_channel();
        let started = Arc::new(StdMutex::new(Vec::new()));
        let hold = Arc::new(AsyncMutex::new(()));
        let guard = hold.lock().await;
        let started2 = started.clone();
        let hold2 = hold.clone();
        let dispatch = tokio::spawn(dispatch_queue(
            rx,
            move || limit,
            |_| async { true },
            move |id| {
                started2.lock().unwrap().push(id);
                let hold2 = hold2.clone();
                async move {
                    let _guard = hold2.lock().await;
                }
            },
            noop_zero(),
        ));
        for n in ["2", "3", "4", "5", "6", "7"] {
            tx.send(n.to_string()).unwrap();
        }
        wait_until(|| started.lock().unwrap().len() == limit).await;
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            started.lock().unwrap().len(),
            limit,
            "没拿到名额的任务不应先开始"
        );
        drop(guard);
        wait_until(|| started.lock().unwrap().len() == 6).await;
        let order = started.lock().unwrap().clone();
        drop(tx);
        let _ = tokio::time::timeout(Duration::from_secs(2), dispatch).await;
        order
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrency_one_starts_in_enqueue_order() {
        assert_eq!(recorded_order(1).await, ["2", "3", "4", "5", "6", "7"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrency_three_does_not_start_past_the_limit() {
        assert_eq!(recorded_order(3).await, ["2", "3", "4", "5", "6", "7"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn before_hook_holds_the_slot_until_it_returns() {
        let (tx, rx) = mpsc::unbounded_channel();
        let started = Arc::new(StdMutex::new(Vec::new()));
        let calls = Arc::new(AtomicUsize::new(0));
        let hold = Arc::new(AsyncMutex::new(()));
        let guard = hold.lock().await;
        let started2 = started.clone();
        let calls2 = calls.clone();
        let hold2 = hold.clone();
        let dispatch = tokio::spawn(dispatch_queue(
            rx,
            || 2,
            move |_| {
                let calls2 = calls2.clone();
                let hold2 = hold2.clone();
                async move {
                    let i = calls2.fetch_add(1, Ordering::SeqCst);
                    if i == 1 {
                        let _g = hold2.lock().await;
                    }
                    true
                }
            },
            move |id| {
                let started2 = started2.clone();
                async move {
                    started2.lock().unwrap().push(id);
                }
            },
            noop_zero(),
        ));
        for n in ["a", "b", "c"] {
            tx.send(n.to_string()).unwrap();
        }
        wait_until(|| started.lock().unwrap().len() == 1 && calls.load(Ordering::SeqCst) == 2)
            .await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(
            started.lock().unwrap().as_slice(),
            ["a"],
            "第二张还在等待时，第三张不能先开始"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "调度循环要停在第二张的等待里"
        );
        drop(guard);
        wait_until(|| started.lock().unwrap().len() == 3).await;
        let order = started.lock().unwrap().clone();
        assert_eq!(order[0], "a");
        let mut rest = order[1..].to_vec();
        rest.sort();
        assert_eq!(rest, ["b", "c"]);
        drop(tx);
        let _ = tokio::time::timeout(Duration::from_secs(2), dispatch).await;
    }

    #[test]
    fn zero_bounds_disable_the_delay() {
        assert_eq!(delay_bounds(0, 0), None);
    }

    #[test]
    fn inverted_bounds_are_swapped_into_milliseconds() {
        assert_eq!(delay_bounds(30, 8), Some((8_000, 30_000)));
        assert_eq!(delay_bounds(-4, 200), Some((0, 180_000)));
    }

    #[test]
    fn redraws_when_the_roll_matches_the_previous_wait() {
        let ms = different_delay(1_000, 3_000, Some(1_000), || 0);
        assert_ne!(ms, 1_000);
        assert!((1_000..=3_000).contains(&ms));
    }

    #[test]
    fn same_bounds_stay_fixed_even_if_it_matches_the_last_wait() {
        assert_eq!(different_delay(8_000, 8_000, Some(8_000), || 123), 8_000);
    }

    #[test]
    fn consecutive_draws_never_repeat_the_previous_wait() {
        let pace = Pace::new();
        pace.rng.store(0x1234_5678_9ABC_DEF0, Ordering::Relaxed);
        let mut prev = None;
        for _ in 0..32 {
            let ms = pace.draw(8, 30).expect("默认区间应当开启等待");
            if let Some(p) = prev {
                assert_ne!(ms, p, "连续两次间隔不能相同");
            }
            assert!((8_000..=30_000).contains(&ms));
            prev = Some(ms);
        }
    }

    #[test]
    fn idle_timer_ends_the_burst_only_when_nothing_replaced_it() {
        assert!(should_end_burst(5, 5, 0));
        assert!(
            !should_end_burst(6, 5, 0),
            "后面又有任务结束过，这一次计时作废"
        );
        assert!(!should_end_burst(5, 5, 1), "还有任务占着名额");
    }
}
