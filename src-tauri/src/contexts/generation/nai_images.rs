//! 图生图 / 局部重绘 / 增强用到的图像处理，对应 Python 版 `nai_client.py` 里基于 PIL 的部分。

use super::nai_payload::*;
use crate::util::{get, num_f, py_str, truthy};
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use base64::engine::DecodePaddingMode;
use base64::{alphabet, Engine};
use image::imageops::{self, FilterType};
use image::{DynamicImage, GrayImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use serde_json::{json, Value};
use std::io::{Cursor, Read};

fn decode(data: &[u8]) -> Result<DynamicImage, ()> {
    image::load_from_memory(data).map_err(|_| ())
}

fn encode_png(img: &DynamicImage) -> Vec<u8> {
    let mut buf = Vec::new();
    let _ = img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png);
    buf
}

/// 透明像素铺白底后转 RGB，公式同 PIL `Image.paste(mask=alpha)`。
pub fn flatten_rgb(data: &[u8], what: &str) -> NaiRes<RgbImage> {
    let img = decode(data).map_err(|_| NaiError::new(400, format!("无法读取{what}")))?;
    if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        let mut out = RgbImage::new(rgba.width(), rgba.height());
        for (x, y, p) in rgba.enumerate_pixels() {
            let a = p[3] as u32;
            let blend = |c: u8| -> u8 {
                let t = c as u32 * a + 255 * (255 - a) + 128;
                (((t >> 8) + t) >> 8) as u8
            };
            out.put_pixel(x, y, Rgb([blend(p[0]), blend(p[1]), blend(p[2])]));
        }
        return Ok(out);
    }
    Ok(img.to_rgb8())
}

pub fn image_to_png(data: &[u8]) -> NaiRes<Vec<u8>> {
    let rgb = flatten_rgb(data, "图片")?;
    Ok(encode_png(&DynamicImage::ImageRgb8(rgb)))
}

fn png_b64(img: &RgbImage) -> String {
    STANDARD.encode(encode_png(&DynamicImage::ImageRgb8(img.clone())))
}

fn luma(p: &[u8]) -> u8 {
    ((p[0] as u32 * 19595 + p[1] as u32 * 38470 + p[2] as u32 * 7471 + 0x8000) >> 16) as u8
}

/// 编辑器存的是不透明黑白图，白即重绘。若透明通道本身有变化，则以不透明处为重绘区。
fn mask_luma(mask: &DynamicImage) -> GrayImage {
    if mask.color().has_alpha() {
        let rgba = mask.to_rgba8();
        let min_alpha = rgba.pixels().map(|p| p[3]).min().unwrap_or(255);
        if min_alpha < 255 {
            let mut out = GrayImage::new(rgba.width(), rgba.height());
            for (x, y, p) in rgba.enumerate_pixels() {
                out.put_pixel(x, y, image::Luma([p[3]]));
            }
            return out;
        }
    }
    let rgb = mask.to_rgb8();
    let mut out = GrayImage::new(rgb.width(), rgb.height());
    for (x, y, p) in rgb.enumerate_pixels() {
        out.put_pixel(x, y, image::Luma([luma(&p.0)]));
    }
    out
}

/// 官方 p0：每个目标像素取源图里对应中心点，不做插值。
fn point_resize(src: &GrayImage, width: u32, height: u32) -> GrayImage {
    let (sw, sh) = src.dimensions();
    let mut out = GrayImage::new(width, height);
    for y in 0..height {
        let sy = (sh - 1).min(((y as f64 + 0.5) * sh as f64 / height as f64) as u32);
        for x in 0..width {
            let sx = (sw - 1).min(((x as f64 + 0.5) * sw as f64 / width as f64) as u32);
            out.put_pixel(x, y, *src.get_pixel(sx, sy));
        }
    }
    out
}

/// 和官网 generateInfill 同一条路径：先缩到 1/8，alpha > 155 才算涂到，再放大回成图尺寸。
/// 返回的 L 图里 255 是要重绘的像素。
pub fn inpaint_mask_luma(mask_bytes: &[u8], width: u32, height: u32) -> NaiRes<GrayImage> {
    let mask = decode(mask_bytes).map_err(|_| NaiError::new(400, "无法读取蒙版"))?;
    let mut small = point_resize(&mask_luma(&mask), (width / 8).max(1), (height / 8).max(1));
    for p in small.pixels_mut() {
        p[0] = if p[0] > 155 { 255 } else { 0 };
    }
    Ok(point_resize(&small, width, height))
}

/// 官网发出去的蒙版是成图原尺寸：重绘处纯白不透明，其余纯黑不透明。
pub fn encode_inpaint_mask(mask_bytes: &[u8], width: u32, height: u32) -> NaiRes<String> {
    let gray = inpaint_mask_luma(mask_bytes, width, height)?;
    let mut rgba = RgbaImage::new(gray.width(), gray.height());
    for (x, y, p) in gray.enumerate_pixels() {
        rgba.put_pixel(x, y, if p[0] != 0 { Rgba([255, 255, 255, 255]) } else { Rgba([0, 0, 0, 255]) });
    }
    Ok(STANDARD.encode(encode_png(&DynamicImage::ImageRgba8(rgba))))
}

/// 官网把 add_original_image 关掉，生成后再把蒙版外的像素贴回原图。
pub fn composite_infill(original: &[u8], generated: &[u8], mask_bytes: &[u8]) -> NaiRes<Vec<u8>> {
    let flat = flatten_rgb(original, "底图")?;
    let (width, height) = (fit64(flat.width() as f64) as u32, fit64(flat.height() as f64) as u32);
    let mut src = DynamicImage::ImageRgb8(flat).to_rgba8();
    if src.dimensions() != (width, height) {
        src = imageops::resize(&src, width, height, FilterType::Lanczos3);
    }
    let gen = decode(generated).map_err(|_| NaiError::new(502, "无法读取重绘结果"))?;
    let mut gen = gen.to_rgba8();
    if gen.dimensions() != (width, height) {
        gen = imageops::resize(&gen, width, height, FilterType::Lanczos3);
    }
    let mask = inpaint_mask_luma(mask_bytes, width, height)?;
    let mut out = RgbaImage::new(width, height);
    for (x, y, p) in out.enumerate_pixels_mut() {
        *p = if mask.get_pixel(x, y)[0] != 0 { *gen.get_pixel(x, y) } else { *src.get_pixel(x, y) };
    }
    Ok(encode_png(&DynamicImage::ImageRgba8(out)))
}

pub fn unzip_images(blob: &[u8]) -> NaiRes<Vec<Vec<u8>>> {
    let mut images = Vec::new();
    if let Ok(mut zf) = zip::ZipArchive::new(Cursor::new(blob)) {
        for i in 0..zf.len() {
            let Ok(mut file) = zf.by_index(i) else { continue };
            if file.is_dir() {
                continue;
            }
            let name = file.name().to_lowercase();
            if [".png", ".webp", ".jpg", ".jpeg"].iter().any(|ext| name.ends_with(ext)) {
                let mut data = Vec::new();
                if file.read_to_end(&mut data).is_ok() {
                    images.push(data);
                }
            }
        }
    }
    if images.is_empty() {
        return Err(NaiError::new(502, "NovelAI 返回的压缩包里没有图片"));
    }
    Ok(images)
}

/// /ai/upscale 可能回 ZIP 也可能直接回 PNG。
pub fn unwrap_image(blob: Vec<u8>) -> NaiRes<Vec<u8>> {
    if blob.starts_with(b"PK") {
        return Ok(unzip_images(&blob)?.remove(0));
    }
    Ok(blob)
}

pub fn decode_image_b64(raw: &str) -> NaiRes<Vec<u8>> {
    let mut text = raw.trim();
    if text.to_lowercase().starts_with("data:") {
        if let Some((_, rest)) = text.split_once(',') {
            text = rest;
        }
    }
    // Python 的 b64decode 会丢弃字母表以外的字符
    let cleaned: String =
        text.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/')).collect();
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    engine.decode(cleaned.as_bytes()).map_err(|_| NaiError::new(502, "无法解码流式图片"))
}

fn clamp_or(body: &Value, key: &str, lo: f64, hi: f64, default: f64) -> f64 {
    clamp_num(get(body, key), lo, hi, default)
}

/// 图生图 / 局部重绘 / 增强：在 build_payload 的基础上换 action 并附上底图与蒙版。
pub fn build_image_payload(body: &Value, image_bytes: &[u8], mask_bytes: Option<&[u8]>) -> NaiRes<(Value, Value)> {
    let kind = if truthy(get(body, "kind")) { py_str(get(body, "kind")) } else { "img2img".into() };
    if !IMAGE_KINDS.contains(&kind.as_str()) {
        return Err(NaiError::new(400, "不支持的图片任务类型"));
    }
    let mask_bytes = mask_bytes.filter(|m| !m.is_empty());
    if kind == "infill" && mask_bytes.is_none() {
        return Err(NaiError::new(400, "局部重绘需要蒙版"));
    }
    let mut src = flatten_rgb(image_bytes, "底图")?;
    let mut work = body.clone();
    let mut enh: Option<EnhanceParams> = None;
    let (strength, noise, width, height);
    if kind == "enhance" {
        let e = enhance_params(body);
        work["nSamples"] = json!(1);
        strength = e.strength;
        noise = e.noise;
        width = fit64(src.width() as f64 * e.scale);
        height = fit64(src.height() as f64 * e.scale);
        enh = Some(e);
    } else if kind == "variation" {
        work["nSamples"] = json!(VARIATION_SAMPLES);
        work["seed"] = json!(-1);
        strength = clamp_or(body, "strength", 0.01, 0.99, VARIATION_STRENGTH);
        noise = clamp_or(body, "noise", 0.0, 0.99, VARIATION_NOISE);
        width = fit64(src.width() as f64);
        height = fit64(src.height() as f64);
    } else {
        strength = clamp_or(body, "strength", 0.01, 0.99, 0.7);
        noise = clamp_or(body, "noise", 0.0, 0.99, 0.0);
        width = fit64(src.width() as f64);
        height = fit64(src.height() as f64);
    }
    if kind == "infill" {
        // 蒸馏的节约模型没有 inpainting 版本，局部重绘一律走 V5 Full / Curated。
        work["effort"] = json!("high");
        if work.get("model").and_then(|m| m.as_str()) == Some(MEDIUM_MODEL) {
            work["model"] = json!(FULL_MODEL);
        }
    }
    work["width"] = json!(width);
    work["height"] = json!(height);
    let (mut payload, mut meta) = build_payload(&work)?;
    if src.dimensions() != (width as u32, height as u32) {
        src = imageops::resize(&src, width as u32, height as u32, FilterType::Lanczos3);
    }
    let seed = payload["parameters"]["seed"].clone();
    {
        let params = &mut payload["parameters"];
        params["image"] = json!(png_b64(&src));
        params["strength"] = num_f(strength);
        params["noise"] = num_f(noise);
        params["extra_noise_seed"] = seed;
        params["add_original_image"] = json!(true);
    }
    payload["action"] = json!(if kind == "infill" { "infill" } else { "img2img" });
    if kind == "infill" {
        // 官网在请求里关掉这项，生成完再自己把蒙版外贴回原图。开着会把笔刷形状涂成色块。
        let strength_i = clamp_or(body, "inpaintStrength", 0.01, 1.0, 1.0);
        let params = &mut payload["parameters"];
        params["add_original_image"] = json!(false);
        params["mask"] = json!(encode_inpaint_mask(mask_bytes.unwrap_or(&[]), width as u32, height as u32)?);
        params["inpaintImg2ImgStrength"] = num_f(strength_i);
        let model = format!("{}{}", payload["model"].as_str().unwrap_or(""), INPAINT_SUFFIX);
        payload["model"] = json!(model);
        meta["model"] = json!(model);
        meta["inpaintStrength"] = num_f(strength_i);
    }
    if let Some(e) = &enh {
        if e.upscale_amount == "1.5x" {
            let input = format!("{}, {}", payload["input"].as_str().unwrap_or(""), ENHANCE_TAIL);
            payload["input"] = json!(input);
            payload["parameters"]["v4_prompt"]["caption"]["base_caption"] = json!(input);
        }
    }
    // meta 里的 v4Prompt 在 build_payload 里已经是追加 ENHANCE_TAIL 之前的副本，与 Python 版一致。
    meta["requestType"] = json!(kind);
    meta["strength"] = num_f(strength);
    meta["noise"] = num_f(noise);
    meta["width"] = json!(width);
    meta["height"] = json!(height);
    meta["sourceHash"] = json!(if truthy(get(body, "imageHash")) { py_str(get(body, "imageHash")) } else { String::new() });
    if let Some(e) = &enh {
        meta["magnitude"] = json!(e.magnitude);
        meta["upscaleAmount"] = json!(e.upscale_amount);
        meta["postUpscale"] = json!(0);
        if e.upscaled_enhance {
            payload["parameters"]["upscaled_enhance"] = json!(true);
            meta["upscaledEnhance"] = json!(true);
        }
    }
    Ok((payload, meta))
}
