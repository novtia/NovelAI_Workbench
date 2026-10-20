use fancy_regex::Regex as FRegex;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

pub const SINGLE_ARTIST_ALBUM_ID: &str = "single-artist";
pub const SINGLE_ARTIST_ALBUM_NAME: &str = "单画师";
pub const SINGLE_ARTIST_KIND: &str = "singleArtist";
pub const SINGLE_ARTIST_IMPORT_ERROR: &str = "「单画师」收藏夹只接受含单个画师串的测试图";
pub const TEST_SET_ID_PREFIX: &str = "testset-";
pub const TEST_SET_KIND: &str = "testSet";

static ARTIST_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^artist\s*:\s*").unwrap());
static WS_UNDERSCORE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[_\s]+").unwrap());
static ARTIST_RE: Lazy<FRegex> = Lazy::new(|| {
    FRegex::new(
        r"(?i)(\d+(?:\.\d+)?::)?\s*(?:\[artist:\s*([^\]]+?)\]|artist:\s*([^,\]\n]+?))(?:\s*::|(?=\s*,)|\s*$)",
    )
    .unwrap()
});
static WS_RUN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());

pub fn strip_artist(tag: &str) -> String {
    let mut t = tag.to_string();
    while let Some(m) = ARTIST_PREFIX.find(&t) {
        t = t[m.end()..].to_string();
    }
    t.trim().to_string()
}

pub fn tag_key(tag: &str) -> String {
    WS_UNDERSCORE.replace_all(&strip_artist(tag).to_lowercase(), " ").trim().to_string()
}

/// 图库元数据里的画师列表去重后的 key；不是数组时返回空。
pub fn unique_artist_keys(artists: &Value) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let Some(list) = artists.as_array() else {
        return keys;
    };
    for raw in list {
        let key = tag_key(&crate::util::py_str(raw));
        if key.is_empty() || keys.contains(&key) {
            continue;
        }
        keys.push(key);
    }
    keys
}

/// 从 prompt 文本里抽出画师名（按 tag_key 去重、保序），并返回带权重的画师串。
pub fn extract_artists(text: &str) -> (Vec<String>, String) {
    let mut names: Vec<String> = Vec::new();
    let mut chunks: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for caps in ARTIST_RE.captures_iter(text).flatten() {
        let raw = caps
            .get(2)
            .or_else(|| caps.get(3))
            .map(|m| m.as_str())
            .unwrap_or("");
        let name = WS_RUN.replace_all(raw.trim(), " ").to_string();
        let key = tag_key(&name);
        if name.is_empty() || key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let weight = caps.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        chunks.push(if weight.is_empty() { format!("artist:{name}") } else { format!("{weight}artist:{name}::") });
        names.push(name);
    }
    (names, chunks.join(", "))
}

pub fn is_test_set_id(album_id: &str) -> bool {
    album_id.starts_with(TEST_SET_ID_PREFIX)
}

pub fn album_kind(album_id: &str, name: &str) -> Option<&'static str> {
    if is_test_set_id(album_id) {
        return Some(TEST_SET_KIND);
    }
    if album_id == SINGLE_ARTIST_ALBUM_ID || name.trim() == SINGLE_ARTIST_ALBUM_NAME {
        return Some(SINGLE_ARTIST_KIND);
    }
    None
}

fn kind_of(album: &Value) -> Option<&'static str> {
    let id = album.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let name = album.get("name").and_then(|v| v.as_str()).unwrap_or("");
    album_kind(id, name)
}

pub fn is_single_artist_album(album: Option<&Value>) -> bool {
    album.map(|a| kind_of(a) == Some(SINGLE_ARTIST_KIND)).unwrap_or(false)
}

pub fn is_test_set_album(album: Option<&Value>) -> bool {
    album.map(|a| kind_of(a) == Some(TEST_SET_KIND)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_key_normalizes() {
        assert_eq!(tag_key("artist:Foo_Bar  Baz"), "foo bar baz");
        assert_eq!(tag_key("artist: artist:X"), "x");
    }

    #[test]
    fn extracts_weighted_and_bracketed() {
        let (names, line) = extract_artists("1girl, 1.4::artist:foo bar::, [artist:baz], artist:qux, red");
        assert_eq!(names, vec!["foo bar", "baz", "qux"]);
        assert_eq!(line, "1.4::artist:foo bar::, artist:baz, artist:qux");
    }
}
