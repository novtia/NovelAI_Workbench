use serde::Serialize;
use std::fmt;

/// 领域错误：`message` 直接展示给用户，`status` 沿用原 HTTP 状态码语义（404 / 409 / 413 ...）。
#[derive(Debug, Clone, Serialize)]
pub struct DomainError {
    #[serde(rename = "error")]
    pub message: String,
    pub status: u16,
}

pub type Res<T> = Result<T, DomainError>;

impl DomainError {
    pub fn new(message: impl Into<String>, status: u16) -> Self {
        Self { message: message.into(), status }
    }

    /// 默认 400。
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(message, 400)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(message, 404)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(message, 409)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(message, 500)
    }
}

impl fmt::Display for DomainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for DomainError {}

impl From<rusqlite::Error> for DomainError {
    fn from(e: rusqlite::Error) -> Self {
        DomainError::internal(format!("数据库错误：{e}"))
    }
}

impl From<std::io::Error> for DomainError {
    fn from(e: std::io::Error) -> Self {
        DomainError::internal(format!("文件错误：{e}"))
    }
}

impl From<serde_json::Error> for DomainError {
    fn from(e: serde_json::Error) -> Self {
        DomainError::internal(format!("JSON 错误：{e}"))
    }
}
