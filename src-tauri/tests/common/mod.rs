//! 集成测试共用的小工具：临时数据目录里装配一整套服务，以及最小的测试图。
#![allow(dead_code)]

use image::{ImageFormat, Rgb, RgbImage};
use serde_json::Value;
use std::io::Cursor;
use std::path::Path;
use workbench_lib::app::{self, Services};
use workbench_lib::contexts::gallery::application::ImportOptions;
use workbench_lib::kernel::{DomainError, Res};

/// 装配服务并做启动准备（默认收藏夹 + 单画师收藏夹）。
pub fn boot(dir: &Path) -> Services {
    let svc = app::build(dir).expect("装配服务");
    app::prepare(&svc, None).expect("启动准备");
    svc
}

/// 只装配、不建默认收藏夹（对应 Python 测试里直接 new 出来的服务）。
pub fn bare(dir: &Path) -> Services {
    app::build(dir).expect("装配服务")
}

/// 1x1 的合法 PNG，`n` 不同则哈希不同。
pub fn png(n: u8) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    v.extend_from_slice(b"\x00\x00\x00\rIHDR");
    v.extend_from_slice(&1u32.to_be_bytes());
    v.extend_from_slice(&1u32.to_be_bytes());
    v.extend_from_slice(b"\x08\x02\x00\x00\x00");
    v.extend_from_slice(b"\x90wS\xde");
    v.push(n);
    v.extend_from_slice(b"\x00\x00\x00\x00IEND\xaeB`\x82");
    v
}

/// 纯色图，`fmt` 为 png / jpeg。
pub fn image(size: (u32, u32), fmt: ImageFormat) -> Vec<u8> {
    let img = RgbImage::from_pixel(size.0, size.1, Rgb([10, 120, 200]));
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, fmt).expect("编码图片");
    buf.into_inner()
}

pub fn png_image(size: (u32, u32)) -> Vec<u8> {
    image(size, ImageFormat::Png)
}

pub fn import(svc: &Services, album_id: &str, data: &[u8], meta: Value) -> Res<Value> {
    svc.gallery.import_bytes(album_id, data, &meta, ImportOptions { thumb: None, command_id: None, item_id: None })
}

/// 取出错误信息，断言「这里必须失败」。
pub fn err<T: std::fmt::Debug>(r: Result<T, DomainError>) -> String {
    match r {
        Ok(v) => panic!("期望失败，却成功了：{v:?}"),
        Err(e) => e.message,
    }
}

pub fn names(items: &[Value]) -> Vec<String> {
    items.iter().map(|i| i["name"].as_str().unwrap_or("").to_string()).collect()
}

pub fn ids(items: &[Value]) -> Vec<String> {
    items.iter().map(|i| i["id"].as_str().unwrap_or("").to_string()).collect()
}