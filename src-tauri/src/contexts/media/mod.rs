pub mod bridge;
pub mod domain;
pub mod service;
pub mod storage;

#[cfg(test)]
mod tests {
    use super::domain::{
        is_valid_kind, KIND_AITAG, KIND_DANBOORU, KIND_WEBPAGE, SITE_AITAG_ID, SITE_DANBOORU_ID,
    };
    use super::service::{
        is_cf_challenge_response, parse_aitag_detail, parse_aitag_list_item, parse_danbooru_artist,
        parse_danbooru_post, parse_danbooru_suggestions,
    };
    use super::storage::MediaSiteStore;
    use serde_json::json;

    #[test]
    fn valid_kinds_include_builtin_and_webpage() {
        assert!(is_valid_kind(KIND_DANBOORU));
        assert!(is_valid_kind(KIND_AITAG));
        assert!(is_valid_kind(KIND_WEBPAGE));
        assert!(!is_valid_kind("unknown"));
    }

    #[test]
    fn store_keeps_builtins_and_manages_custom_webpages() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = MediaSiteStore::new(dir.path().join("media_sites.json"));

        let initial = store.list();
        assert_eq!(initial.len(), 2);
        assert_eq!(initial[0].id, SITE_DANBOORU_ID);
        assert_eq!(initial[1].id, SITE_AITAG_ID);

        let created = store
            .save(
                "",
                &json!({
                    "name": "Pixiv",
                    "baseUrl": "www.pixiv.net",
                    "kind": "webpage",
                    "note": "插画社区"
                }),
            )
            .expect("create custom webpage");
        assert_eq!(created.kind, KIND_WEBPAGE);
        assert_eq!(created.base_url, "https://www.pixiv.net");
        assert!(!created.builtin);

        let created2 = store
            .save(
                "",
                &json!({
                    "name": "Civitai",
                    "baseUrl": "https://civitai.com/",
                }),
            )
            .expect("create second webpage");
        assert_eq!(created2.kind, KIND_WEBPAGE);
        assert_eq!(created2.base_url, "https://civitai.com");

        let all = store.list();
        assert_eq!(all.len(), 4);

        let reordered = store
            .reorder(&[created2.id.clone(), created.id.clone()])
            .expect("reorder");
        assert_eq!(reordered[2].id, created2.id);
        assert_eq!(reordered[3].id, created.id);

        // Builtin cannot be deleted
        assert!(store.delete(SITE_DANBOORU_ID).is_err());

        // Custom can be deleted
        store.delete(&created.id).expect("delete custom");
        assert_eq!(store.list().len(), 3);
    }

    #[test]
    fn detects_cf_challenge_responses() {
        assert!(is_cf_challenge_response(
            403,
            "text/html; charset=UTF-8",
            "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>"
        ));
        assert!(!is_cf_challenge_response(
            200,
            "application/json",
            r#"[{"id": 1}]"#
        ));
    }

    #[test]
    fn parses_danbooru_and_aitag_posts() {
        let builtins = super::domain::builtin_sites();
        let danbooru = &builtins[0];
        let aitag = &builtins[1];

        let db_post = parse_danbooru_post(
            danbooru,
            &json!({
                "id": 8842100,
                "preview_file_url": "https://cdn.donmai.us/180x180/sample.jpg",
                "large_file_url": "https://cdn.donmai.us/sample/sample.jpg",
                "file_url": "https://cdn.donmai.us/original/sample.png",
                "image_width": 1200,
                "image_height": 1600,
                "tag_string_artist": "wlop",
                "tag_string_character": "hatsune_miku",
                "tag_string_copyright": "vocaloid",
                "tag_string_general": "1girl solo blue_hair",
                "score": 42,
                "fav_count": 100,
                "rating": "s"
            }),
        )
        .expect("parse danbooru");
        assert_eq!(db_post.id, "8842100");
        assert_eq!(db_post.artists, vec!["wlop"]);
        assert!(db_post.prompt.contains("hatsune miku"));

        let at_post = parse_aitag_list_item(
            aitag,
            "https://ai-img.10118899.xyz/",
            &json!({
                "id": 152058717,
                "userId": 129025849,
                "userName": "ぽぺらぼ",
                "title": "テスト作品",
                "tags": "[\"オリジナル\", \"AI生成\"]",
                "original_urls": "[\"https://i.pximg.net/img-original/img/2026/11/14/20/02/39/152058717_p1.png\"]",
                "AI_type": "NAI",
                "image_count": 3
            }),
        )
        .expect("parse aitag");
        assert_eq!(at_post.id, "152058717");
        assert_eq!(
            at_post.preview_url,
            "https://ai-img.10118899.xyz/NAI/129025849/152058717_p1.webp"
        );
        assert_eq!(at_post.image_count, 3);

        let suggestions = parse_danbooru_suggestions(&json!([
            { "value": "wlop", "label": "wlop", "category": 1, "post_count": 1280 },
            { "value": "hatsune_miku", "label": "hatsune_miku", "category": 4, "post_count": 98000 }
        ]));
        assert_eq!(suggestions.len(), 2);
        assert_eq!(suggestions[0].category, "artist");
        assert_eq!(suggestions[0].name, "wlop");
        assert_eq!(suggestions[1].category, "character");
        assert_eq!(suggestions[1].label, "hatsune miku");

        let artist = parse_danbooru_artist(&json!({
            "id": 99123,
            "name": "shuanggan_kan",
            "other_names": ["双柑kan"],
            "group_name": "",
            "is_deleted": false,
            "updated_at": "2026-11-14T20:00:00.000-05:00",
            "urls": [{ "url": "https://www.pixiv.net/users/12345", "is_active": true }]
        }))
        .expect("parse artist");
        assert_eq!(artist.name, "shuanggan_kan");
        assert_eq!(artist.other_names, vec!["双柑kan"]);
        assert_eq!(artist.urls, vec!["https://www.pixiv.net/users/12345"]);

        let detail = parse_aitag_detail(
            aitag,
            "https://ai-img.10118899.xyz/",
            &json!({
                "work": {
                    "id": 152058717,
                    "userid": 129025849,
                    "userName": "ぽぺらぼ",
                    "title": "ギャルにん！③",
                    "caption": "キャプション説明",
                    "tags": "[\"ギャル忍者\", \"白ギャル\"]",
                    "ai_type": "NAI",
                    "tag_translations": [
                        { "tag": "ギャル忍者", "translations": { "zh-CN": "辣妹忍者" } }
                    ]
                },
                "images": [
                    {
                        "id": 2,
                        "work_id": 152058717,
                        "author_id": 129025849,
                        "image_type": "NAI",
                        "model": "NovelAI Diffusion V4.5",
                        "file_name": "152058717_p2",
                        "ai_json": "{\"Comment\":{\"prompt\":\"page2 prompt\",\"steps\":28}}"
                    },
                    {
                        "id": 1,
                        "work_id": 152058717,
                        "author_id": 129025849,
                        "image_type": "NAI",
                        "model": "NovelAI Diffusion V4.5",
                        "file_name": "152058717_p1",
                        "ai_json": "{\"Comment\":{\"prompt\":\"page1 prompt\",\"steps\":28}}"
                    }
                ]
            }),
        )
        .expect("parse aitag detail");
        assert_eq!(detail.caption, "キャプション説明");
        assert_eq!(detail.tag_translations.len(), 2);
        assert_eq!(detail.tag_translations[0].translated, "辣妹忍者");
        assert_eq!(detail.pages.len(), 2);
        assert_eq!(detail.pages[0].prompt, "page1 prompt");
        assert_eq!(detail.pages[1].prompt, "page2 prompt");
    }
}
