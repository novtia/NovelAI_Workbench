//! 图片文件按来源分桶存放，文件名是内容哈希加扩展名：
//!
//! ```text
//! images/
//!   studio/              生图工作室的结果图
//!   lottery/             抽奖出的图
//!   favorites/<相册 id>/  收藏夹作品：收藏时从别的桶复制一份过来，之后互不影响
//!   inputs/              图生图的底图、蒙版
//! ```
//!
//! 每个桶下的 `thumbs/` 放缩略图。同一张图可以在几个桶里各有一份，删除只删对应桶里的那份。
//! 旧版的扁平目录 `blobs/<前两位>/<哈希>` 只读兜底，整理存储时再拆进各桶。

use super::clock::new_hex;
use super::errors::Res;
use super::hashes::{is_hash64, sha256_bytes};
use crate::util::{get, py_str, truthy};
use image::imageops::FilterType;
use image::GenericImageView;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

/// 返回 (最大边, WEBP 质量)；由设置服务注入，没注入时用默认值。
pub type ThumbProvider = Arc<dyn Fn() -> (u32, u32) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Bucket {
    Studio,
    Lottery,
    Inputs,
    Favorites(String),
}

impl Bucket {
    /// 写进事件、引用表和导出包的名字：`studio`、`lottery`、`inputs`、`favorites/<相册 id>`。
    pub fn label(&self) -> String {
        match self {
            Bucket::Studio => "studio".into(),
            Bucket::Lottery => "lottery".into(),
            Bucket::Inputs => "inputs".into(),
            Bucket::Favorites(album) => format!("favorites/{album}"),
        }
    }

    pub fn parse(label: &str) -> Option<Bucket> {
        match label {
            "studio" => Some(Bucket::Studio),
            "lottery" => Some(Bucket::Lottery),
            "inputs" => Some(Bucket::Inputs),
            _ => {
                let album = label.strip_prefix("favorites/")?;
                valid_album_id(album).then(|| Bucket::Favorites(album.to_string()))
            }
        }
    }

    /// 生图任务的结果图放哪：抽奖进 lottery；测试集和悬停补图直接进目标收藏夹；其余都是生图工作室。
    pub fn for_job(source: &str, client: &Value) -> Bucket {
        match source {
            "lottery" => Bucket::Lottery,
            "gallery" => gallery_target(client)
                .map(Bucket::Favorites)
                .unwrap_or(Bucket::Studio),
            _ => Bucket::Studio,
        }
    }
}

/// 测试集任务的目标收藏夹：`testSetId`，没有就是悬停补图的 `targetAlbumId`。
pub fn gallery_target(client: &Value) -> Option<String> {
    for key in ["testSetId", "targetAlbumId"] {
        let v = get(client, key);
        if truthy(v) {
            let s = py_str(v).trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

fn valid_album_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && !id.chars().any(|c| {
            matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()
        })
}

/// 相册 id 当目录名；正常的 id 只有字母数字和 `-`、`_`，原样使用。
fn album_dir_name(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 桶里的一个位置：原图或缩略图。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Slot {
    pub bucket: Bucket,
    pub thumb: bool,
}

impl Slot {
    pub fn image(bucket: Bucket) -> Slot {
        Slot {
            bucket,
            thumb: false,
        }
    }

    pub fn thumb(bucket: Bucket) -> Slot {
        Slot {
            bucket,
            thumb: true,
        }
    }

    /// `studio`、`studio/thumbs`、`favorites/<id>/thumbs` ……
    pub fn label(&self) -> String {
        if self.thumb {
            format!("{}/thumbs", self.bucket.label())
        } else {
            self.bucket.label()
        }
    }

    pub fn parse(label: &str) -> Option<Slot> {
        if let Some(bucket) = Bucket::parse(label) {
            return Some(Slot::image(bucket));
        }
        Bucket::parse(label.strip_suffix("/thumbs")?).map(Slot::thumb)
    }
}

/// 磁盘上的一个图片文件。`slot` 为 None 表示在旧的扁平目录里。
#[derive(Clone, Debug)]
pub struct BlobFile {
    pub slot: Option<Slot>,
    pub hash: String,
    pub path: PathBuf,
    pub size: u64,
}

/// 查找时依次尝试的扩展名；写入时按文件头选。
const EXTS: [&str; 6] = ["png", "webp", "jpg", "gif", "bmp", "bin"];

pub fn file_ext(head: &[u8]) -> &'static str {
    if head.len() >= 8 && &head[..8] == b"\x89PNG\r\n\x1a\n" {
        "png"
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        "webp"
    } else if head.len() >= 2 && head[0] == 0xff && head[1] == 0xd8 {
        "jpg"
    } else if head.len() >= 4 && &head[..4] == b"GIF8" {
        "gif"
    } else if head.len() >= 2 && &head[..2] == b"BM" {
        "bmp"
    } else {
        "bin"
    }
}

/// 文件名 `<哈希>.<扩展名>` 里的哈希；临时文件和别的东西返回 None。
fn hash_of_name(name: &str) -> Option<String> {
    let (stem, ext) = name.split_once('.')?;
    (is_hash64(stem) && EXTS.contains(&ext)).then(|| stem.to_string())
}

pub(crate) fn read_head(path: &Path) -> Vec<u8> {
    let mut head = vec![0u8; 16];
    let n = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .unwrap_or(0);
    head.truncate(n);
    head
}

pub struct BlobStore {
    /// `images/`
    pub root: PathBuf,
    /// 旧版扁平目录 `blobs/`，只读。
    pub legacy: PathBuf,
    thumb_provider: RwLock<Option<ThumbProvider>>,
    /// 哈希 → 上次找到的文件，命中时再确认一次文件还在。
    located: Mutex<HashMap<String, PathBuf>>,
}

impl BlobStore {
    /// 数据目录下的 `images/`，旧图在 `blobs/`。
    pub fn open(data_dir: &Path) -> Res<Self> {
        Self::new(&data_dir.join("images"), &data_dir.join("blobs"))
    }

    pub fn new(root: &Path, legacy: &Path) -> Res<Self> {
        std::fs::create_dir_all(root)?;
        Ok(BlobStore {
            root: root.to_path_buf(),
            legacy: legacy.to_path_buf(),
            thumb_provider: RwLock::new(None),
            located: Mutex::new(HashMap::new()),
        })
    }

    pub fn set_thumb_provider(&self, provider: ThumbProvider) {
        *self
            .thumb_provider
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(provider);
    }

    pub fn thumb(&self, data: &[u8]) -> Option<Vec<u8>> {
        let (size, quality) = self
            .thumb_provider
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|p| p())
            .unwrap_or((420, 82));
        make_thumb(data, size, quality)
    }

    pub fn bucket_dir(&self, bucket: &Bucket) -> PathBuf {
        match bucket {
            Bucket::Studio => self.root.join("studio"),
            Bucket::Lottery => self.root.join("lottery"),
            Bucket::Inputs => self.root.join("inputs"),
            Bucket::Favorites(album) => self.root.join("favorites").join(album_dir_name(album)),
        }
    }

    pub fn slot_dir(&self, slot: &Slot) -> PathBuf {
        let dir = self.bucket_dir(&slot.bucket);
        if slot.thumb {
            dir.join("thumbs")
        } else {
            dir
        }
    }

    /// 这个位置上已有的文件。
    pub fn path_in(&self, slot: &Slot, hash: &str) -> Option<PathBuf> {
        probe(&self.slot_dir(slot), &hash.to_lowercase())
    }

    pub fn has(&self, slot: &Slot, hash: &str) -> bool {
        self.path_in(slot, hash).is_some()
    }

    pub fn legacy_path(&self, hash: &str) -> PathBuf {
        let hash = hash.to_lowercase();
        let head: String = hash.chars().take(2).collect();
        self.legacy.join(head).join(hash)
    }

    /// 原图写入桶，返回内容哈希。已存在就不重写。
    pub fn put(&self, bucket: &Bucket, data: &[u8]) -> Res<String> {
        self.put_in(&Slot::image(bucket.clone()), data)
    }

    pub fn put_thumb(&self, bucket: &Bucket, data: &[u8]) -> Res<String> {
        self.put_in(&Slot::thumb(bucket.clone()), data)
    }

    pub fn put_in(&self, slot: &Slot, data: &[u8]) -> Res<String> {
        let digest = sha256_bytes(data);
        if !self.has(slot, &digest) {
            write_atomic(
                &self.slot_dir(slot),
                &format!("{digest}.{}", file_ext(data)),
                data,
            )?;
        }
        Ok(digest)
    }

    /// 原图 + 缩略图一起写入同一个桶；`thumb` 为 None 时自己生成（解码失败就没有缩略图，返回空串）。
    pub fn put_image(
        &self,
        bucket: &Bucket,
        data: &[u8],
        thumb: Option<&[u8]>,
    ) -> Res<(String, String)> {
        let digest = self.put(bucket, data)?;
        let thumb_hash = match thumb.filter(|t| !t.is_empty()) {
            Some(t) => self.put_thumb(bucket, t)?,
            None => match self.thumb(data) {
                Some(t) if !t.is_empty() => self.put_thumb(bucket, &t)?,
                _ => String::new(),
            },
        };
        Ok((digest, thumb_hash))
    }

    /// 保证这个位置上有这张图：没有就从别的桶（或旧目录）复制一份。哪里都找不到返回 false。
    pub fn copy_into(&self, slot: &Slot, hash: &str) -> Res<bool> {
        if self.has(slot, hash) {
            return Ok(true);
        }
        let Some(src) = self.find(hash) else {
            return Ok(false);
        };
        let data = std::fs::read(&src)?;
        write_atomic(
            &self.slot_dir(slot),
            &format!("{}.{}", hash.to_lowercase(), file_ext(&data)),
            &data,
        )?;
        Ok(true)
    }

    /// 把旧目录里的文件直接挪进这个位置（同一个盘只是改名）。
    /// 位置上已经有了，就把旧目录里的重复文件删掉。
    pub fn move_legacy(&self, slot: &Slot, hash: &str) -> Res<bool> {
        if self.has(slot, hash) {
            let src = self.legacy_path(hash);
            if src.is_file() {
                let _ = std::fs::remove_file(&src);
                self.forget(hash);
            }
            return Ok(true);
        }
        let src = self.legacy_path(hash);
        if !src.is_file() {
            return Ok(false);
        }
        let dir = self.slot_dir(slot);
        std::fs::create_dir_all(&dir)?;
        let dest = dir.join(format!(
            "{}.{}",
            hash.to_lowercase(),
            file_ext(&read_head(&src))
        ));
        if std::fs::rename(&src, &dest).is_err() {
            let data = std::fs::read(&src)?;
            write_atomic(
                &dir,
                &dest.file_name().unwrap_or_default().to_string_lossy(),
                &data,
            )?;
            let _ = std::fs::remove_file(&src);
        }
        self.forget(hash);
        Ok(true)
    }

    /// 删掉这个位置上的文件，返回删掉的字节数（不存在是 0）。
    pub fn remove(&self, slot: &Slot, hash: &str) -> u64 {
        let hash = hash.to_lowercase();
        let dir = self.slot_dir(slot);
        let mut bytes = 0;
        for ext in EXTS {
            let path = dir.join(format!("{hash}.{ext}"));
            if let Ok(meta) = std::fs::metadata(&path) {
                if std::fs::remove_file(&path).is_ok() {
                    bytes += meta.len();
                }
            }
        }
        self.forget(&hash);
        bytes
    }

    pub fn remove_legacy(&self, hash: &str) -> u64 {
        let path = self.legacy_path(hash);
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&path).is_ok() {
            self.forget(hash);
            size
        } else {
            0
        }
    }

    fn forget(&self, hash: &str) {
        self.located
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&hash.to_lowercase());
    }

    /// 按 studio、lottery、inputs、各收藏夹、旧目录的顺序找这张图（原图和缩略图都算）。
    pub fn find(&self, hash: &str) -> Option<PathBuf> {
        let hash = hash.to_lowercase();
        if !is_hash64(&hash) {
            return None;
        }
        if let Some(p) = self
            .located
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&hash)
            .cloned()
        {
            if p.is_file() {
                return Some(p);
            }
        }
        let found = self.search(&hash);
        let mut cache = self.located.lock().unwrap_or_else(|e| e.into_inner());
        match &found {
            Some(p) => {
                cache.insert(hash, p.clone());
            }
            None => {
                cache.remove(&hash);
            }
        }
        found
    }

    fn search(&self, hash: &str) -> Option<PathBuf> {
        for bucket in [Bucket::Studio, Bucket::Lottery, Bucket::Inputs] {
            for slot in [Slot::image(bucket.clone()), Slot::thumb(bucket)] {
                if let Some(p) = probe(&self.slot_dir(&slot), hash) {
                    return Some(p);
                }
            }
        }
        for dir in self.album_dirs() {
            for sub in [dir.clone(), dir.join("thumbs")] {
                if let Some(p) = probe(&sub, hash) {
                    return Some(p);
                }
            }
        }
        let legacy = self.legacy_path(hash);
        legacy.is_file().then_some(legacy)
    }

    fn album_dirs(&self) -> Vec<PathBuf> {
        let Ok(rd) = std::fs::read_dir(self.root.join("favorites")) else {
            return vec![];
        };
        rd.flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect()
    }

    pub fn get(&self, hash: &str) -> Option<Vec<u8>> {
        std::fs::read(self.find(hash)?).ok()
    }

    pub fn exists(&self, hash: &str) -> bool {
        self.find(hash).is_some()
    }

    /// 文件内容和哈希对得上（任何一个桶里的那份都算）。
    pub fn verify(&self, hash: &str) -> bool {
        self.find(hash).is_some_and(|p| verify_file(&p, hash))
    }

    /// 磁盘上出现过的哈希，去重后按字典序。
    pub fn iter_hashes(&self) -> Vec<String> {
        let mut set = BTreeSet::new();
        for file in self.files().into_iter().chain(self.legacy_files()) {
            set.insert(file.hash);
        }
        set.into_iter().collect()
    }

    /// 按调用方给的哈希写入。对不上就不写，返回 false。
    pub fn import_verified(&self, slot: &Slot, hash: &str, data: &[u8]) -> Res<bool> {
        let hash = hash.to_lowercase();
        if sha256_bytes(data) != hash {
            return Ok(false);
        }
        if !self.has(slot, &hash) {
            write_atomic(
                &self.slot_dir(slot),
                &format!("{hash}.{}", file_ext(data)),
                data,
            )?;
        }
        Ok(true)
    }

    /// 旧扁平格式的图片先落到旧目录，整理时再按引用拆进各桶。
    pub fn import_legacy(&self, hash: &str, data: &[u8]) -> Res<bool> {
        let hash = hash.to_lowercase();
        if sha256_bytes(data) != hash {
            return Ok(false);
        }
        let path = self.legacy_path(&hash);
        if path.is_file() {
            return Ok(true);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_file_name(format!(".{hash}.{}.tmp", new_hex(8)));
        std::fs::write(&tmp, data)?;
        if std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            if !path.is_file() {
                std::fs::write(&path, data)?;
            }
        }
        Ok(true)
    }

    /// 各桶里的全部文件（不含旧目录）。
    pub fn files(&self) -> Vec<BlobFile> {
        let mut out = Vec::new();
        let mut buckets = vec![Bucket::Studio, Bucket::Lottery, Bucket::Inputs];
        for dir in self.album_dirs() {
            if let Some(name) = dir.file_name().map(|n| n.to_string_lossy().to_string()) {
                buckets.push(Bucket::Favorites(name));
            }
        }
        for bucket in buckets {
            for slot in [Slot::image(bucket.clone()), Slot::thumb(bucket)] {
                let Ok(rd) = std::fs::read_dir(self.slot_dir(&slot)) else {
                    continue;
                };
                for e in rd.flatten() {
                    let Some(hash) = hash_of_name(&e.file_name().to_string_lossy()) else {
                        continue;
                    };
                    let Ok(meta) = e.metadata() else { continue };
                    if meta.is_file() {
                        out.push(BlobFile {
                            slot: Some(slot.clone()),
                            hash,
                            path: e.path(),
                            size: meta.len(),
                        });
                    }
                }
            }
        }
        out
    }

    /// 旧扁平目录里的全部文件。
    pub fn legacy_files(&self) -> Vec<BlobFile> {
        let mut out = Vec::new();
        let Ok(top) = std::fs::read_dir(&self.legacy) else {
            return out;
        };
        for dir in top.flatten() {
            let Ok(rd) = std::fs::read_dir(dir.path()) else {
                continue;
            };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !is_hash64(&name) {
                    continue;
                }
                let Ok(meta) = e.metadata() else { continue };
                if meta.is_file() {
                    out.push(BlobFile {
                        slot: None,
                        hash: name,
                        path: e.path(),
                        size: meta.len(),
                    });
                }
            }
        }
        out
    }

    /// 删掉空的收藏夹目录和清空了的旧目录。
    pub fn prune_dirs(&self) {
        for dir in self.album_dirs() {
            let _ = std::fs::remove_dir(dir.join("thumbs"));
            let _ = std::fs::remove_dir(&dir);
        }
        if let Ok(top) = std::fs::read_dir(&self.legacy) {
            for dir in top.flatten() {
                let _ = std::fs::remove_dir(dir.path());
            }
        }
        let _ = std::fs::remove_dir(&self.legacy);
    }
}

fn probe(dir: &Path, hash: &str) -> Option<PathBuf> {
    EXTS.iter()
        .map(|ext| dir.join(format!("{hash}.{ext}")))
        .find(|p| p.is_file())
}

/// 先写临时文件再改名，避免崩溃时留下半截文件（哈希对不上）。
fn write_atomic(dir: &Path, name: &str, data: &[u8]) -> Res<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(name);
    if path.is_file() {
        return Ok(path);
    }
    let tmp = dir.join(format!(".{name}.{}.tmp", new_hex(8)));
    std::fs::write(&tmp, data)?;
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        if !path.is_file() {
            std::fs::write(&path, data)?;
        }
    }
    Ok(path)
}

/// 文件内容和哈希对得上。
pub fn verify_file(path: &Path, hash: &str) -> bool {
    match std::fs::read(path) {
        Ok(data) => sha256_bytes(&data) == hash.to_lowercase(),
        Err(_) => false,
    }
}

pub fn png_size(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 || &data[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
    let h = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
    Some((w, h))
}

pub fn sniff_mime(data: &[u8]) -> &'static str {
    if data.len() >= 8 && &data[..8] == b"\x89PNG\r\n\x1a\n" {
        "image/png"
    } else if data.len() >= 2 && data[0] == 0xff && data[1] == 0xd8 {
        "image/jpeg"
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

/// 长边缩到 `max_size` 以内（不放大）的 WEBP 缩略图；解码失败返回 None。
pub fn make_thumb(data: &[u8], max_size: u32, quality: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(data).ok()?;
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let longest = w.max(h);
    let img = if longest > max_size {
        let scale = max_size as f64 / longest as f64;
        let nw = ((w as f64 * scale).round() as u32).max(1);
        let nh = ((h as f64 * scale).round() as u32).max(1);
        img.resize_exact(nw, nh, FilterType::CatmullRom)
    } else {
        img
    };
    let (tw, th) = img.dimensions();
    let q = quality as f32;
    let out = if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        webp::Encoder::from_rgba(rgba.as_raw(), tw, th)
            .encode(q)
            .to_vec()
    } else {
        let rgb = img.to_rgb8();
        webp::Encoder::from_rgb(rgb.as_raw(), tw, th)
            .encode(q)
            .to_vec()
    };
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_labels_roundtrip() {
        for slot in [
            Slot::image(Bucket::Studio),
            Slot::thumb(Bucket::Lottery),
            Slot::image(Bucket::Inputs),
            Slot::image(Bucket::Favorites("default".into())),
            Slot::thumb(Bucket::Favorites("testset-1".into())),
            Slot::image(Bucket::Favorites("thumbs".into())),
        ] {
            assert_eq!(
                Slot::parse(&slot.label()),
                Some(slot.clone()),
                "{}",
                slot.label()
            );
        }
        assert_eq!(Slot::parse("favorites/../x"), None);
        assert_eq!(Slot::parse("favorites/"), None);
        assert_eq!(Slot::parse("other"), None);
    }

    #[test]
    fn job_bucket_follows_source() {
        let client = serde_json::json!({"testSetId": "testset-a", "targetAlbumId": "single"});
        assert_eq!(
            Bucket::for_job("gallery", &client),
            Bucket::Favorites("testset-a".into())
        );
        assert_eq!(
            Bucket::for_job("gallery", &serde_json::json!({"targetAlbumId": "single"})),
            Bucket::Favorites("single".into())
        );
        assert_eq!(
            Bucket::for_job("gallery", &serde_json::json!({})),
            Bucket::Studio
        );
        assert_eq!(Bucket::for_job("lottery", &client), Bucket::Lottery);
        assert_eq!(Bucket::for_job("studio", &client), Bucket::Studio);
    }

    #[test]
    fn put_find_copy_remove() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let data = b"\x89PNG\r\n\x1a\nnot really a png".to_vec();
        let hash = store.put(&Bucket::Studio, &data).unwrap();
        let path = store.path_in(&Slot::image(Bucket::Studio), &hash).unwrap();
        assert!(path.ends_with(format!("studio/{hash}.png")));
        assert_eq!(store.find(&hash), Some(path.clone()));

        let fav = Slot::image(Bucket::Favorites("default".into()));
        assert!(store.copy_into(&fav, &hash).unwrap());
        assert!(store.has(&fav, &hash));
        assert!(store.remove(&Slot::image(Bucket::Studio), &hash) > 0);
        assert!(!path.exists());
        assert_eq!(store.get(&hash).unwrap(), data, "收藏夹里那份还在");
        assert_eq!(store.files().len(), 1);

        // 旧扁平目录只读兜底，整理时整份挪走。
        let old = b"legacy bytes".to_vec();
        let old_hash = sha256_bytes(&old);
        let legacy = store.legacy_path(&old_hash);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, &old).unwrap();
        assert_eq!(store.get(&old_hash).unwrap(), old);
        assert!(store
            .move_legacy(&Slot::image(Bucket::Lottery), &old_hash)
            .unwrap());
        assert!(!legacy.exists());
        assert!(store.has(&Slot::image(Bucket::Lottery), &old_hash));
        store.prune_dirs();
        assert!(!store.legacy.exists());
    }
}
