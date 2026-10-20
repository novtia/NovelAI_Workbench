use super::clock::{new_id, now_ms};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct NewEvent {
    pub aggregate_id: String,
    pub aggregate_type: String,
    pub version: i64,
    pub event_type: String,
    pub payload: Value,
    pub occurred_at: i64,
    pub event_id: String,
    pub causation_id: Option<String>,
    pub correlation_id: Option<String>,
    pub command_id: Option<String>,
}

impl NewEvent {
    /// 参与哈希的字段，键名全是 snake_case（与 Python 版一致，旧库校验依赖它）。
    pub fn hash_body(&self) -> Value {
        json!({
            "aggregate_id": self.aggregate_id,
            "aggregate_type": self.aggregate_type,
            "causation_id": self.causation_id,
            "command_id": self.command_id,
            "correlation_id": self.correlation_id,
            "event_id": self.event_id,
            "event_type": self.event_type,
            "occurred_at": self.occurred_at,
            "payload": self.payload,
            "version": self.version,
        })
    }
}

#[derive(Debug, Clone)]
pub struct StoredEvent {
    pub global_seq: i64,
    pub event_id: String,
    pub aggregate_id: String,
    pub aggregate_type: String,
    pub version: i64,
    pub event_type: String,
    pub payload: Value,
    pub occurred_at: i64,
    pub causation_id: Option<String>,
    pub correlation_id: Option<String>,
    pub command_id: Option<String>,
    pub prev_hash: String,
    pub event_hash: String,
}

impl StoredEvent {
    pub fn as_json(&self) -> Value {
        json!({
            "globalSeq": self.global_seq,
            "eventId": self.event_id,
            "aggregateId": self.aggregate_id,
            "aggregateType": self.aggregate_type,
            "version": self.version,
            "eventType": self.event_type,
            "payload": self.payload,
            "occurredAt": self.occurred_at,
            "causationId": self.causation_id,
            "correlationId": self.correlation_id,
            "commandId": self.command_id,
            "prevHash": self.prev_hash,
            "eventHash": self.event_hash,
        })
    }
}

/// 聚合的公共部分：id、版本号、待提交事件。
pub struct Core {
    pub id: String,
    pub version: i64,
    pub pending: Vec<NewEvent>,
}

impl Core {
    pub fn new(id: &str) -> Self {
        Core { id: id.to_string(), version: 0, pending: Vec::new() }
    }
}

pub trait Aggregate: Sized {
    const TYPE: &'static str;
    fn create(id: &str) -> Self;
    fn core(&self) -> &Core;
    fn core_mut(&mut self) -> &mut Core;
    /// 按事件类型更新内存状态（对应 Python 的 `_on_<EventType>`）。
    fn on(&mut self, event_type: &str, payload: &Value);

    fn id(&self) -> &str {
        &self.core().id
    }

    fn version(&self) -> i64 {
        self.core().version
    }

    fn apply(&mut self, version: i64, event_type: &str, payload: &Value) {
        self.core_mut().version = version;
        self.on(event_type, payload);
    }

    fn record(&mut self, event_type: &str, payload: Value) {
        self.record_with(event_type, payload, None);
    }

    fn record_with(&mut self, event_type: &str, payload: Value, command_id: Option<&str>) {
        let event = NewEvent {
            aggregate_id: self.core().id.clone(),
            aggregate_type: Self::TYPE.to_string(),
            version: self.core().version + 1,
            event_type: event_type.to_string(),
            payload,
            occurred_at: now_ms(),
            event_id: new_id(),
            causation_id: None,
            correlation_id: None,
            command_id: command_id.map(|s| s.to_string()),
        };
        self.apply(event.version, &event.event_type, &event.payload);
        self.core_mut().pending.push(event);
    }

    fn has_pending(&self) -> bool {
        !self.core().pending.is_empty()
    }
}
