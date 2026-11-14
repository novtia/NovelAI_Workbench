//! 媒体站点领域模型：内置站点（Danbooru、AI TAG）与自定义网页卡片（webpage）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const KIND_DANBOORU: &str = "danbooru";
pub const KIND_AITAG: &str = "aitag";
pub const KIND_WEBPAGE: &str = "webpage";

pub const SITE_DANBOORU_ID: &str = "danbooru";
pub const SITE_AITAG_ID: &str = "aitag";

pub fn is_valid_kind(kind: &str) -> bool {
    matches!(kind, KIND_DANBOORU | KIND_AITAG | KIND_WEBPAGE)
}

pub fn is_feed_kind(kind: &str) -> bool {
    matches!(kind, KIND_DANBOORU | KIND_AITAG)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaSite {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub default_query: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub cookie: String,
    #[serde(default)]
    pub user_agent: String,
}

impl MediaSite {
    pub fn has_cf_clearance(&self) -> bool {
        self.cookie.contains("cf_clearance=") || !self.cookie.trim().is_empty()
    }

    pub fn public(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "baseUrl": self.base_url,
            "builtin": self.builtin,
            "defaultQuery": self.default_query,
            "note": self.note,
            "hasCookie": !self.cookie.trim().is_empty(),
            "hasClearance": self.cookie.contains("cf_clearance="),
            "hasUserAgent": !self.user_agent.trim().is_empty(),
        })
    }
}

pub fn normalize_site_url(raw: &str, fallback: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let lower = trimmed.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

pub fn builtin_sites() -> Vec<MediaSite> {
    vec![
        MediaSite {
            id: SITE_DANBOORU_ID.into(),
            name: "Danbooru".into(),
            kind: KIND_DANBOORU.into(),
            base_url: "https://danbooru.donmai.us".into(),
            builtin: true,
            default_query: String::new(),
            note: "海量二次元插画与标准画师/角色 Tag 图库，内置独立画师库（自动抓取画师代表图与作品数）".into(),
            cookie: String::new(),
            user_agent: String::new(),
        },
        MediaSite {
            id: SITE_AITAG_ID.into(),
            name: "AI TAG".into(),
            kind: KIND_AITAG.into(),
            base_url: "https://aitag.win".into(),
            builtin: true,
            default_query: String::new(),
            note: "AI 绘画咒语图库（NovelAI / SD / ComfyUI），支持按作品与元数据咒语检索及完整详细页".into(),
            cookie: String::new(),
            user_agent: String::new(),
        },
    ]
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaTagItem {
    pub name: String,
    pub translated: String,
}

/// Normalized media post returned to the frontend for local layout rendering.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaPost {
    pub id: String,
    pub site_id: String,
    pub site_kind: String,
    pub title: String,
    #[serde(default)]
    pub caption: String,
    pub preview_url: String,
    pub sample_url: String,
    pub file_url: String,
    pub source_url: String,
    pub width: i64,
    pub height: i64,
    pub artists: Vec<String>,
    pub tags_general: Vec<String>,
    pub tags_character: Vec<String>,
    pub tags_copyright: Vec<String>,
    pub tags_meta: Vec<String>,
    #[serde(default)]
    pub tag_translations: Vec<MediaTagItem>,
    pub prompt: String,
    pub negative_prompt: String,
    pub ai_type: String,
    pub model: String,
    pub author_name: String,
    pub author_id: String,
    pub created_at: String,
    pub score: i64,
    pub fav_count: i64,
    pub rating: String,
    pub image_count: i64,
    pub pages: Vec<MediaPostPage>,
    pub raw_params: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaPostPage {
    pub index: usize,
    pub preview_url: String,
    pub file_url: String,
    pub model: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub raw_json: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaTagSuggestion {
    pub name: String,
    pub label: String,
    /// "artist" | "character" | "copyright" | "general" | "meta"
    pub category: String,
    pub post_count: i64,
}

/// Danbooru 独立画师页条目：对应 `/artists.json`，包含画师名、别名（Other Names）、作品数（postCount）、更新时间等。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaArtist {
    pub id: String,
    pub name: String,
    pub other_names: Vec<String>,
    pub group_name: String,
    pub post_count: i64,
    pub is_deleted: bool,
    pub updated_at: String,
    pub urls: Vec<String>,
    #[serde(default)]
    pub preview_post: Option<MediaPost>,
}
