//! 图片地址：事件和投影里一律保存旧的 `/api/...` 形式（Python 版也能读），
//! 只在返回给前端时换成自定义协议 `wb` 的地址。

/// Windows（WebView2）上自定义协议要写成 `http://<scheme>.localhost`，其它平台是 `<scheme>://localhost`。
pub fn base() -> &'static str {
    if cfg!(windows) {
        "http://wb.localhost"
    } else {
        "wb://localhost"
    }
}

pub fn rewrite_legacy(s: &str) -> Option<String> {
    if let Some(rest) = s.strip_prefix("/api/blobs/") {
        return Some(format!("{}/blobs/{rest}", base()));
    }
    if let Some(rest) = s.strip_prefix("/api/items/") {
        return Some(format!("{}/items/{rest}", base()));
    }
    if let Some(rest) = s.strip_prefix("/api/nai/jobs/") {
        return Some(format!("{}/jobs/{rest}", base()));
    }
    None
}

pub fn blob_path(digest: &str) -> String {
    format!("/api/blobs/{digest}")
}

pub fn preview_path(job_id: &str, sample: i64) -> String {
    format!("/api/nai/jobs/{job_id}/preview?sample={sample}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_known_prefixes_only() {
        assert!(rewrite_legacy("/api/blobs/abc").unwrap().ends_with("/blobs/abc"));
        assert!(rewrite_legacy("/api/nai/jobs/j1/preview?sample=2").unwrap().ends_with("/jobs/j1/preview?sample=2"));
        assert!(rewrite_legacy("/api/items/x/image").unwrap().ends_with("/items/x/image"));
        assert!(rewrite_legacy("hello").is_none());
    }
}
