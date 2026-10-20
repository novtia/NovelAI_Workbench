use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 标准 UUID v4 字符串（带连字符、小写）。
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `uuid4().hex[:n]`
pub fn new_hex(n: usize) -> String {
    uuid::Uuid::new_v4().simple().to_string()[..n].to_string()
}
