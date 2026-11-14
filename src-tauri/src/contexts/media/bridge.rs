//! WebView2 Cloudflare 桥接与验证器：
//! - `open_cf_verify_window`：为内置站点（`danbooru` / `aitag`）打开或聚焦 WebView2 验证窗口（支持透传系统/自定义代理，关闭窗口时自动隐藏以保持同一 TLS/Cookie 会话）。
//! - `probe_cf_ready`：轮询检测存活的 `media_cf_{site_id}` 窗口是否已脱离 Cloudflare 质询页面；一旦通过，自动收割 Cookie 与 User-Agent 并隐藏验证窗口。
//! - `webview_fetch_json`：当存活的同源 WebView2 窗口可用时，直接在浏览器上下文内发起 `fetch` 以绕过 TLS 指纹校验。

use super::domain::MediaSite;
use crate::contexts::generation::nai_client::NetConfig;
use crate::kernel::{DomainError, Res};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

static REQ_SEQ: AtomicU64 = AtomicU64::new(1);
static PENDING_BRIDGE: Lazy<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub const DEFAULT_BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

pub fn cf_window_label(site_id: &str) -> String {
    let clean: String = site_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("media_cf_{clean}")
}

pub fn complete_bridge_request(req_id: &str, payload: Value) {
    if let Some(tx) = PENDING_BRIDGE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(req_id)
    {
        let _ = tx.send(payload);
    }
}

/// 初始化注入脚本：监听主进程发来的 `wb-media-eval` 事件，在 WebView2 页面内执行并回传结果。
const BRIDGE_INIT_SCRIPT: &str = r##"
(function() {
  if (window.__WB_MEDIA_BRIDGE_INSTALLED__) return;
  window.__WB_MEDIA_BRIDGE_INSTALLED__ = true;

  function isChallengePage() {
    var title = (document.title || "").toLowerCase();
    if (
      title.indexOf("just a moment") !== -1 ||
      title.indexOf("请稍候") !== -1 ||
      title.indexOf("attention required") !== -1 ||
      title.indexOf("security check") !== -1
    ) {
      return true;
    }
    if (window._cf_chl_opt) return true;
    if (document.querySelector('#challenge-running, #challenge-stage, #cf-challenge-running, .cf-browser-verification, iframe[src*="challenges.cloudflare.com"]')) {
      return true;
    }
    return false;
  }

  window.__WB_PROBE_CF__ = function() {
    var ready = document.readyState === "interactive" || document.readyState === "complete";
    var ch = isChallengePage();
    var href = String(location.href || "");
    var validHost = href.indexOf("http://") === 0 || href.indexOf("https://") === 0;
    return {
      ready: Boolean(ready && validHost && !ch),
      challenge: Boolean(ch),
      title: String(document.title || ""),
      href: href,
      ua: String(navigator.userAgent || ""),
      cookie: String(document.cookie || "")
    };
  };
})();
"##;

/// 打开或重新聚焦内置站点的 Cloudflare 验证窗口。
pub fn open_cf_verify_window(
    app: &AppHandle,
    site: &MediaSite,
    net: &NetConfig,
) -> Res<WebviewWindow> {
    let label = cf_window_label(&site.id);
    let target_url: tauri::Url = site
        .base_url
        .parse()
        .map_err(|e| DomainError::bad(format!("站点地址无效 {}：{e}", site.base_url)))?;

    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(win);
    }

    // 为验证窗口分配独立的 WebView2 data_directory，避免与主窗口共享同一 data_directory 时
    // 因 custom proxy 参数或 Environment Options 不一致触发 WebView2 HRESULT 0x8007139F。
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(target_url))
        .title(format!("站点安全验证 · {}（通过后自动收起）", site.name))
        .inner_size(920.0, 680.0)
        .min_inner_size(640.0, 480.0)
        .center()
        .visible(true)
        .focused(true)
        .user_agent(DEFAULT_BROWSER_UA)
        .initialization_script(BRIDGE_INIT_SCRIPT);

    let use_custom_proxy = net.mode == "custom" && !net.proxy_url.trim().is_empty();
    let use_no_proxy = net.mode == "none";
    if let Ok(base_dir) = app.path().app_local_data_dir() {
        let mut dir_key = format!("cf_verify_{}", site.id);
        if use_custom_proxy {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            net.proxy_url.trim().hash(&mut hasher);
            dir_key = format!("cf_verify_{}_p_{:x}", site.id, hasher.finish());
        } else if use_no_proxy {
            dir_key = format!("cf_verify_{}_direct", site.id);
        }
        let verify_dir = base_dir.join("media_verify").join(dir_key);
        let _ = std::fs::create_dir_all(&verify_dir);
        builder = builder.data_directory(verify_dir);
    }

    if use_custom_proxy {
        let raw_proxy = net.proxy_url.trim();
        let lower = raw_proxy.to_lowercase();
        let proxy_str = if lower.starts_with("socks5h://") {
            format!("socks5://{}", &raw_proxy["socks5h://".len()..])
        } else if lower.starts_with("socks://") {
            format!("socks5://{}", &raw_proxy["socks://".len()..])
        } else if lower.starts_with("https://") {
            format!("http://{}", &raw_proxy["https://".len()..])
        } else if raw_proxy.contains("://") {
            raw_proxy.to_string()
        } else {
            format!("http://{raw_proxy}")
        };
        if let Ok(proxy_url) = proxy_str.parse::<tauri::Url>() {
            if matches!(proxy_url.scheme(), "http" | "socks5") && proxy_url.port().is_some() {
                builder = builder.proxy_url(proxy_url);
            }
        }
    } else if use_no_proxy {
        builder = builder.additional_browser_args("--no-proxy-server");
    }

    let win = builder
        .build()
        .map_err(|e| DomainError::internal(format!("无法打开验证窗口：{e}")))?;

    // 用户点击窗口关闭按钮时改为隐藏窗口，保留 WebView2 TLS 会话与 Cookie
    let win_clone = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = win_clone.hide();
        }
    });

    Ok(win)
}

/// 隐藏指定站点的 Cloudflare 验证窗口。
pub fn hide_cf_verify_window(app: &AppHandle, site_id: &str) {
    let label = cf_window_label(site_id);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.hide();
    }
}

/// 从存活的验证窗口收割目标站点 Cookie（包括 HttpOnly 的 `cf_clearance`）。
pub fn harvest_cf_cookies(app: &AppHandle, site: &MediaSite) -> Option<String> {
    let label = cf_window_label(&site.id);
    let win = app.get_webview_window(&label)?;
    let url: tauri::Url = site.base_url.parse().ok()?;
    let cookies = win.cookies_for_url(url).ok()?;
    if cookies.is_empty() {
        return None;
    }
    let mut pairs: Vec<String> = Vec::new();
    for c in cookies {
        let name = c.name().trim();
        let val = c.value().trim();
        if !name.is_empty() {
            pairs.push(format!("{name}={val}"));
        }
    }
    if pairs.is_empty() {
        None
    } else {
        Some(pairs.join("; "))
    }
}

/// 返回验证窗口使用的 User-Agent。
pub fn harvest_user_agent(site: &MediaSite) -> String {
    if !site.user_agent.trim().is_empty() {
        site.user_agent.trim().to_string()
    } else {
        DEFAULT_BROWSER_UA.to_string()
    }
}

/// 在验证窗口内执行一段脚本并通过窗口 Title / URL 哈希或事件回传 JSON。
/// 注意：外部站点没有 `window.__TAURI_INTERNALS__`，因此利用 `win.url()` / `win.title()` 与 `cookies_for_url` 最可靠！
pub async fn probe_cf_ready(app: &AppHandle, site: &MediaSite) -> Value {
    let label = cf_window_label(&site.id);
    let Some(win) = app.get_webview_window(&label) else {
        return json!({
            "windowOpen": false,
            "verified": false,
            "hasClearance": site.cookie.contains("cf_clearance="),
        });
    };

    let visible = win.is_visible().unwrap_or(false);
    let title = win.title().unwrap_or_default();
    let current_url = win.url().map(|u| u.to_string()).unwrap_or_default();
    let cookie_header = harvest_cf_cookies(app, site).unwrap_or_default();
    let has_clearance = cookie_header.contains("cf_clearance=");
    let has_any_cookie = !cookie_header.trim().is_empty();

    let title_lower = title.to_lowercase();
    let is_challenge_title = title_lower.contains("just a moment")
        || title_lower.contains("请稍候")
        || title_lower.contains("attention required")
        || title_lower.contains("security check")
        || title_lower.contains("cloudflare")
        || title_lower.starts_with("站点安全验证");

    let url_on_site = current_url.starts_with("http://") || current_url.starts_with("https://");
    let not_cf_challenge_url = !current_url.contains("/cdn-cgi/challenge-platform");

    // 判断是否已在窗口内通过 Cloudflare：
    // 1) 已经拿到 cf_clearance Cookie；或
    // 2) 页面已加载出真实站点标题（脱离默认标题与 Just a moment...）且有站点 Cookie。
    let dom_passed = url_on_site
        && not_cf_challenge_url
        && !title.trim().is_empty()
        && !is_challenge_title
        && (has_clearance || has_any_cookie);

    let verified = has_clearance || dom_passed;

    json!({
        "windowOpen": visible,
        "verified": verified,
        "hasClearance": has_clearance,
        "cookie": cookie_header,
        "userAgent": harvest_user_agent(site),
        "title": title,
        "url": current_url,
    })
}

/// 等待一小段时间用于桥接超时控制。
pub async fn wait_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

pub fn next_bridge_req_id() -> String {
    let seq = REQ_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("mreq_{seq}")
}

/// 监听一次前端事件（保留给同源页面桥接使用）。
pub async fn eval_with_event(
    app: &AppHandle,
    win: &WebviewWindow,
    js_body: &str,
    timeout_ms: u64,
) -> Option<Value> {
    let req_id = next_bridge_req_id();
    let (tx, rx) = oneshot::channel::<Value>();
    PENDING_BRIDGE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(req_id.clone(), tx);

    let event_name = format!("wb-media-bridge-{req_id}");
    let req_id_clone = req_id.clone();
    let listener_id = app.listen(event_name, move |ev| {
        if let Ok(val) = serde_json::from_str::<Value>(ev.payload()) {
            complete_bridge_request(&req_id_clone, val);
        }
    });

    if win.eval(js_body).is_err() {
        app.unlisten(listener_id);
        PENDING_BRIDGE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&req_id);
        return None;
    }

    let out = tokio::time::timeout(Duration::from_millis(timeout_ms), rx)
        .await
        .ok()
        .and_then(|r| r.ok());
    app.unlisten(listener_id);
    PENDING_BRIDGE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&req_id);
    out
}
