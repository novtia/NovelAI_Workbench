//! 统一日志模块：支持按模块命名（`ScopedLogger`）、运行时开关控制、环形缓冲与实时事件推送。

use crate::kernel::clock::now_ms;
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

pub const DEFAULT_CAPACITY: usize = 500;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LogRecord {
    pub seq: u64,
    pub at: i64,
    pub level: LogLevel,
    pub scope: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

pub type LogEmitter = Arc<dyn Fn(LogRecord) + Send + Sync>;

pub struct AppLogger {
    enabled: AtomicBool,
    seq: AtomicU64,
    capacity: usize,
    records: Mutex<VecDeque<LogRecord>>,
    emitter: RwLock<Option<LogEmitter>>,
}

impl AppLogger {
    pub fn new(enabled: bool) -> Arc<Self> {
        Self::with_capacity(enabled, DEFAULT_CAPACITY)
    }

    pub fn with_capacity(enabled: bool, capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            enabled: AtomicBool::new(enabled),
            seq: AtomicU64::new(0),
            capacity: capacity.max(1),
            records: Mutex::new(VecDeque::with_capacity(capacity.min(64))),
            emitter: RwLock::new(None),
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn set_emitter(&self, emitter: LogEmitter) {
        *self.emitter.write().unwrap_or_else(|e| e.into_inner()) = Some(emitter);
    }

    pub fn scoped(self: &Arc<Self>, scope: impl Into<String>) -> ScopedLogger {
        ScopedLogger {
            logger: Arc::clone(self),
            scope: scope.into(),
        }
    }

    pub fn log(&self, level: LogLevel, scope: &str, event: &str, detail: Option<Value>) {
        let enabled = self.is_enabled();
        if !enabled && matches!(level, LogLevel::Debug | LogLevel::Info) {
            return;
        }
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let record = LogRecord {
            seq,
            at: now_ms(),
            level,
            scope: scope.to_string(),
            event: event.to_string(),
            detail,
        };
        match &record.detail {
            Some(d) => eprintln!("[{}][{}] {} {}", level.as_str(), scope, event, d),
            None => eprintln!("[{}][{}] {}", level.as_str(), scope, event),
        }
        {
            let mut guard = self.records.lock().unwrap_or_else(|e| e.into_inner());
            if guard.len() >= self.capacity {
                guard.pop_front();
            }
            guard.push_back(record.clone());
        }
        if enabled {
            let emitter = self.emitter.read().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(emit) = emitter {
                emit(record);
            }
        }
    }

    pub fn snapshot(&self) -> Vec<LogRecord> {
        self.records
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    pub fn clear(&self) {
        self.records
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

#[derive(Clone)]
pub struct ScopedLogger {
    logger: Arc<AppLogger>,
    scope: String,
}

impl ScopedLogger {
    pub fn is_enabled(&self) -> bool {
        self.logger.is_enabled()
    }

    pub fn debug(&self, event: &str, detail: Value) {
        if !self.logger.is_enabled() {
            return;
        }
        self.logger
            .log(LogLevel::Debug, &self.scope, event, Some(detail));
    }

    pub fn info(&self, event: &str, detail: Value) {
        if !self.logger.is_enabled() {
            return;
        }
        self.logger
            .log(LogLevel::Info, &self.scope, event, Some(detail));
    }

    pub fn warn(&self, event: &str, detail: Value) {
        self.logger
            .log(LogLevel::Warn, &self.scope, event, Some(detail));
    }

    pub fn error(&self, event: &str, detail: Value) {
        self.logger
            .log(LogLevel::Error, &self.scope, event, Some(detail));
    }

    pub fn msg(&self, level: LogLevel, event: &str) {
        self.logger.log(level, &self.scope, event, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn skips_debug_and_info_when_disabled_and_captures_when_enabled() {
        let logger = AppLogger::with_capacity(false, 10);
        let emitted = Arc::new(Mutex::new(Vec::<u64>::new()));
        let emitted_clone = Arc::clone(&emitted);
        logger.set_emitter(Arc::new(move |rec| {
            emitted_clone.lock().unwrap().push(rec.seq);
        }));

        let scoped = logger.scoped("generation::worker");
        scoped.debug("skip.debug", json!({"n": 1}));
        scoped.info("skip.info", json!({"n": 2}));
        assert!(logger.snapshot().is_empty());
        assert!(emitted.lock().unwrap().is_empty());

        // Warn 即使关闭也进缓冲，但不主动推送
        scoped.warn("keep.warn", json!({"code": 429}));
        assert_eq!(logger.snapshot().len(), 1);
        assert!(emitted.lock().unwrap().is_empty());

        logger.set_enabled(true);
        scoped.debug("emit.debug", json!({"ok": true}));
        let snap = logger.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[1].scope, "generation::worker");
        assert_eq!(snap[1].event, "emit.debug");
        assert_eq!(emitted.lock().unwrap().len(), 1);
    }

    #[test]
    fn ring_buffer_evicts_oldest_and_clear_empties() {
        let logger = AppLogger::with_capacity(true, 3);
        let scoped = logger.scoped("test");
        for i in 1..=5 {
            scoped.info("step", json!({"i": i}));
        }
        let snap = logger.snapshot();
        assert_eq!(snap.len(), 3);
        assert_eq!(snap[0].detail, Some(json!({"i": 3})));
        assert_eq!(snap[2].detail, Some(json!({"i": 5})));

        logger.clear();
        assert!(logger.snapshot().is_empty());
    }
}
