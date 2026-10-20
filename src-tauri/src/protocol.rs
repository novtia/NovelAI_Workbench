//! 自定义协议 `wb`：把图片文件直接交给 WebView，不经过 IPC 序列化。
//!
//! - `/blobs/{hash}`                    内容寻址的图片，永久缓存
//! - `/items/{id}/image`、`/items/{id}/thumb`  图库作品原图 / 缩略图
//! - `/jobs/{id}/preview?sample=N`      生成中的预览，不缓存
//!
//! 响应带 `Access-Control-Allow-Origin: *`：前端要对这些地址 `fetch`（下载）和 `drawImage`（编辑器）。

use crate::app::Services;
use std::borrow::Cow;
use std::sync::Arc;
use tauri::http::{header, Request, Response, StatusCode};

type Body = Cow<'static, [u8]>;

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn json_error(status: u16, message: &str) -> Response<Body> {
    let body = serde_json::json!({"error": message}).to_string();
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Cow::Owned(body.into_bytes()))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..])))
}

/// 和 Python 版 `_blob_response` 一致：看文件头判断类型。
fn sniff(head: &[u8]) -> &'static str {
    if head.len() >= 8 && &head[..8] == b"\x89PNG\r\n\x1a\n" {
        "image/png"
    } else if head.len() >= 2 && head[0] == 0xff && head[1] == 0xd8 {
        "image/jpeg"
    } else if head.len() >= 4 && &head[..4] == b"RIFF" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

fn file_response(req: &Request<Vec<u8>>, path: &std::path::Path, mime: Option<&str>, digest: &str) -> Response<Body> {
    let etag = format!("\"{digest}\"");
    let cache = "public, max-age=31536000, immutable";
    if req.headers().get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag)
            .header(header::CACHE_CONTROL, cache)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Borrowed(&[][..]))
            .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..])));
    }
    let Ok(data) = std::fs::read(path) else {
        return json_error(404, "文件不存在");
    };
    let media = mime.filter(|m| !m.is_empty()).unwrap_or_else(|| sniff(&data[..data.len().min(12)])).to_string();
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, media)
        .header(header::CACHE_CONTROL, cache)
        .header(header::ETAG, etag)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Cow::Owned(data))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..])))
}

fn decode(seg: &str) -> String {
    percent_encoding::percent_decode_str(seg).decode_utf8_lossy().to_string()
}

pub fn handle(svc: &Arc<Services>, req: &Request<Vec<u8>>) -> Response<Body> {
    let path = req.uri().path().to_string();
    let parts: Vec<String> = path.split('/').filter(|p| !p.is_empty()).map(decode).collect();
    let parts: Vec<&str> = parts.iter().map(|s| s.as_str()).collect();
    match parts.as_slice() {
        ["blobs", digest] => {
            let digest = digest.trim().to_lowercase();
            if !is_hash(&digest) {
                return json_error(400, "无效的哈希");
            }
            let p = svc.kernel.blobs.path_for(&digest);
            if !p.is_file() {
                return json_error(404, "文件不存在");
            }
            file_response(req, &p, None, &digest)
        }
        ["items", id, which @ ("image" | "thumb")] => {
            let item = match svc.gallery.get_item(id, false) {
                Ok(Some(item)) => item,
                _ => return json_error(404, "图片不存在"),
            };
            let hash = item["hash"].as_str().unwrap_or("").to_string();
            let (digest, mime) = if *which == "thumb" {
                let t = item["thumbHash"].as_str().filter(|t| !t.is_empty()).unwrap_or(&hash).to_string();
                (t, Some("image/webp".to_string()))
            } else {
                (hash, item["mime"].as_str().map(|m| m.to_string()))
            };
            let p = svc.kernel.blobs.path_for(&digest);
            if !p.is_file() {
                return json_error(404, "文件不存在");
            }
            file_response(req, &p, mime.as_deref(), &digest)
        }
        ["jobs", id, "preview"] => {
            let sample = req
                .uri()
                .query()
                .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("sample=")))
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0);
            let p = svc.generation.preview_path(id, sample);
            match std::fs::read(&p) {
                Ok(data) => Response::builder()
                    .status(200)
                    .header(header::CONTENT_TYPE, "image/png")
                    .header(header::CACHE_CONTROL, "no-store")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(Cow::Owned(data))
                    .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..]))),
                Err(_) => json_error(404, "预览不存在"),
            }
        }
        _ => json_error(404, "未找到"),
    }
}
