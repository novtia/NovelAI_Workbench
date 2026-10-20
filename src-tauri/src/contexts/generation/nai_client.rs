//! NovelAI 网络层：Token 存取、订阅查询、生图（流式 / 非流式）、放大。

use super::nai_images::{unwrap_image, unzip_images};
use super::nai_payload::*;
use crate::util::{get, num_f, py_str, to_float, to_int, truthy};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

pub struct TokenVault {
    path: PathBuf,
}

impl TokenVault {
    pub fn new(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        TokenVault { path }
    }

    pub fn load(&self) -> String {
        if let Ok(text) = std::fs::read_to_string(&self.path) {
            let stored = text.trim().to_string();
            if !stored.is_empty() {
                return stored;
            }
        }
        std::env::var("NAI_ACCESS_TOKEN")
            .ok()
            .or_else(|| std::env::var("NAI_API_TOKEN").ok())
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    pub fn save(&self, token: &str) {
        let token = token.trim();
        if token.is_empty() {
            let _ = std::fs::remove_file(&self.path);
            return;
        }
        let _ = std::fs::write(&self.path, token);
    }
}

type FloatProvider = Arc<dyn Fn() -> f64 + Send + Sync>;
type StringProvider = Arc<dyn Fn() -> String + Send + Sync>;

pub struct NaiGateway {
    pub vault: Arc<TokenVault>,
    timeout_provider: RwLock<Option<FloatProvider>>,
    base_url_provider: RwLock<Option<StringProvider>>,
}

fn tier_name(tier: i64) -> String {
    match tier {
        0 => "无订阅".into(),
        1 => "Tablet".into(),
        2 => "Scroll".into(),
        3 => "Opus".into(),
        n => format!("Tier {n}"),
    }
}

fn parse_error(status: u16, body: &[u8]) -> NaiError {
    let text = String::from_utf8_lossy(body);
    let message = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(o)) => {
            let m = o.get("message").filter(|v| truthy(v)).or_else(|| o.get("error").filter(|v| truthy(v)));
            match m {
                None => String::new(),
                Some(Value::Object(inner)) => match inner.get("message").filter(|v| truthy(v)) {
                    Some(v) => py_str(v),
                    None => crate::pyjson::dumps(&Value::Object(inner.clone())),
                },
                Some(v) => py_str(v),
            }
        }
        _ => text.chars().take(400).collect(),
    };
    NaiError::new(status, if message.is_empty() { "NovelAI 请求失败".to_string() } else { message })
}

fn first_truthy<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if truthy(a) { a } else { b }
}

fn int_of(v: &Value) -> i64 {
    if truthy(v) { to_int(v).unwrap_or(0) } else { 0 }
}

impl NaiGateway {
    pub fn new(vault: Arc<TokenVault>) -> Self {
        NaiGateway { vault, timeout_provider: RwLock::new(None), base_url_provider: RwLock::new(None) }
    }

    pub fn set_timeout_provider(&self, p: FloatProvider) {
        *self.timeout_provider.write().unwrap_or_else(|e| e.into_inner()) = Some(p);
    }

    pub fn set_base_url_provider(&self, p: StringProvider) {
        *self.base_url_provider.write().unwrap_or_else(|e| e.into_inner()) = Some(p);
    }

    /// 网关地址；空串或非 http(s) 地址都回到官方地址。
    fn image_api(&self) -> String {
        let raw = self
            .base_url_provider
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|p| p())
            .unwrap_or_default();
        let raw = raw.trim().trim_end_matches('/').to_string();
        let lower = raw.to_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") { raw } else { IMAGE_API.to_string() }
    }

    fn gen_timeout(&self) -> f64 {
        self.timeout_provider.read().unwrap_or_else(|e| e.into_inner()).as_ref().map(|p| p()).unwrap_or(180.0)
    }

    fn gen_client(&self) -> NaiRes<reqwest::Client> {
        let t = Duration::from_secs_f64(self.gen_timeout().max(1.0));
        reqwest::Client::builder()
            .connect_timeout(t)
            .read_timeout(t)
            .build()
            .map_err(|e| NaiError::new(502, format!("无法初始化网络：{e}")))
    }

    fn token(&self) -> NaiRes<String> {
        let t = self.vault.load();
        if t.is_empty() {
            return Err(NaiError::new(401, "还没有配置 NovelAI Persistent API Token"));
        }
        Ok(t)
    }

    fn headers(token: &str, accept: &str) -> reqwest::header::HeaderMap {
        use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
        let mut h = HeaderMap::new();
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {token}")) {
            h.insert(AUTHORIZATION, v);
        }
        if let Ok(v) = HeaderValue::from_str(accept) {
            h.insert(ACCEPT, v);
        }
        h.insert(USER_AGENT, HeaderValue::from_static("ArtistGallery/1.0"));
        h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        h
    }

    pub async fn fetch_subscription(&self, token: Option<&str>) -> NaiRes<Value> {
        let token = match token {
            Some(t) if !t.is_empty() => t.to_string(),
            _ => self.token()?,
        };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| NaiError::new(502, format!("无法连接 NovelAI：{e}")))?;
        let resp = client
            .get(format!("{}/user/subscription", self.image_api()))
            .headers(Self::headers(&token, "*/*"))
            .send()
            .await
            .map_err(|e| NaiError::new(502, format!("无法连接 NovelAI：{e}")))?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await.map_err(|e| NaiError::new(502, format!("无法连接 NovelAI：{e}")))?;
        if status >= 400 {
            return Err(parse_error(status, &bytes));
        }
        // 自建网关没有 /user/subscription，会回一个网页而不是 JSON；只是看不到额度，不影响生图。
        let data: Value = serde_json::from_slice(&bytes)
            .map_err(|_| NaiError::new(404, "当前网关不提供订阅与额度信息"))?;
        if !data.is_object() {
            return Err(NaiError::new(404, "当前网关不提供订阅与额度信息"));
        }
        let empty = json!({});
        let training = {
            let t = first_truthy(get(&data, "trainingStepsLeft"), get(&data, "training_steps_left"));
            if truthy(t) { t } else { &empty }
        };
        let fixed = int_of(first_truthy(
            get(training, "fixedTrainingStepsLeft"),
            get(training, "fixed_training_steps_left"),
        ));
        let purchased = {
            let a = get(training, "purchasedTrainingSteps");
            let b = get(training, "purchased_training_steps");
            let c = get(&data, "purchasedTrainingSteps");
            int_of(if truthy(a) { a } else if truthy(b) { b } else { c })
        };
        let tier = int_of(get(&data, "tier"));
        let name = {
            let a = get(&data, "tierName");
            let b = get(&data, "tier_name");
            if truthy(a) { py_str(a) } else if truthy(b) { py_str(b) } else { tier_name(tier) }
        };
        let usage = if get(&data, "usage").is_object() { get(&data, "usage").clone() } else { json!({}) };
        let usage_percent = match get(&usage, "percent") {
            Value::Null => Value::Null,
            v => to_float(v).map(num_f).unwrap_or(Value::Null),
        };
        let active = match data.get("active") {
            None => true,
            Some(v) => truthy(v),
        };
        Ok(json!({
            "tier": tier,
            "tierName": name,
            "active": active,
            "opus": tier >= 3 || name.to_lowercase() == "opus",
            "anlas": 0.max(fixed + purchased),
            "anlasFixed": 0.max(fixed),
            "anlasPurchased": 0.max(purchased),
            "usagePercent": usage_percent,
            "usageNegative": truthy(first_truthy(get(&usage, "isNegative"), get(&usage, "is_negative"))),
            "expiresAt": first_truthy(get(&data, "expiresAt"), get(&data, "expires_at")).clone(),
        }))
    }

    /// 专用放大（不受 prompt 影响）。现在的 image.novelai.net/ai/upscale 只收 image + model，固定放大 2 倍。
    pub async fn upscale_image(&self, png: &[u8], model: &Value) -> NaiRes<Vec<u8>> {
        let token = self.token()?;
        let body = json!({"image": STANDARD.encode(png), "model": upscale_model(model)});
        let resp = self
            .gen_client()?
            .post(format!("{}/ai/upscale", self.image_api()))
            .headers(Self::headers(&token, "*/*"))
            .body(serde_json::to_vec(&body).unwrap_or_default())
            .send()
            .await
            .map_err(|e| NaiError::new(502, format!("无法连接 NovelAI：{e}")))?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await.map_err(|e| NaiError::new(502, format!("无法连接 NovelAI：{e}")))?;
        if status >= 400 {
            return Err(parse_error(status, &bytes));
        }
        unwrap_image(bytes.to_vec())
    }

    pub async fn generate_images(&self, payload: &Value) -> NaiRes<Vec<Vec<u8>>> {
        let token = self.token()?;
        let resp = self
            .gen_client()?
            .post(format!("{}/ai/generate-image", self.image_api()))
            .headers(Self::headers(&token, "*/*"))
            .body(serde_json::to_vec(payload).unwrap_or_default())
            .send()
            .await
            .map_err(|e| NaiError::new(502, format!("无法连接 NovelAI：{e}")))?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await.map_err(|e| NaiError::new(502, format!("无法连接 NovelAI：{e}")))?;
        if status >= 400 {
            return Err(parse_error(status, &bytes));
        }
        unzip_images(&bytes)
    }

    /// 打开 SSE 流；4xx/5xx 在这里就转成 `NaiError`。
    pub async fn open_stream(&self, payload: &Value) -> NaiRes<reqwest::Response> {
        let token = self.token()?;
        let mut payload = payload.clone();
        payload["parameters"]["stream"] = json!("sse");
        let resp = self
            .gen_client()?
            .post(format!("{}/ai/generate-image-stream", self.image_api()))
            .headers(Self::headers(&token, "text/event-stream"))
            .body(serde_json::to_vec(&payload).unwrap_or_default())
            .send()
            .await
            .map_err(|e| NaiError::new(502, format!("无法连接 NovelAI：{e}")))?;
        let status = resp.status().as_u16();
        if status >= 400 {
            let bytes = resp.bytes().await.unwrap_or_default();
            return Err(parse_error(status, &bytes));
        }
        Ok(resp)
    }
}

/// 增量 SSE 解析：按空行切事件，取 `data:` 行拼成 JSON 对象。
#[derive(Default)]
pub struct SseParser {
    pending: Vec<u8>,
    buf: String,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 增量 UTF-8 解码（非法字节换成 U+FFFD，不完整的结尾留到下一块）。
    fn decode(&mut self, chunk: &[u8], last: bool) {
        self.pending.extend_from_slice(chunk);
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    self.buf.push_str(s);
                    self.pending.clear();
                    return;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    self.buf.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or(""));
                    match e.error_len() {
                        Some(n) => {
                            self.buf.push('\u{FFFD}');
                            self.pending.drain(..valid + n);
                        }
                        None => {
                            self.pending.drain(..valid);
                            if last {
                                self.buf.push('\u{FFFD}');
                                self.pending.clear();
                            }
                            return;
                        }
                    }
                }
            }
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Value> {
        self.decode(chunk, false);
        let mut out = Vec::new();
        loop {
            let crlf = self.buf.find("\r\n\r\n");
            let lf = self.buf.find("\n\n");
            let (event, rest) = match (crlf, lf) {
                (None, None) => break,
                (c, Some(l)) if c.map(|c| l < c).unwrap_or(true) => {
                    (self.buf[..l].to_string(), self.buf[l + 2..].to_string())
                }
                (Some(c), _) => (self.buf[..c].to_string(), self.buf[c + 4..].to_string()),
                _ => break,
            };
            self.buf = rest;
            if let Some(v) = parse_sse_json(&event) {
                out.push(v);
            }
        }
        out
    }

    pub fn finish(&mut self) -> Vec<Value> {
        self.decode(&[], true);
        let rest = std::mem::take(&mut self.buf);
        if rest.trim().is_empty() {
            return vec![];
        }
        parse_sse_json(&rest).into_iter().collect()
    }
}

fn parse_sse_json(event: &str) -> Option<Value> {
    let normalized = event.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> =
        normalized.split('\n').filter_map(|l| l.strip_prefix("data:")).map(|l| l.trim_start()).collect();
    if lines.is_empty() {
        return None;
    }
    let raw = lines.join("\n");
    let raw = raw.trim();
    if raw.is_empty() || raw == "[DONE]" {
        return None;
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(v) if v.is_object() => Some(v),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn sse_splits_events_and_handles_split_utf8() {
        let mut p = SseParser::new();
        let text = "data: {\"a\":\"画\"}\n\ndata: {\"b\":2}\r\n\r\ndata: [DONE]\n\n";
        let bytes = text.as_bytes();
        // 把“画”的三个字节拆开喂
        let cut = text.find('画').unwrap() + 1;
        let mut got = p.feed(&bytes[..cut]);
        got.extend(p.feed(&bytes[cut..]));
        got.extend(p.finish());
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["a"], "画");
        assert_eq!(got[1]["b"], 2);
    }

    #[test]
    fn error_message_shapes() {
        assert_eq!(parse_error(400, br#"{"message":"bad"}"#).message, "bad");
        assert_eq!(parse_error(401, br#"{"error":{"message":"nope"}}"#).message, "nope");
        assert_eq!(parse_error(500, b"<html>oops</html>").message, "<html>oops</html>");
        assert_eq!(parse_error(500, br#"{}"#).message, "NovelAI 请求失败");
    }

    #[test]
    fn hint_masks_token() {
        assert_eq!(token_hint("short"), "已保存");
        assert_eq!(token_hint("pst-abcdefgh1234"), "••••1234");
    }

    fn gateway(dir: &std::path::Path) -> NaiGateway {
        NaiGateway::new(Arc::new(TokenVault::new(dir.join("nai.token"))))
    }

    #[test]
    fn gateway_url_is_normalized_and_validated() {
        let dir = tempfile::tempdir().unwrap();
        let gw = gateway(dir.path());
        let url = Arc::new(Mutex::new(String::new()));
        let u = url.clone();
        gw.set_base_url_provider(Arc::new(move || u.lock().unwrap().clone()));
        assert_eq!(gw.image_api(), IMAGE_API);
        *url.lock().unwrap() = " https://moyan.ink/ ".into();
        assert_eq!(gw.image_api(), "https://moyan.ink");
        *url.lock().unwrap() = "ftp://bad".into();
        assert_eq!(gw.image_api(), IMAGE_API);
    }

    /// 起一个只回固定响应的本地服务，返回它的地址。
    fn serve_once(status_line: &'static str, content_type: &'static str, body: &'static str) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn non_json_gateway_is_reported_as_missing_subscription() {
        let dir = tempfile::tempdir().unwrap();
        let gw = gateway(dir.path());
        let base = serve_once("200 OK", "text/html", "<html></html>");
        gw.set_base_url_provider(Arc::new(move || base.clone()));
        let e = gw.fetch_subscription(Some("sk-test")).await.unwrap_err();
        assert_eq!(e.status, 404);
    }

    #[tokio::test]
    async fn subscription_json_is_summarized() {
        let dir = tempfile::tempdir().unwrap();
        let gw = gateway(dir.path());
        let base = serve_once(
            "200 OK",
            "application/json",
            r#"{"tier":3,"trainingStepsLeft":{"fixedTrainingStepsLeft":100,"purchasedTrainingSteps":5},"active":true}"#,
        );
        gw.set_base_url_provider(Arc::new(move || base.clone()));
        let sub = gw.fetch_subscription(Some("sk-test")).await.unwrap();
        assert_eq!(sub["tierName"], "Opus");
        assert_eq!(sub["opus"], true);
        assert_eq!(sub["anlas"], 105);
    }

    #[tokio::test]
    async fn gateway_error_status_carries_message() {
        let dir = tempfile::tempdir().unwrap();
        let gw = gateway(dir.path());
        let base = serve_once("401 Unauthorized", "application/json", r#"{"message":"bad token"}"#);
        gw.set_base_url_provider(Arc::new(move || base.clone()));
        let e = gw.fetch_subscription(Some("sk-test")).await.unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (401, "bad token"));
    }
}
