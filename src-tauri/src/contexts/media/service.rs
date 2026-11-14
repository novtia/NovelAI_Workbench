//! 媒体导航应用服务：
//! - 管理站点配置（内置 Danbooru / AI TAG + 用户自定义网页卡片 `webpage`）。
//! - 抓取并标准化 Danbooru 与 AI TAG 的作品列表与详情（遇到 Cloudflare 403/503 质询时返回 `CF_CHALLENGE` 标识，触发前端自动弹窗过盾与轮询恢复）。
//! - 提供远程媒体图片代理下载（用于图库收藏夹一键导入与缩略图/原图受保护防盗链加载）。

use super::bridge::{
    harvest_cf_cookies, harvest_user_agent, hide_cf_verify_window, open_cf_verify_window,
    probe_cf_ready, DEFAULT_BROWSER_UA,
};
use super::domain::{
    MediaArtist, MediaPost, MediaPostPage, MediaSite, MediaTagItem, MediaTagSuggestion, KIND_AITAG,
    KIND_DANBOORU, KIND_WEBPAGE, SITE_DANBOORU_ID,
};
use super::storage::MediaSiteStore;
use crate::contexts::gallery::rules::extract_artists;
use crate::contexts::generation::nai_client::{describe_err, NetConfig};
use crate::contexts::settings::application::SettingsService;
use crate::kernel::{DomainError, Res};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::AppHandle;

pub const CF_CHALLENGE_PREFIX: &str = "CF_CHALLENGE:";

const AITAG_SENSITIVE_POLICY: &str = "260902a";
const DEFAULT_AITAG_ASSET_BASE: &str = "https://ai-img.10118899.xyz/";

pub struct MediaService {
    pub store: Arc<MediaSiteStore>,
    settings: Arc<SettingsService>,
    aitag_asset_base: RwLock<String>,
    aitag_work_cache: RwLock<HashMap<String, Value>>,
}

impl MediaService {
    pub fn new(store_path: PathBuf, settings: Arc<SettingsService>) -> Self {
        MediaService {
            store: Arc::new(MediaSiteStore::new(store_path)),
            settings,
            aitag_asset_base: RwLock::new(DEFAULT_AITAG_ASSET_BASE.to_string()),
            aitag_work_cache: RwLock::new(HashMap::new()),
        }
    }

    pub fn net_config(&self) -> NetConfig {
        NetConfig {
            mode: self
                .settings
                .value("network", "proxyMode")
                .as_str()
                .unwrap_or("system")
                .to_string(),
            proxy_url: self
                .settings
                .value("network", "proxyUrl")
                .as_str()
                .unwrap_or("")
                .to_string(),
            connect_timeout: self
                .settings
                .value_f64("network", "connectTimeoutSec", 10.0),
        }
    }

    fn build_client(&self, site: &MediaSite, timeout_sec: u64) -> Res<reqwest::Client> {
        let cfg = self.net_config();
        let ua = if !site.user_agent.trim().is_empty() {
            site.user_agent.trim().to_string()
        } else {
            DEFAULT_BROWSER_UA.to_string()
        };

        let mut builder = reqwest::Client::builder()
            .user_agent(ua)
            .timeout(Duration::from_secs(timeout_sec.max(5)))
            .connect_timeout(Duration::from_secs_f64(
                cfg.connect_timeout.clamp(2.0, 60.0),
            ));

        match cfg.mode.as_str() {
            "none" => {
                builder = builder.no_proxy();
            }
            "custom" => {
                let raw = cfg.proxy_url.trim();
                if !raw.is_empty() {
                    let url = if raw.contains("://") {
                        raw.to_string()
                    } else {
                        format!("http://{raw}")
                    };
                    if let Ok(proxy) = reqwest::Proxy::all(&url) {
                        builder = builder.proxy(proxy);
                    }
                }
            }
            _ => {}
        }

        builder
            .build()
            .map_err(|e| DomainError::internal(format!("创建网络客户端失败：{e}")))
    }

    fn apply_site_headers(
        &self,
        req: reqwest::RequestBuilder,
        site: &MediaSite,
        app: Option<&AppHandle>,
    ) -> reqwest::RequestBuilder {
        let mut cookie = site.cookie.trim().to_string();
        if let Some(handle) = app {
            if let Some(fresh) = harvest_cf_cookies(handle, site) {
                if !fresh.is_empty() {
                    cookie = fresh;
                    let _ = self.store.update_cf_credentials(
                        &site.id,
                        Some(cookie.clone()),
                        Some(harvest_user_agent(site)),
                    );
                }
            }
        }
        let referer = format!("{}/", site.base_url.trim_end_matches('/'));
        let mut r = req
            .header("Accept", "application/json, text/plain, */*")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("Referer", referer);
        if !cookie.is_empty() {
            r = r.header("Cookie", cookie);
        }
        r
    }

    pub fn list_sites(&self) -> Vec<Value> {
        self.store.list_public()
    }

    pub fn save_site(&self, id: &str, patch: &Value) -> Res<Value> {
        Ok(self.store.save(id, patch)?.public())
    }

    pub fn delete_site(&self, id: &str) -> Res<()> {
        self.store.delete(id)
    }

    pub fn reorder_sites(&self, ids: &[String]) -> Res<Vec<Value>> {
        let list = self.store.reorder(ids)?;
        Ok(list.iter().map(MediaSite::public).collect())
    }

    pub fn open_cf_verify(&self, app: &AppHandle, site_id: &str) -> Res<Value> {
        let site = self
            .store
            .get(site_id)
            .ok_or_else(|| DomainError::not_found("媒体站点不存在"))?;
        let net = self.net_config();
        let _ = open_cf_verify_window(app, &site, &net)?;
        Ok(json!({
            "opened": true,
            "siteId": site.id,
            "site": site.public(),
        }))
    }

    pub async fn check_cf_status(&self, app: &AppHandle, site_id: &str) -> Res<Value> {
        let site = self
            .store
            .get(site_id)
            .ok_or_else(|| DomainError::not_found("媒体站点不存在"))?;
        let status = probe_cf_ready(app, &site).await;
        let verified = status["verified"].as_bool().unwrap_or(false);
        let mut updated_site = site.clone();
        if verified {
            let cookie = status["cookie"]
                .as_str()
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty());
            let ua = status["userAgent"]
                .as_str()
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty());
            if let Ok(saved) = self.store.update_cf_credentials(&site.id, cookie, ua) {
                updated_site = saved;
            }
            hide_cf_verify_window(app, &site.id);
        }
        Ok(json!({
            "siteId": site.id,
            "verified": verified,
            "windowOpen": if verified { false } else { status["windowOpen"].as_bool().unwrap_or(false) },
            "hasClearance": updated_site.cookie.contains("cf_clearance="),
            "site": updated_site.public(),
        }))
    }

    pub async fn search_posts_with_app(
        &self,
        app: Option<&AppHandle>,
        site_id: &str,
        query: &str,
        prompt_query: &str,
        page: i64,
        limit: i64,
        sort: &str,
        rating: &str,
        ai_type_filter: &str,
        show_r18: bool,
    ) -> Res<Value> {
        let site = self
            .store
            .get(site_id)
            .ok_or_else(|| DomainError::not_found("媒体站点不存在"))?;

        match site.kind.as_str() {
            KIND_WEBPAGE => Err(DomainError::bad(
                "自定义网页卡片请直接在工作台内置网页标签页中打开",
            )),
            KIND_DANBOORU => {
                self.search_danbooru(
                    app,
                    &site,
                    query,
                    page.max(1),
                    limit.clamp(1, 100),
                    sort,
                    rating,
                )
                .await
            }
            KIND_AITAG => {
                self.search_aitag(
                    app,
                    &site,
                    query,
                    prompt_query,
                    page.max(1),
                    sort,
                    ai_type_filter,
                    show_r18,
                )
                .await
            }
            other => Err(DomainError::bad(format!("不支持的站点类型：{other}"))),
        }
    }

    pub async fn suggest_tags_with_app(
        &self,
        app: Option<&AppHandle>,
        site_id: &str,
        query: &str,
        category: &str,
    ) -> Res<Value> {
        let q = query.trim().replace(' ', "_");
        if q.is_empty() {
            return Ok(json!({ "suggestions": [] }));
        }
        let site = self
            .store
            .get(site_id)
            .unwrap_or_else(|| super::domain::builtin_sites()[0].clone());

        // 对 Danbooru（以及需要画师/标签补全的站点）调用 Danbooru autocomplete.json / tags.json
        let target_site = if site.kind == KIND_DANBOORU {
            site
        } else {
            self.store
                .get(super::domain::SITE_DANBOORU_ID)
                .unwrap_or_else(|| super::domain::builtin_sites()[0].clone())
        };

        let base = target_site.base_url.trim_end_matches('/');
        let enc_q = percent_encoding::utf8_percent_encode(&q, percent_encoding::NON_ALPHANUMERIC);
        let url = if category == "artist" {
            format!(
                "{base}/tags.json?search[name_matches]={enc_q}*&search[category]=1&search[order]=count&limit=12"
            )
        } else {
            format!(
                "{base}/autocomplete.json?search[query]={enc_q}&search[type]=tag_query&version=1&limit=14"
            )
        };

        let Ok(raw) = self.send_json_request(app, &target_site, &url).await else {
            return Ok(json!({ "suggestions": [] }));
        };
        let suggestions = parse_danbooru_suggestions(&raw);
        Ok(json!({ "suggestions": suggestions }))
    }

    /// Danbooru 独立画师页查询：对应 `/artists.json`，并通过 `/tags.json` 批量关联每位画师的作品数（post_count）。
    pub async fn search_artists_with_app(
        &self,
        app: Option<&AppHandle>,
        site_id: &str,
        name: &str,
        url_query: &str,
        order: &str,
        has_tag: &str,
        is_deleted: &str,
        page: i64,
        limit: i64,
    ) -> Res<Value> {
        let site = self
            .store
            .get(site_id)
            .filter(|s| s.kind == KIND_DANBOORU)
            .or_else(|| self.store.get(SITE_DANBOORU_ID))
            .unwrap_or_else(|| super::domain::builtin_sites()[0].clone());

        let base = site.base_url.trim_end_matches('/');
        let page = page.max(1);
        let limit = limit.clamp(1, 100);

        let order_param = match order {
            "updated_at" | "post_count" | "name" | "created_at" => order,
            _ => "created_at",
        };
        let mut endpoint = format!(
            "{base}/artists.json?page={page}&limit={limit}&search[order]={order_param}&only=id,name,other_names,group_name,is_deleted,updated_at,urls"
        );

        let clean_name = name.trim().replace(' ', "_");
        if !clean_name.is_empty() {
            let enc = percent_encoding::utf8_percent_encode(
                &clean_name,
                percent_encoding::NON_ALPHANUMERIC,
            );
            endpoint.push_str(&format!("&search[any_name_matches]=*{enc}*"));
        }

        let clean_url = url_query.trim();
        if !clean_url.is_empty() {
            let enc = percent_encoding::utf8_percent_encode(
                clean_url,
                percent_encoding::NON_ALPHANUMERIC,
            );
            endpoint.push_str(&format!("&search[url_matches]=*{enc}*"));
        }

        match has_tag {
            "true" | "yes" => endpoint.push_str("&search[has_tag]=true"),
            "false" | "no" => endpoint.push_str("&search[has_tag]=false"),
            _ => {}
        }

        match is_deleted {
            "true" | "yes" => endpoint.push_str("&search[is_deleted]=true"),
            "false" | "no" => endpoint.push_str("&search[is_deleted]=false"),
            _ => {}
        }

        let raw = self.send_json_request(app, &site, &endpoint).await?;
        let arr = raw.as_array().cloned().unwrap_or_default();
        let mut artists: Vec<MediaArtist> = arr
            .iter()
            .filter_map(parse_danbooru_artist)
            .collect();

        // 批量查询 `/tags.json?search[name]=name1,name2,...` 回填每位画师的作品数 post_count
        if !artists.is_empty() {
            let names_csv = artists
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>()
                .join(",");
            let enc_names = percent_encoding::utf8_percent_encode(
                &names_csv,
                percent_encoding::NON_ALPHANUMERIC,
            );
            let tags_url = format!(
                "{base}/tags.json?search[name]={enc_names}&limit={}",
                artists.len().max(20)
            );
            if let Ok(tags_raw) = self.send_json_request(app, &site, &tags_url).await {
                if let Some(tags_arr) = tags_raw.as_array() {
                    let mut count_map: HashMap<String, i64> = HashMap::new();
                    for t in tags_arr {
                        if let Some(t_name) = t["name"].as_str() {
                            let c = t["post_count"].as_i64().unwrap_or(0);
                            count_map.insert(t_name.to_lowercase(), c);
                        }
                    }
                    for artist in &mut artists {
                        if let Some(c) = count_map.get(&artist.name.to_lowercase()) {
                            artist.post_count = *c;
                        }
                    }
                }
            }
        }

        let has_more = arr.len() as i64 >= limit.min(20);
        Ok(json!({
            "site": site.public(),
            "page": page,
            "hasMore": has_more,
            "artists": artists,
        }))
    }

    /// 获取某位 Danbooru 画师的 1 张代表作品图（以及该画师 Tag 的实时作品总数 post_count）。
    pub async fn get_artist_preview_with_app(
        &self,
        app: Option<&AppHandle>,
        site_id: &str,
        artist_name: &str,
    ) -> Res<Value> {
        let site = self
            .store
            .get(site_id)
            .filter(|s| s.kind == KIND_DANBOORU)
            .or_else(|| self.store.get(SITE_DANBOORU_ID))
            .unwrap_or_else(|| super::domain::builtin_sites()[0].clone());

        let clean_tag = artist_name.trim().replace(' ', "_");
        if clean_tag.is_empty() {
            return Err(DomainError::bad("画师名称不能为空"));
        }

        let base = site.base_url.trim_end_matches('/');
        let enc_tag =
            percent_encoding::utf8_percent_encode(&clean_tag, percent_encoding::NON_ALPHANUMERIC);
        let posts_url = format!("{base}/posts.json?tags={enc_tag}&limit=1");

        let raw = self.send_json_request(app, &site, &posts_url).await?;
        let preview_post = raw
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|item| parse_danbooru_post(&site, item));

        Ok(json!({
            "artistName": clean_tag,
            "post": preview_post,
        }))
    }

    pub async fn get_post_with_app(
        &self,
        app: Option<&AppHandle>,
        site_id: &str,
        post_id: &str,
    ) -> Res<Value> {
        let site = self
            .store
            .get(site_id)
            .ok_or_else(|| DomainError::not_found("媒体站点不存在"))?;

        match site.kind.as_str() {
            KIND_WEBPAGE => Err(DomainError::bad(
                "自定义网页卡片不支持单帖详情抓取，请在内置网页标签页浏览",
            )),
            KIND_DANBOORU => self.get_danbooru_post(app, &site, post_id).await,
            KIND_AITAG => self.get_aitag_post(app, &site, post_id).await,
            other => Err(DomainError::bad(format!("不支持的站点类型：{other}"))),
        }
    }

    /// 供后端协议层或导入功能直接拉取远程图片字节（自动携带站点 Referer、Cookie 与代理）。
    pub async fn fetch_remote_bytes(
        &self,
        app: Option<&AppHandle>,
        site_id: &str,
        image_url: &str,
    ) -> Res<(Vec<u8>, String)> {
        let site = self
            .store
            .get(site_id)
            .unwrap_or_else(|| super::domain::builtin_sites()[0].clone());
        let client = self.build_client(&site, 45)?;
        let req = self.apply_site_headers(client.get(image_url), &site, app);
        let resp = req.send().await.map_err(|e| {
            DomainError::bad(format!("下载远程图片失败：{}", describe_err(&e)))
        })?;
        let status = resp.status().as_u16();
        if status == 403 || status == 503 {
            return Err(DomainError::new(
                format!("{CF_CHALLENGE_PREFIX}站点 {} 需要完成安全验证", site.name),
                403,
            ));
        }
        if !resp.status().is_success() {
            return Err(DomainError::bad(format!(
                "远程图片返回 HTTP {status}"
            )));
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/webp")
            .to_string();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| DomainError::bad(format!("读取远程图片内容失败：{e}")))?;
        Ok((bytes.to_vec(), content_type))
    }

    async fn send_json_request(
        &self,
        app: Option<&AppHandle>,
        site: &MediaSite,
        url: &str,
    ) -> Res<Value> {
        let client = self.build_client(site, 25)?;
        let req = self.apply_site_headers(client.get(url), site, app);
        let resp = req.send().await.map_err(|e| {
            DomainError::new(
                format!("无法连接 {}：{}", site.name, describe_err(&e)),
                502,
            )
        })?;
        let status = resp.status().as_u16();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        let body = resp
            .text()
            .await
            .map_err(|e| DomainError::bad(format!("读取 {} 响应失败：{e}", site.name)))?;

        if is_cf_challenge_response(status, &content_type, &body) {
            return Err(DomainError::new(
                format!(
                    "{CF_CHALLENGE_PREFIX}{} 触发了 Cloudflare 安全验证，请在验证窗口完成验证后自动继续",
                    site.name
                ),
                403,
            ));
        }

        if status >= 400 {
            return Err(DomainError::new(
                format!("{} 请求失败 (HTTP {status})", site.name),
                status,
            ));
        }

        serde_json::from_str::<Value>(&body).map_err(|_| {
            if is_cf_challenge_response(200, &content_type, &body) {
                DomainError::new(
                    format!(
                        "{CF_CHALLENGE_PREFIX}{} 返回了安全验证页面，请完成验证后自动继续",
                        site.name
                    ),
                    403,
                )
            } else {
                DomainError::bad(format!("{} 返回的数据不是有效的 JSON", site.name))
            }
        })
    }

    async fn search_danbooru(
        &self,
        app: Option<&AppHandle>,
        site: &MediaSite,
        query: &str,
        page: i64,
        limit: i64,
        sort: &str,
        rating: &str,
    ) -> Res<Value> {
        let base = site.base_url.trim_end_matches('/');
        let base_tags = if !query.trim().is_empty() {
            query.trim()
        } else {
            site.default_query.trim()
        };

        let mut tag_tokens: Vec<String> = base_tags
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        // Danbooru 免费匿名查询最多允许 2 个 tag token；仅在词数充裕时自动追加 rating / order 元标签
        if !rating.is_empty() && rating != "all" && tag_tokens.len() < 2 {
            let r_tag = match rating {
                "g" | "s" | "q" | "e" => Some(format!("rating:{rating}")),
                "safe" => Some("rating:g".to_string()),
                _ => None,
            };
            if let Some(rt) = r_tag {
                if !tag_tokens.iter().any(|t| t.starts_with("rating:")) {
                    tag_tokens.push(rt);
                }
            }
        }

        if !sort.is_empty() && sort != "new" && tag_tokens.len() < 2 {
            let order_tag = match sort {
                "score" => Some("order:score".to_string()),
                "favcount" | "rank" | "monthly" => Some("order:favcount".to_string()),
                _ => None,
            };
            if let Some(ot) = order_tag {
                if !tag_tokens.iter().any(|t| t.starts_with("order:")) {
                    tag_tokens.push(ot);
                }
            }
        }

        let tags = tag_tokens.join(" ");
        let encoded_tags: String =
            percent_encoding::utf8_percent_encode(&tags, percent_encoding::NON_ALPHANUMERIC)
                .to_string();
        let url = if tags.is_empty() {
            format!("{base}/posts.json?page={page}&limit={limit}")
        } else {
            format!("{base}/posts.json?page={page}&limit={limit}&tags={encoded_tags}")
        };

        let raw = self.send_json_request(app, site, &url).await?;
        let arr = raw.as_array().cloned().unwrap_or_default();
        let posts: Vec<MediaPost> = arr
            .iter()
            .filter_map(|item| parse_danbooru_post(site, item))
            .collect();
        let has_more = arr.len() as i64 >= limit.min(20);

        Ok(json!({
            "site": site.public(),
            "page": page,
            "hasMore": has_more,
            "total": Value::Null,
            "posts": posts,
        }))
    }

    async fn get_danbooru_post(
        &self,
        app: Option<&AppHandle>,
        site: &MediaSite,
        post_id: &str,
    ) -> Res<Value> {
        let base = site.base_url.trim_end_matches('/');
        let clean_id = post_id.trim();
        let url = format!("{base}/posts/{clean_id}.json");
        let raw = self.send_json_request(app, site, &url).await?;
        let post = parse_danbooru_post(site, &raw)
            .ok_or_else(|| DomainError::not_found("未找到该 Danbooru 作品或无可用图片"))?;
        Ok(json!({
            "post": post,
        }))
    }

    async fn ensure_aitag_asset_base(
        &self,
        app: Option<&AppHandle>,
        site: &MediaSite,
    ) -> String {
        let current = self
            .aitag_asset_base
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if !current.is_empty() && current != DEFAULT_AITAG_ASSET_BASE {
            return current;
        }
        let base = site.base_url.trim_end_matches('/');
        let cfg_url = format!("{base}/api/config");
        if let Ok(cfg) = self.send_json_request(app, site, &cfg_url).await {
            if let Some(asset_url) = cfg["asset_base_url"].as_str().filter(|s| !s.trim().is_empty())
            {
                let normalized = if asset_url.ends_with('/') {
                    asset_url.to_string()
                } else {
                    format!("{asset_url}/")
                };
                *self
                    .aitag_asset_base
                    .write()
                    .unwrap_or_else(|e| e.into_inner()) = normalized.clone();
                return normalized;
            }
        }
        current
    }

    async fn search_aitag(
        &self,
        app: Option<&AppHandle>,
        site: &MediaSite,
        query: &str,
        prompt_query: &str,
        page: i64,
        sort: &str,
        ai_type_filter: &str,
        show_r18: bool,
    ) -> Res<Value> {
        let base = site.base_url.trim_end_matches('/');
        let asset_base = self.ensure_aitag_asset_base(app, site).await;
        let base_q = if !query.trim().is_empty() {
            query.trim().to_string()
        } else {
            site.default_query.trim().to_string()
        };
        let q = if !ai_type_filter.trim().is_empty() && ai_type_filter != "all" {
            if base_q.is_empty() {
                ai_type_filter.trim().to_string()
            } else if !base_q.to_lowercase().contains(&ai_type_filter.to_lowercase()) {
                format!("{} {}", ai_type_filter.trim(), base_q)
            } else {
                base_q
            }
        } else {
            base_q
        };
        let prompt = prompt_query.trim();
        let r18_flag = if show_r18 { "1" } else { "0" };

        let endpoint = if sort == "monthly" && q.is_empty() && prompt.is_empty() {
            format!(
                "{base}/api/rank/monthly?sensitive_policy={AITAG_SENSITIVE_POLICY}&show_r18={r18_flag}&page={page}&page_size=60&period=current"
            )
        } else {
            let mut u = format!(
                "{base}/api/ai_works_search?sensitive_policy={AITAG_SENSITIVE_POLICY}&show_r18={r18_flag}&page={page}&page_size=60"
            );
            if !q.is_empty() {
                let enc_q = percent_encoding::utf8_percent_encode(
                    &q,
                    percent_encoding::NON_ALPHANUMERIC,
                );
                u.push_str(&format!("&q={enc_q}"));
            }
            if !prompt.is_empty() {
                let enc_p = percent_encoding::utf8_percent_encode(
                    prompt,
                    percent_encoding::NON_ALPHANUMERIC,
                );
                u.push_str(&format!("&prompt={enc_p}"));
            }
            u
        };

        let raw = self.send_json_request(app, site, &endpoint).await?;
        let total = raw["total"].as_i64().unwrap_or(0);
        let items = raw["items"].as_array().cloned().unwrap_or_default();
        let posts: Vec<MediaPost> = items
            .iter()
            .filter_map(|item| parse_aitag_list_item(site, &asset_base, item))
            .collect();
        let has_more = (page * 60) < total || items.len() >= 60;

        Ok(json!({
            "site": site.public(),
            "page": page,
            "hasMore": has_more,
            "total": total,
            "posts": posts,
        }))
    }

    async fn get_aitag_post(
        &self,
        app: Option<&AppHandle>,
        site: &MediaSite,
        post_id: &str,
    ) -> Res<Value> {
        let clean_id = post_id.trim();
        let asset_base = self.ensure_aitag_asset_base(app, site).await;

        let cached = self
            .aitag_work_cache
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(clean_id)
            .cloned();

        let raw = if let Some(hit) = cached {
            hit
        } else {
            let base = site.base_url.trim_end_matches('/');
            let url = format!("{base}/api/work/{clean_id}");
            let data = self.send_json_request(app, site, &url).await?;
            let mut guard = self
                .aitag_work_cache
                .write()
                .unwrap_or_else(|e| e.into_inner());
            if guard.len() > 400 {
                guard.clear();
            }
            guard.insert(clean_id.to_string(), data.clone());
            data
        };

        let post = parse_aitag_detail(site, &asset_base, &raw)
            .ok_or_else(|| DomainError::not_found("未找到该 AI TAG 作品详情"))?;
        Ok(json!({
            "post": post,
        }))
    }
}

pub fn is_cf_challenge_response(status: u16, content_type: &str, body: &str) -> bool {
    let lower = body.to_lowercase();
    if (status == 403 || status == 503)
        && (lower.contains("just a moment")
            || lower.contains("cf_chl_opt")
            || lower.contains("challenges.cloudflare.com")
            || lower.contains("cloudflare")
            || lower.contains("请稍候")
            || lower.contains("attention required"))
    {
        return true;
    }
    if content_type.contains("text/html")
        && (lower.contains("<title>just a moment...</title>")
            || lower.contains("window._cf_chl_opt")
            || lower.contains("/cdn-cgi/challenge-platform/"))
    {
        return true;
    }
    false
}

fn split_space_tags(raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .map(|s| s.trim().replace('_', " "))
        .filter(|s| !s.is_empty())
        .collect()
}

fn danbooru_category_name(cat: i64) -> &'static str {
    match cat {
        1 => "artist",
        3 => "copyright",
        4 => "character",
        5 => "meta",
        _ => "general",
    }
}

pub fn parse_danbooru_suggestions(raw: &Value) -> Vec<MediaTagSuggestion> {
    let Some(arr) = raw.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let name = item["value"]
            .as_str()
            .or_else(|| item["name"].as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let label = item["label"]
            .as_str()
            .unwrap_or(&name)
            .trim()
            .replace('_', " ");
        let cat_id = item["category"].as_i64().unwrap_or(0);
        let post_count = item["post_count"].as_i64().unwrap_or(0);
        out.push(MediaTagSuggestion {
            name,
            label,
            category: danbooru_category_name(cat_id).to_string(),
            post_count,
        });
    }
    out
}

pub fn parse_danbooru_post(site: &MediaSite, item: &Value) -> Option<MediaPost> {
    let id_num = item["id"].as_i64().or_else(|| item["id"].as_str()?.parse().ok())?;
    let id = id_num.to_string();

    let file_url = item["file_url"]
        .as_str()
        .or_else(|| item["large_file_url"].as_str())
        .or_else(|| item["preview_file_url"].as_str())
        .unwrap_or("")
        .to_string();
    let sample_url = item["large_file_url"]
        .as_str()
        .or_else(|| item["file_url"].as_str())
        .or_else(|| item["preview_file_url"].as_str())
        .unwrap_or("")
        .to_string();
    let preview_url = item["preview_file_url"]
        .as_str()
        .or_else(|| item["large_file_url"].as_str())
        .or_else(|| item["file_url"].as_str())
        .unwrap_or("")
        .to_string();

    if preview_url.is_empty() && sample_url.is_empty() && file_url.is_empty() {
        return None;
    }

    let artists = split_space_tags(item["tag_string_artist"].as_str().unwrap_or(""));
    let tags_character = split_space_tags(item["tag_string_character"].as_str().unwrap_or(""));
    let tags_copyright = split_space_tags(item["tag_string_copyright"].as_str().unwrap_or(""));
    let tags_general = split_space_tags(item["tag_string_general"].as_str().unwrap_or(""));
    let tags_meta = split_space_tags(item["tag_string_meta"].as_str().unwrap_or(""));

    let mut prompt_parts: Vec<String> = Vec::new();
    prompt_parts.extend(artists.iter().cloned());
    prompt_parts.extend(tags_character.iter().cloned());
    prompt_parts.extend(tags_copyright.iter().cloned());
    prompt_parts.extend(tags_general.iter().cloned());
    let prompt = prompt_parts.join(", ");

    let title = if !tags_character.is_empty() {
        tags_character.join(" / ")
    } else if !artists.is_empty() {
        format!("by {}", artists.join(", "))
    } else {
        format!("Post #{id}")
    };

    let width = item["image_width"].as_i64().unwrap_or(1000).max(1);
    let height = item["image_height"].as_i64().unwrap_or(1000).max(1);
    let base = site.base_url.trim_end_matches('/');
    let source_url = format!("{base}/posts/{id}");

    Some(MediaPost {
        id,
        site_id: site.id.clone(),
        site_kind: KIND_DANBOORU.into(),
        title,
        caption: String::new(),
        preview_url: if preview_url.is_empty() {
            sample_url.clone()
        } else {
            preview_url.clone()
        },
        sample_url: if sample_url.is_empty() {
            file_url.clone()
        } else {
            sample_url.clone()
        },
        file_url: if file_url.is_empty() {
            sample_url.clone()
        } else {
            file_url.clone()
        },
        source_url,
        width,
        height,
        artists: artists.clone(),
        tags_general,
        tags_character,
        tags_copyright,
        tags_meta,
        tag_translations: Vec::new(),
        prompt: prompt.clone(),
        negative_prompt: String::new(),
        ai_type: "Danbooru".into(),
        model: String::new(),
        author_name: artists.first().cloned().unwrap_or_default(),
        author_id: String::new(),
        created_at: item["created_at"].as_str().unwrap_or("").to_string(),
        score: item["score"].as_i64().unwrap_or(0),
        fav_count: item["fav_count"].as_i64().unwrap_or(0),
        rating: item["rating"].as_str().unwrap_or("g").to_string(),
        image_count: 1,
        pages: vec![MediaPostPage {
            index: 0,
            preview_url,
            file_url,
            model: String::new(),
            prompt,
            negative_prompt: String::new(),
            raw_json: String::new(),
            params: json!({}),
        }],
        raw_params: json!({}),
    })
}

pub fn parse_danbooru_artist(item: &Value) -> Option<MediaArtist> {
    let id = match &item["id"] {
        Value::Number(n) => n.to_string(),
        Value::String(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return None,
    };
    let name = item["name"].as_str()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let other_names = item["other_names"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let group_name = item["group_name"].as_str().unwrap_or("").trim().to_string();
    let is_deleted = item["is_deleted"].as_bool().unwrap_or(false);
    let updated_at = item["updated_at"].as_str().unwrap_or("").to_string();
    let post_count = item["post_count"].as_i64().unwrap_or(0);

    let mut urls: Vec<String> = Vec::new();
    if let Some(u_arr) = item["urls"].as_array() {
        for u in u_arr {
            if let Some(s) = u.as_str() {
                if !s.trim().is_empty() {
                    urls.push(s.trim().to_string());
                }
            } else if let Some(s) = u["url"].as_str() {
                let is_active = u["is_active"].as_bool().unwrap_or(true);
                if is_active && !s.trim().is_empty() {
                    urls.push(s.trim().to_string());
                }
            }
        }
    }

    Some(MediaArtist {
        id,
        name,
        other_names,
        group_name,
        post_count,
        is_deleted,
        updated_at,
        urls,
        preview_post: None,
    })
}

fn parse_json_str_array(v: &Value) -> Vec<String> {
    if let Some(arr) = v.as_array() {
        return arr
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect();
    }
    if let Some(s) = v.as_str() {
        if let Ok(arr) = serde_json::from_str::<Vec<String>>(s) {
            return arr
                .into_iter()
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect();
        }
    }
    Vec::new()
}

fn aitag_file_stem_from_original_url(url: &str, work_id: &str) -> String {
    if let Some(last) = url.rsplit('/').next() {
        let no_query = last.split('?').next().unwrap_or(last);
        if let Some((stem, _ext)) = no_query.rsplit_once('.') {
            if !stem.is_empty() {
                return stem.to_string();
            }
        }
    }
    format!("{work_id}_p0")
}

fn build_aitag_cdn_url(asset_base: &str, ai_type: &str, author_id: &str, file_stem: &str) -> String {
    let base = if asset_base.trim().is_empty() {
        DEFAULT_AITAG_ASSET_BASE.to_string()
    } else if asset_base.ends_with('/') {
        asset_base.to_string()
    } else {
        format!("{asset_base}/")
    };
    let folder = if ai_type.trim().is_empty() {
        "NAI"
    } else {
        ai_type.trim()
    };
    let clean_stem = file_stem
        .trim_end_matches(".webp")
        .trim_end_matches(".png")
        .trim_end_matches(".jpg");
    format!("{base}{folder}/{author_id}/{clean_stem}.webp")
}

pub fn parse_aitag_list_item(
    site: &MediaSite,
    asset_base: &str,
    item: &Value,
) -> Option<MediaPost> {
    let id = match &item["id"] {
        Value::Number(n) => n.to_string(),
        Value::String(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return None,
    };
    let author_id = match &item["userId"] {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.trim().to_string(),
        _ => match &item["userid"] {
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.trim().to_string(),
            _ => String::new(),
        },
    };
    let author_name = item["userName"]
        .as_str()
        .or_else(|| item["author_name"].as_str())
        .unwrap_or("")
        .to_string();
    let ai_type = item["AI_type"]
        .as_str()
        .or_else(|| item["ai_type"].as_str())
        .unwrap_or("NAI")
        .to_string();
    let title = item["title"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("作品 #{id}"));
    let tags = parse_json_str_array(&item["tags"]);
    let orig_urls = parse_json_str_array(&item["original_urls"]);
    let first_stem = orig_urls
        .first()
        .map(|u| aitag_file_stem_from_original_url(u, &id))
        .unwrap_or_else(|| format!("{id}_p0"));
    let first_url = build_aitag_cdn_url(asset_base, &ai_type, &author_id, &first_stem);
    let image_count = item["image_count"]
        .as_i64()
        .unwrap_or_else(|| orig_urls.len().max(1) as i64);

    let base = site.base_url.trim_end_matches('/');
    let source_url = format!("{base}/i/{id}");

    let mut list_artists: Vec<String> = Vec::new();
    for t in &tags {
        let lower = t.to_lowercase();
        if lower.starts_with("artist:") {
            let clean = t["artist:".len()..].trim().replace('_', " ");
            if !clean.is_empty() && !list_artists.iter().any(|a| a.eq_ignore_ascii_case(&clean)) {
                list_artists.push(clean);
            }
        }
    }

    let caption = item["caption"].as_str().unwrap_or("").trim().to_string();

    Some(MediaPost {
        id,
        site_id: site.id.clone(),
        site_kind: KIND_AITAG.into(),
        title,
        caption,
        preview_url: first_url.clone(),
        sample_url: first_url.clone(),
        file_url: first_url,
        source_url,
        width: 1000,
        height: 1200,
        artists: list_artists,
        tags_general: tags,
        tags_character: Vec::new(),
        tags_copyright: Vec::new(),
        tags_meta: vec![ai_type.clone()],
        tag_translations: Vec::new(),
        prompt: String::new(),
        negative_prompt: String::new(),
        ai_type,
        model: String::new(),
        author_name,
        author_id,
        created_at: item["create_date"].as_str().unwrap_or("").to_string(),
        score: item["total_view"].as_i64().unwrap_or(0),
        fav_count: item["total_bookmarks"].as_i64().unwrap_or(0),
        rating: "g".into(),
        image_count,
        pages: Vec::new(),
        raw_params: json!({}),
    })
}

fn extract_prompt_and_uc_from_ai_json(ai_json_raw: &Value, fallback_prompt: &str) -> (String, String, Value, i64, i64) {
    let parsed: Value = match ai_json_raw {
        Value::Object(_) => ai_json_raw.clone(),
        Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or_else(|_| json!({})),
        _ => json!({}),
    };

    let comment: Value = match &parsed["Comment"] {
        Value::Object(_) => parsed["Comment"].clone(),
        Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or_else(|_| json!({})),
        _ => json!({}),
    };

    let prompt = comment["prompt"]
        .as_str()
        .or_else(|| comment["v4_prompt"]["caption"]["base_caption"].as_str())
        .or_else(|| parsed["Description"].as_str())
        .or_else(|| parsed["prompt"].as_str())
        .unwrap_or(fallback_prompt)
        .trim()
        .to_string();

    let uc = comment["uc"]
        .as_str()
        .or_else(|| comment["v4_negative_prompt"]["caption"]["base_caption"].as_str())
        .or_else(|| parsed["uc"].as_str())
        .or_else(|| parsed["negative_prompt"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let width = comment["width"]
        .as_i64()
        .or_else(|| parsed["width"].as_i64())
        .unwrap_or(1000)
        .max(1);
    let height = comment["height"]
        .as_i64()
        .or_else(|| parsed["height"].as_i64())
        .unwrap_or(1200)
        .max(1);

    let params = if comment.is_object() && !comment.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        comment
    } else {
        parsed
    };

    (prompt, uc, params, width, height)
}

fn aitag_page_index(file_name: &str) -> usize {
    if let Some((_, suffix)) = file_name.rsplit_once("_p") {
        let digits: String = suffix.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<usize>() {
            return n;
        }
    }
    0
}

fn parse_aitag_tag_translations(tags: &[String], raw_trans: &Value) -> Vec<MediaTagItem> {
    let mut map: HashMap<String, String> = HashMap::new();
    if let Some(arr) = raw_trans.as_array() {
        for entry in arr {
            let tag = entry["tag"].as_str().unwrap_or("").trim();
            if tag.is_empty() {
                continue;
            }
            let zh = entry["translations"]["zh-CN"]
                .as_str()
                .or_else(|| entry["translations"]["zh"].as_str())
                .or_else(|| entry["translation_versions"]["zh-CN"]["crowdin"].as_str())
                .or_else(|| entry["translation_versions"]["zh-CN"]["ai"]["tag"].as_str())
                .or_else(|| entry["translations"]["en"].as_str())
                .unwrap_or("")
                .trim();
            if !zh.is_empty() && zh != tag {
                map.insert(tag.to_string(), zh.to_string());
            }
        }
    }
    tags.iter()
        .map(|t| MediaTagItem {
            name: t.clone(),
            translated: map.get(t).cloned().unwrap_or_default(),
        })
        .collect()
}

pub fn parse_aitag_detail(
    site: &MediaSite,
    asset_base: &str,
    data: &Value,
) -> Option<MediaPost> {
    let work = data.get("work").unwrap_or(data);
    let id = match &work["id"] {
        Value::Number(n) => n.to_string(),
        Value::String(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return None,
    };
    let author_id = match &work["userid"] {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.trim().to_string(),
        _ => match &work["userId"] {
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.trim().to_string(),
            _ => String::new(),
        },
    };
    let author_name = work["userName"]
        .as_str()
        .or_else(|| work["author_name"].as_str())
        .unwrap_or("")
        .to_string();
    let ai_type = work["ai_type"]
        .as_str()
        .or_else(|| work["AI_type"].as_str())
        .unwrap_or("NAI")
        .to_string();
    let title = work["title"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("作品 #{id}"));
    let caption = work["caption"].as_str().unwrap_or("").trim().to_string();
    let tags = parse_json_str_array(&work["tags"]);
    let tag_translations = parse_aitag_tag_translations(&tags, &work["tag_translations"]);

    let mut images_arr = data["images"].as_array().cloned().unwrap_or_default();
    images_arr.sort_by_key(|img| {
        aitag_page_index(img["file_name"].as_str().unwrap_or(""))
    });

    let mut pages: Vec<MediaPostPage> = Vec::new();
    let mut first_prompt = String::new();
    let mut first_uc = String::new();
    let mut first_model = String::new();
    let mut first_params = json!({});
    let mut first_w = 1000;
    let mut first_h = 1200;

    for (idx, img) in images_arr.iter().enumerate() {
        let img_type = img["image_type"].as_str().unwrap_or(&ai_type);
        let img_author = match &img["author_id"] {
            Value::Number(n) => n.to_string(),
            Value::String(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => author_id.clone(),
        };
        let file_name = img["file_name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{id}_p{idx}"));
        let url = build_aitag_cdn_url(asset_base, img_type, &img_author, &file_name);
        let fallback_prompt = img["prompt_text"].as_str().unwrap_or("");
        let (prompt, uc, params, w, h) =
            extract_prompt_and_uc_from_ai_json(&img["ai_json"], fallback_prompt);
        let model = img["model"].as_str().unwrap_or("").to_string();
        let raw_json = match &img["ai_json"] {
            Value::String(s) => {
                if let Ok(parsed) = serde_json::from_str::<Value>(s) {
                    serde_json::to_string_pretty(&parsed).unwrap_or_else(|_| s.clone())
                } else {
                    s.clone()
                }
            }
            other => serde_json::to_string_pretty(other).unwrap_or_default(),
        };

        if idx == 0 {
            first_prompt = prompt.clone();
            first_uc = uc.clone();
            first_model = model.clone();
            first_params = params.clone();
            first_w = w;
            first_h = h;
        }

        pages.push(MediaPostPage {
            index: idx,
            preview_url: url.clone(),
            file_url: url,
            model,
            prompt,
            negative_prompt: uc,
            raw_json,
            params,
        });
    }

    let first_url = pages
        .first()
        .map(|p| p.file_url.clone())
        .unwrap_or_else(|| build_aitag_cdn_url(asset_base, &ai_type, &author_id, &format!("{id}_p0")));

    let mut artists = extract_artists(&first_prompt).0;
    for t in &tags {
        let lower = t.to_lowercase();
        if lower.starts_with("artist:") {
            let clean = t["artist:".len()..].trim().replace('_', " ");
            if !clean.is_empty() && !artists.iter().any(|a| a.eq_ignore_ascii_case(&clean)) {
                artists.push(clean);
            }
        }
    }
    let base = site.base_url.trim_end_matches('/');

    Some(MediaPost {
        id: id.clone(),
        site_id: site.id.clone(),
        site_kind: KIND_AITAG.into(),
        title,
        caption,
        preview_url: first_url.clone(),
        sample_url: first_url.clone(),
        file_url: first_url,
        source_url: format!("{base}/i/{id}"),
        width: first_w,
        height: first_h,
        artists,
        tags_general: tags,
        tags_character: Vec::new(),
        tags_copyright: Vec::new(),
        tags_meta: if first_model.is_empty() {
            vec![ai_type.clone()]
        } else {
            vec![ai_type.clone(), first_model.clone()]
        },
        tag_translations,
        prompt: first_prompt,
        negative_prompt: first_uc,
        ai_type,
        model: first_model,
        author_name,
        author_id,
        created_at: work["create_date"].as_str().unwrap_or("").to_string(),
        score: work["total_view"].as_i64().unwrap_or(0),
        fav_count: work["total_bookmarks"].as_i64().unwrap_or(0),
        rating: "g".into(),
        image_count: pages.len().max(1) as i64,
        pages,
        raw_params: first_params,
    })
}
