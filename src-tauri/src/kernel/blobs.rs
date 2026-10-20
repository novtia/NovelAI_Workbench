use super::errors::Res;
use super::hashes::sha256_bytes;
use image::imageops::FilterType;
use image::GenericImageView;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// 返回 (最大边, WEBP 质量)；由设置服务注入，没注入时用默认值。
pub type ThumbProvider = Arc<dyn Fn() -> (u32, u32) + Send + Sync>;

pub struct BlobStore {
    pub root: PathBuf,
    thumb_provider: RwLock<Option<ThumbProvider>>,
}

impl BlobStore {
    pub fn new(root: &Path) -> Res<Self> {
        std::fs::create_dir_all(root)?;
        Ok(BlobStore { root: root.to_path_buf(), thumb_provider: RwLock::new(None) })
    }

    pub fn set_thumb_provider(&self, provider: ThumbProvider) {
        *self.thumb_provider.write().unwrap_or_else(|e| e.into_inner()) = Some(provider);
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

    pub fn path_for(&self, digest: &str) -> PathBuf {
        let digest = digest.to_lowercase();
        let head: String = digest.chars().take(2).collect();
        self.root.join(head).join(digest)
    }

    pub fn put(&self, data: &[u8]) -> Res<String> {
        let digest = sha256_bytes(data);
        let path = self.path_for(&digest);
        if !path.exists() {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            // 先写临时文件再改名，避免崩溃时留下半截文件（哈希对不上）。
            let tmp = path.with_file_name(format!("{digest}.tmp{}", std::process::id()));
            std::fs::write(&tmp, data)?;
            if std::fs::rename(&tmp, &path).is_err() {
                let _ = std::fs::remove_file(&tmp);
                if !path.exists() {
                    std::fs::write(&path, data)?;
                }
            }
        }
        Ok(digest)
    }

    pub fn get(&self, digest: &str) -> Option<Vec<u8>> {
        let path = self.path_for(digest);
        if !path.is_file() {
            return None;
        }
        std::fs::read(path).ok()
    }

    pub fn exists(&self, digest: &str) -> bool {
        self.path_for(digest).is_file()
    }

    pub fn verify(&self, digest: &str) -> bool {
        match self.get(digest) {
            Some(data) => sha256_bytes(&data) == digest.to_lowercase(),
            None => false,
        }
    }

    pub fn iter_hashes(&self) -> Vec<String> {
        let mut out = Vec::new();
        let Ok(top) = std::fs::read_dir(&self.root) else {
            return out;
        };
        for dir in top.flatten() {
            if !dir.path().is_dir() {
                continue;
            }
            if let Ok(files) = std::fs::read_dir(dir.path()) {
                for f in files.flatten() {
                    let name = f.file_name().to_string_lossy().to_string();
                    if name.len() == 64 && f.path().is_file() {
                        out.push(name);
                    }
                }
            }
        }
        out
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
        webp::Encoder::from_rgba(rgba.as_raw(), tw, th).encode(q).to_vec()
    } else {
        let rgb = img.to_rgb8();
        webp::Encoder::from_rgb(rgb.as_raw(), tw, th).encode(q).to_vec()
    };
    Some(out)
}
