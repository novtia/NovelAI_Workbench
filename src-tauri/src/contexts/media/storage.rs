//! 媒体导航站点存储：保存在 `secrets/media_sites.json`，
//! 确保内置站点（`danbooru`、`aitag`）始终存在且排在前面，自定义网页卡片（`webpage`）支持增删改与排序。

use super::domain::{
    builtin_sites, is_valid_kind, normalize_site_url, MediaSite, KIND_WEBPAGE, SITE_AITAG_ID,
    SITE_DANBOORU_ID,
};
use crate::kernel::{DomainError, Res};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct MediaSiteStore {
    path: PathBuf,
    write_lock: Mutex<()>,
}

fn short_id() -> String {
    format!("web_{}", &uuid::Uuid::new_v4().simple().to_string()[..10])
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(|s| s.trim().to_string())
}

impl MediaSiteStore {
    pub fn new(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        MediaSiteStore {
            path,
            write_lock: Mutex::new(()),
        }
    }

    fn read_raw(&self) -> Vec<MediaSite> {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        serde_json::from_str::<Vec<MediaSite>>(&text).unwrap_or_default()
    }

    pub fn list(&self) -> Vec<MediaSite> {
        let raw = self.read_raw();
        let mut out: Vec<MediaSite> = Vec::new();

        for mut builtin in builtin_sites() {
            if let Some(saved) = raw.iter().find(|s| s.id == builtin.id) {
                if !saved.name.trim().is_empty() {
                    builtin.name = saved.name.trim().to_string();
                }
                if !saved.base_url.trim().is_empty() {
                    builtin.base_url = normalize_site_url(&saved.base_url, &builtin.base_url);
                }
                builtin.default_query = saved.default_query.trim().to_string();
                if !saved.note.trim().is_empty() {
                    builtin.note = saved.note.trim().to_string();
                }
                builtin.cookie = saved.cookie.trim().to_string();
                builtin.user_agent = saved.user_agent.trim().to_string();
            }
            out.push(builtin);
        }

        for mut item in raw {
            if item.id == SITE_DANBOORU_ID || item.id == SITE_AITAG_ID {
                continue;
            }
            item.builtin = false;
            if !is_valid_kind(&item.kind) {
                item.kind = KIND_WEBPAGE.into();
            }
            item.base_url = normalize_site_url(&item.base_url, "");
            if !item.base_url.is_empty() {
                out.push(item);
            }
        }

        out
    }

    pub fn list_public(&self) -> Vec<Value> {
        self.list().iter().map(MediaSite::public).collect()
    }

    pub fn get(&self, id: &str) -> Option<MediaSite> {
        let id = id.trim();
        self.list().into_iter().find(|s| s.id == id)
    }

    fn write_all(&self, list: &[MediaSite]) -> Res<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                DomainError::internal(format!("无法创建目录 {}：{e}", parent.display()))
            })?;
        }
        let body = serde_json::to_string_pretty(list)
            .map_err(|e| DomainError::internal(format!("序列化媒体站点失败：{e}")))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, &body).map_err(|e| {
            DomainError::internal(format!("写入媒体站点文件失败 {}：{e}", tmp.display()))
        })?;
        std::fs::rename(&tmp, &self.path).map_err(|e| {
            DomainError::internal(format!("保存媒体站点文件失败 {}：{e}", self.path.display()))
        })?;
        Ok(())
    }

    pub fn save(&self, id: &str, patch: &Value) -> Res<MediaSite> {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = self.list();
        let id = id.trim();

        if !id.is_empty() {
            if let Some(site) = list.iter_mut().find(|s| s.id == id) {
                if let Some(name) = patch.get("name").and_then(str_of) {
                    if !name.is_empty() {
                        site.name = name;
                    }
                }
                if let Some(base_url) = patch.get("baseUrl").and_then(str_of) {
                    let normalized = normalize_site_url(&base_url, &site.base_url);
                    if !normalized.is_empty() {
                        site.base_url = normalized;
                    }
                }
                if let Some(kind) = patch.get("kind").and_then(str_of) {
                    if !site.builtin && is_valid_kind(&kind) {
                        site.kind = kind;
                    }
                }
                if let Some(q) = patch.get("defaultQuery").and_then(str_of) {
                    site.default_query = q;
                }
                if let Some(note) = patch.get("note").and_then(str_of) {
                    site.note = note;
                }
                if let Some(cookie) = patch.get("cookie").and_then(str_of) {
                    site.cookie = cookie;
                }
                if let Some(ua) = patch.get("userAgent").and_then(str_of) {
                    site.user_agent = ua;
                }
                let saved = site.clone();
                self.write_all(&list)?;
                return Ok(saved);
            }
        }

        let raw_url = patch
            .get("baseUrl")
            .and_then(str_of)
            .unwrap_or_default();
        let base_url = normalize_site_url(&raw_url, "");
        if base_url.is_empty() {
            return Err(DomainError::bad("请填写页面网址（URL）"));
        }

        let name = patch
            .get("name")
            .and_then(str_of)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                base_url
                    .trim_start_matches("https://")
                    .trim_start_matches("http://")
                    .split('/')
                    .next()
                    .unwrap_or("自定义网页")
                    .to_string()
            });

        let kind = patch
            .get("kind")
            .and_then(str_of)
            .filter(|k| is_valid_kind(k))
            .unwrap_or_else(|| KIND_WEBPAGE.to_string());

        let created = MediaSite {
            id: short_id(),
            name,
            kind,
            base_url,
            builtin: false,
            default_query: patch
                .get("defaultQuery")
                .and_then(str_of)
                .unwrap_or_default(),
            note: patch.get("note").and_then(str_of).unwrap_or_default(),
            cookie: patch.get("cookie").and_then(str_of).unwrap_or_default(),
            user_agent: patch.get("userAgent").and_then(str_of).unwrap_or_default(),
        };
        list.push(created.clone());
        self.write_all(&list)?;
        Ok(created)
    }

    pub fn update_cf_credentials(
        &self,
        id: &str,
        cookie: Option<String>,
        user_agent: Option<String>,
    ) -> Res<MediaSite> {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = self.list();
        let site = list
            .iter_mut()
            .find(|s| s.id == id.trim())
            .ok_or_else(|| DomainError::not_found("媒体站点不存在"))?;
        if let Some(c) = cookie {
            let trimmed = c.trim();
            if !trimmed.is_empty() {
                site.cookie = trimmed.to_string();
            }
        }
        if let Some(ua) = user_agent {
            let trimmed = ua.trim();
            if !trimmed.is_empty() {
                site.user_agent = trimmed.to_string();
            }
        }
        let saved = site.clone();
        self.write_all(&list)?;
        Ok(saved)
    }

    pub fn clear_cf_credentials(&self, id: &str) -> Res<MediaSite> {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = self.list();
        let site = list
            .iter_mut()
            .find(|s| s.id == id.trim())
            .ok_or_else(|| DomainError::not_found("媒体站点不存在"))?;
        site.cookie.clear();
        site.user_agent.clear();
        let saved = site.clone();
        self.write_all(&list)?;
        Ok(saved)
    }

    pub fn delete(&self, id: &str) -> Res<()> {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let id = id.trim();
        if id == SITE_DANBOORU_ID || id == SITE_AITAG_ID {
            return Err(DomainError::bad("内置站点不可删除"));
        }
        let mut list = self.list();
        let before = list.len();
        list.retain(|s| s.id != id);
        if list.len() == before {
            return Err(DomainError::not_found("页面不存在"));
        }
        self.write_all(&list)
    }

    pub fn reorder(&self, ids: &[String]) -> Res<Vec<MediaSite>> {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let current = self.list();
        let mut builtins: Vec<MediaSite> = Vec::new();
        let mut customs: Vec<MediaSite> = Vec::new();
        for s in current {
            if s.builtin {
                builtins.push(s);
            } else {
                customs.push(s);
            }
        }

        let mut ordered_customs: Vec<MediaSite> = Vec::new();
        for id in ids {
            if let Some(pos) = customs.iter().position(|s| &s.id == id) {
                ordered_customs.push(customs.remove(pos));
            }
        }
        ordered_customs.extend(customs);

        let mut next = builtins;
        next.extend(ordered_customs);
        self.write_all(&next)?;
        Ok(next)
    }
}
