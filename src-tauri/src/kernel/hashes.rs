use crate::pyjson::canonical_json;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

pub fn sha256_bytes(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex_lower(&h.finalize())
}

pub fn sha256_text(text: &str) -> String {
    sha256_bytes(text.as_bytes())
}

pub fn event_hash(prev_hash: &str, body: &Value) -> String {
    sha256_text(&format!("{prev_hash}{}", canonical_json(body)))
}

pub fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

/// 64 位小写十六进制。
pub fn is_hash64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
