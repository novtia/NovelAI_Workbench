use super::domain::{AppSettings, SETTINGS_ID};
use super::schema::{defaults, has_section, normalize, section_names, spec_of};
use crate::kernel::blobs::BlobStore;
use crate::kernel::bus::Kernel;
use crate::kernel::{DomainError, Res};
use rusqlite::params;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub struct SettingsService {
    k: Arc<Kernel>,
    cache: Mutex<Option<(Value, i64)>>,
}

impl SettingsService {
    pub fn new(k: Arc<Kernel>) -> Self {
        SettingsService { k, cache: Mutex::new(None) }
    }

    fn load(&self) -> Res<(Value, i64)> {
        let conn = self.k.store.connect()?;
        let row: Option<(String, i64)> = conn
            .query_row(
                "SELECT data_json, version FROM projections_settings WHERE id=?1",
                params![SETTINGS_ID],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        match row {
            None => Ok((defaults(), 0)),
            Some((json_text, version)) => match serde_json::from_str::<Value>(&json_text) {
                Ok(v) => Ok((normalize(&v), version)),
                Err(_) => Ok((defaults(), 0)),
            },
        }
    }

    /// 内存缓存的完整设置（worker、缩略图等后台代码读取，不会每次查库）。
    pub fn get(&self) -> Value {
        let mut guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(self.load().unwrap_or_else(|_| (defaults(), 0)));
        }
        guard.as_ref().map(|(v, _)| v.clone()).unwrap_or_else(defaults)
    }

    pub fn section(&self, name: &str) -> Value {
        match self.get().get(name) {
            Some(v) if !v.as_object().map(|o| o.is_empty()).unwrap_or(true) => v.clone(),
            _ => defaults().get(name).cloned().unwrap_or_else(|| json!({})),
        }
    }

    pub fn value(&self, section: &str, key: &str) -> Value {
        self.section(section)
            .get(key)
            .cloned()
            .unwrap_or_else(|| spec_of(section, key).map(|s| s.default.clone()).unwrap_or(Value::Null))
    }

    pub fn value_f64(&self, section: &str, key: &str, fallback: f64) -> f64 {
        crate::util::to_float(&self.value(section, key)).unwrap_or(fallback)
    }

    pub fn value_i64(&self, section: &str, key: &str, fallback: i64) -> i64 {
        crate::util::to_int(&self.value(section, key)).unwrap_or(fallback)
    }

    pub fn value_bool(&self, section: &str, key: &str, fallback: bool) -> bool {
        self.value(section, key).as_bool().unwrap_or(fallback)
    }

    pub fn public(&self) -> Value {
        let settings = self.get();
        let version = self.cache.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(_, v)| *v).unwrap_or(0);
        json!({"settings": settings, "version": version})
    }

    /// 事件库被整体替换（导入数据库）后，丢掉内存缓存并重新读取。
    pub fn reload(&self) -> Res<Value> {
        self.refresh()
    }

    fn refresh(&self) -> Res<Value> {
        let loaded = self.load()?;
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(loaded);
        Ok(self.public())
    }

    pub fn update(&self, patch: &Value) -> Res<Value> {
        if !patch.is_object() {
            return Err(DomainError::bad("参数格式错误"));
        }
        let mut agg: AppSettings = self.k.load(SETTINGS_ID)?;
        if agg.update(patch) {
            self.k.commit(&mut agg, None)?;
        }
        self.refresh()
    }

    pub fn reset(&self, section: Option<&str>) -> Res<Value> {
        if let Some(s) = section {
            if !has_section(s) {
                return Err(DomainError::bad("未知的设置分区"));
            }
        }
        let mut agg: AppSettings = self.k.load(SETTINGS_ID)?;
        if agg.reset(section) {
            self.k.commit(&mut agg, None)?;
        }
        self.refresh()
    }

    /// 导入设置：整体替换为给定内容（缺失的项回到默认）。
    pub fn replace(&self, data: &Value) -> Res<Value> {
        if !data.is_object() {
            return Err(DomainError::bad("设置文件格式错误"));
        }
        let mut agg: AppSettings = self.k.load(SETTINGS_ID)?;
        let mut changed = agg.reset(None);
        changed = agg.update(&normalize(data)) || changed;
        if changed {
            self.k.commit(&mut agg, None)?;
        }
        self.refresh()
    }

    pub fn system_info(&self, data_dir: &Path, blobs: &BlobStore) -> Res<Value> {
        let db = data_dir.join("events.sqlite");
        let mut size: u64 = 0;
        for suffix in ["", "-wal", "-shm"] {
            let path = format!("{}{suffix}", db.to_string_lossy());
            if let Ok(meta) = std::fs::metadata(&path) {
                if meta.is_file() {
                    size += meta.len();
                }
            }
        }
        let (mut blob_count, mut blob_bytes) = (0u64, 0u64);
        for digest in blobs.iter_hashes() {
            if let Ok(meta) = std::fs::metadata(blobs.path_for(&digest)) {
                blob_bytes += meta.len();
                blob_count += 1;
            }
        }
        let conn = self.k.store.connect()?;
        let count = |sql: &str| -> Res<i64> { Ok(conn.query_row(sql, [], |r| r.get(0))?) };
        Ok(json!({
            "dataDir": data_dir.to_string_lossy(),
            "dbBytes": size,
            "events": count("SELECT COUNT(*) FROM events")?,
            "artworks": count("SELECT COUNT(*) FROM projections_artworks WHERE deleted=0")?,
            "albums": count("SELECT COUNT(*) FROM projections_albums WHERE deleted=0")?,
            "blobCount": blob_count,
            "blobBytes": blob_bytes,
            "sections": section_names(),
        }))
    }
}
