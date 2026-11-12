//! 多账号 / 多渠道：每个账号有自己的渠道（官方 / 自建网关）、Token，
//! 以及「用不用免费额度」「用不用点数」两个开关。明文只存在本机 `secrets/accounts.json`，
//! 不进事件库和备份。
//!
//! 老版本只有一个 `nai.token` 文件加一个全局网关地址：`accounts.json` 还不存在时，
//! 把它们当成一个「默认账号」读出来，第一次保存时再落到新文件里。

use super::nai_client::TokenVault;
use super::nai_payload::{token_hint, IMAGE_API};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

pub const CHANNEL_OFFICIAL: &str = "official";
pub const CHANNEL_GATEWAY: &str = "gateway";

fn on() -> bool {
    true
}

fn official() -> String {
    CHANNEL_OFFICIAL.into()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// official = 官方 image.novelai.net；gateway = 自建网关
    #[serde(default = "official")]
    pub channel: String,
    #[serde(default)]
    pub gateway_url: String,
    #[serde(default)]
    pub token: String,
    /// 总开关：关掉就完全不参与生图
    #[serde(default = "on")]
    pub enabled: bool,
    /// 允许这个账号消耗 Opus 免费额度（小图、≤28 步的那部分）
    #[serde(default = "on")]
    pub use_free: bool,
    /// 允许这个账号消耗点数（Anlas）
    #[serde(default = "on")]
    pub use_points: bool,
}

/// 网关地址；空串或非 http(s) 地址都回到官方地址。
pub fn normalize_base(raw: &str) -> String {
    let raw = raw.trim().trim_end_matches('/').to_string();
    let lower = raw.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        raw
    } else {
        IMAGE_API.to_string()
    }
}

impl Account {
    pub fn base_url(&self) -> String {
        if self.channel == CHANNEL_GATEWAY {
            normalize_base(&self.gateway_url)
        } else {
            IMAGE_API.to_string()
        }
    }

    /// 开着、并且有 Token，才有资格被选中。
    pub fn usable(&self) -> bool {
        self.enabled && !self.token.trim().is_empty()
    }

    /// 给前端看的版本：不带明文 Token。
    pub fn public(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "channel": self.channel,
            "gatewayUrl": self.gateway_url,
            "enabled": self.enabled,
            "useFree": self.use_free,
            "usePoints": self.use_points,
            "configured": !self.token.trim().is_empty(),
            "hint": if self.token.trim().is_empty() { String::new() } else { token_hint(&self.token) },
        })
    }
}

type StringProvider = Arc<dyn Fn() -> String + Send + Sync>;

pub struct AccountStore {
    path: PathBuf,
    vault: Arc<TokenVault>,
    legacy_gateway: RwLock<Option<StringProvider>>,
    write_lock: Mutex<()>,
}

fn short_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..10].to_string()
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(|s| s.trim().to_string())
}

impl AccountStore {
    pub fn new(path: PathBuf, vault: Arc<TokenVault>) -> Self {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        AccountStore {
            path,
            vault,
            legacy_gateway: RwLock::new(None),
            write_lock: Mutex::new(()),
        }
    }

    /// 老版本的全局网关地址，迁移成默认账号时用。
    pub fn set_legacy_gateway(&self, p: StringProvider) {
        *self
            .legacy_gateway
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(p);
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn legacy_account(&self) -> Option<Account> {
        let token = self.vault.load();
        if token.is_empty() {
            return None;
        }
        let url = self
            .legacy_gateway
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|p| p())
            .unwrap_or_default();
        let url = url.trim().to_string();
        let gateway = !url.is_empty() && normalize_base(&url) != IMAGE_API;
        Some(Account {
            id: "default".into(),
            name: "默认账号".into(),
            channel: if gateway { CHANNEL_GATEWAY } else { CHANNEL_OFFICIAL }.into(),
            gateway_url: if gateway { url } else { String::new() },
            token,
            enabled: true,
            use_free: true,
            use_points: true,
        })
    }

    pub fn list(&self) -> Vec<Account> {
        if let Ok(text) = std::fs::read_to_string(&self.path) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(arr) = v.get("accounts") {
                    if let Ok(list) = serde_json::from_value::<Vec<Account>>(arr.clone()) {
                        return list;
                    }
                }
            }
        }
        self.legacy_account().into_iter().collect()
    }

    pub fn has_usable(&self) -> bool {
        self.list().iter().any(Account::usable)
    }

    fn write_all(&self, list: &[Account]) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&json!({"accounts": list}))
            .map_err(|e| format!("无法序列化账号：{e}"))?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("无法创建目录 {}：{e}", parent.display()))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, &text)
            .map_err(|e| format!("无法写入账号文件 {}：{e}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path)
            .map_err(|e| format!("无法保存账号文件 {}：{e}", self.path.display()))?;
        match std::fs::read_to_string(&self.path) {
            Ok(back) if back == text => Ok(()),
            _ => Err(format!("账号文件写入后校验失败：{}", self.path.display())),
        }
    }

    /// 新增或修改。`id` 为空是新增；patch 里没出现的字段保持原样，
    /// `token` 为空串也保持原样（想删 Token 就删账号）。
    pub fn upsert(&self, id: &str, patch: &Value) -> Result<Account, String> {
        let _g = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = self.list();
        let idx = if id.is_empty() {
            None
        } else {
            Some(
                list.iter()
                    .position(|a| a.id == id)
                    .ok_or_else(|| "账号不存在".to_string())?,
            )
        };
        let mut acct = match idx {
            Some(i) => list[i].clone(),
            None => Account {
                id: short_id(),
                name: String::new(),
                channel: official(),
                gateway_url: String::new(),
                token: String::new(),
                enabled: true,
                use_free: true,
                use_points: true,
            },
        };
        if let Some(name) = patch.get("name").and_then(str_of) {
            acct.name = name.chars().take(40).collect();
        }
        if let Some(ch) = patch.get("channel").and_then(str_of) {
            if ch != CHANNEL_OFFICIAL && ch != CHANNEL_GATEWAY {
                return Err("渠道只能是 official 或 gateway".into());
            }
            acct.channel = ch;
        }
        if let Some(url) = patch.get("gatewayUrl").and_then(str_of) {
            acct.gateway_url = url.chars().take(200).collect();
        }
        if let Some(t) = patch.get("token").and_then(str_of) {
            if !t.is_empty() {
                acct.token = t;
            }
        }
        if let Some(b) = patch.get("enabled").and_then(Value::as_bool) {
            acct.enabled = b;
        }
        if let Some(b) = patch.get("useFree").and_then(Value::as_bool) {
            acct.use_free = b;
        }
        if let Some(b) = patch.get("usePoints").and_then(Value::as_bool) {
            acct.use_points = b;
        }
        if acct.channel == CHANNEL_GATEWAY {
            let g = acct.gateway_url.trim().to_lowercase();
            if !(g.starts_with("http://") || g.starts_with("https://")) {
                return Err("自建网关需要填写 http(s):// 开头的网关地址".into());
            }
        }
        if acct.name.trim().is_empty() {
            acct.name = format!("账号 {}", list.len() + 1);
        }
        match idx {
            Some(i) => list[i] = acct.clone(),
            None => list.push(acct.clone()),
        }
        self.write_all(&list)?;
        Ok(acct)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let _g = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = self.list();
        let before = list.len();
        list.retain(|a| a.id != id);
        if list.len() == before {
            return Err("账号不存在".into());
        }
        self.write_all(&list)
    }

    /// 按给定 id 顺序重排（顺序即优先级）；没提到的账号排在后面。
    pub fn reorder(&self, ids: &[String]) -> Result<(), String> {
        let _g = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = self.list();
        list.sort_by_key(|a| ids.iter().position(|i| *i == a.id).unwrap_or(usize::MAX));
        self.write_all(&list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &Path) -> AccountStore {
        AccountStore::new(
            dir.join("accounts.json"),
            Arc::new(TokenVault::new(dir.join("nai.token"))),
        )
    }

    #[test]
    fn legacy_token_becomes_default_account() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        assert!(s.list().is_empty());
        s.vault.save("pst-legacy-token").unwrap();
        let list = s.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "default");
        assert!(list[0].usable());
    }

    #[test]
    fn upsert_remove_and_reorder() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let a = s
            .upsert("", &json!({"name": "主号", "token": "pst-aaaaaaaa"}))
            .unwrap();
        let b = s
            .upsert(
                "",
                &json!({"name": "网关", "channel": "gateway", "gatewayUrl": "https://moyan.ink/", "token": "sk-bbbbbbbb", "useFree": false}),
            )
            .unwrap();
        assert_eq!(b.base_url(), "https://moyan.ink");
        assert!(!b.use_free && b.use_points);
        s.reorder(&[b.id.clone(), a.id.clone()]).unwrap();
        assert_eq!(s.list()[0].id, b.id);
        // 空 token 不会覆盖旧的
        let a2 = s.upsert(&a.id, &json!({"token": "", "enabled": false})).unwrap();
        assert_eq!(a2.token, "pst-aaaaaaaa");
        assert!(!a2.usable());
        assert!(s
            .upsert("", &json!({"channel": "gateway", "token": "x"}))
            .is_err());
        s.remove(&a.id).unwrap();
        assert_eq!(s.list().len(), 1);
        assert!(s.remove("nope").is_err());
    }
}
