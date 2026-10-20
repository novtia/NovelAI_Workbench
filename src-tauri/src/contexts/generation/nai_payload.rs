//! NovelAI 请求参数构造与 Anlas 估算，逐条对应 Python 版 `nai_client.py` 里不涉及网络和图像的部分。

use crate::contexts::lottery::algorithm::pad_numeric_closers;
use crate::util::{get, num_f, py_str, to_float, to_int, truthy};
use serde_json::{json, Map, Value};

pub const IMAGE_API: &str = "https://image.novelai.net";
pub const FULL_MODEL: &str = "nai-diffusion-5-full";
pub const MEDIUM_MODEL: &str = "nai-diffusion-5-full-medium";
pub const CURATED_MODEL: &str = "nai-diffusion-5-curated";
pub const MODELS: [&str; 3] = [FULL_MODEL, MEDIUM_MODEL, CURATED_MODEL];
pub const SAMPLERS: [&str; 6] =
    ["k_euler_ancestral", "k_euler", "k_dpmpp_2s_ancestral", "k_dpmpp_2m", "k_dpmpp_2m_sde", "k_dpmpp_sde"];
pub const SCHEDULES: [&str; 4] = ["karras", "native", "exponential", "polyexponential"];

pub const QUALITY_PRESETS: [(&str, &str); 3] = [
    ("off", ""),
    ("official", "very aesthetic, masterpiece, no text"),
    ("gallery", "ultra complexity, very aesthetic, best quality, amazing quality, absurdres"),
];

pub const UC_PRESETS: [(&str, &str); 3] = [
    (
        "heavy",
        "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
    ),
    (
        "comic",
        "worst quality, bad quality, blurry, watermark, bad anatomy, extra fingers, ugly, fused face, cropped, jpeg artifacts, mutation, extra legs, missing fingers, poorly drawn hands, extra arms",
    ),
    ("none", ""),
];

pub fn uc_presets_json() -> Value {
    let mut m = Map::new();
    for (k, v) in UC_PRESETS {
        m.insert(k.to_string(), json!(v));
    }
    Value::Object(m)
}

pub const MAX_CHARS: usize = 22;
pub const JOB_KINDS: [&str; 6] = ["generate", "img2img", "variation", "infill", "enhance", "upscale"];
pub const IMAGE_KINDS: [&str; 4] = ["img2img", "variation", "infill", "enhance"];
pub const VARIATION_SAMPLES: i64 = 3;
pub const VARIATION_STRENGTH: f64 = 0.6;
pub const VARIATION_NOISE: f64 = 0.0;
pub const UPSCALE_DEFAULT: i64 = 2;
pub const INPAINT_SUFFIX: &str = "-inpainting";
pub const ENHANCE_TAIL: &str = "-2::upscaled, blurry::";
pub const ENHANCE_NOISE: f64 = 0.0;

pub fn enhance_strength(magnitude: i64) -> f64 {
    match magnitude {
        1 => 0.4,
        2 => 0.5,
        3 => 0.6,
        4 => 0.7,
        _ => 0.8,
    }
}

fn enhance_scale(amount: &str) -> Option<f64> {
    match amount {
        "1x" => Some(1.0),
        "1.5x" => Some(1.5),
        "max" => Some(1.0),
        _ => None,
    }
}

const ANLAS_PIXEL_COEF: f64 = 2.951823174884865e-6;
const ANLAS_STEP_COEF: f64 = 5.753298233447344e-7;
const ANLAS_MIN_PIXELS: i64 = 64 * 1024;
const ANLAS_I2I_MIN: i64 = 2;
const ANLAS_UPSCALE_UNIT_PIXELS: i64 = 1024 * 1024;
const ENHANCE_MAX_PIXELS: i64 = 1536 * 2048;
const ENHANCE_BILL_STEPS: i64 = 28;
const OPUS_FREE_PIXELS: i64 = 1024 * 1024;
const OPUS_FREE_STEPS: i64 = 28;

fn enhance_bill_factor(magnitude: i64) -> f64 {
    match magnitude {
        1 => 0.23,
        2 => 0.45,
        3 => 0.566,
        4 => 0.68,
        5 => 0.8,
        _ => 0.45,
    }
}

#[derive(Debug, Clone)]
pub struct NaiError {
    pub status: u16,
    pub message: String,
}

impl NaiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        NaiError { status, message: message.into() }
    }
}

impl std::fmt::Display for NaiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

pub type NaiRes<T> = Result<T, NaiError>;

pub fn token_hint(token: &str) -> String {
    let token = token.trim();
    let n = token.chars().count();
    if n < 8 {
        return "已保存".into();
    }
    let tail: String = token.chars().skip(n - 4).collect();
    format!("••••{tail}")
}

pub fn snap64(value: i64) -> i64 {
    let v = value.clamp(64, 2048);
    64.max((v / 64) * 64)
}

/// `int(body.get(key) or default)`
fn int_or(body: &Value, key: &str, default: i64) -> NaiRes<i64> {
    let v = get(body, key);
    if !truthy(v) {
        return Ok(default);
    }
    to_int(v).ok_or_else(|| NaiError::new(400, format!("参数 {key} 格式错误")))
}

fn str_or(body: &Value, key: &str, default: &str) -> String {
    let v = get(body, key);
    if truthy(v) { py_str(v) } else { default.to_string() }
}

fn join(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| p.trim().trim_matches(',').to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn quality_of(key: &str) -> Option<&'static str> {
    QUALITY_PRESETS.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

pub fn assemble_prompt(body: &Value) -> (String, String) {
    let prompt = str_or(body, "prompt", "").trim().to_string();
    let artist_src = {
        let a = get(body, "artists");
        if truthy(a) { py_str(a) } else { str_or(body, "artistLine", "") }
    };
    let artists = pad_numeric_closers(artist_src.trim());
    let mut quality_key = str_or(body, "quality", "gallery");
    if quality_of(&quality_key).is_none() {
        quality_key = "gallery".into();
    }
    let mut quality = quality_of(&quality_key).unwrap_or("");
    let v5_mode = str_or(body, "v5Mode", "anime");
    let prefix = if v5_mode == "furry" { "fur dataset" } else { "" };
    if !quality.is_empty() && prompt.to_lowercase().contains(&quality.to_lowercase()) {
        quality = "";
    }
    let combined = join(&[prefix, quality, &artists, &prompt]);
    let uc = str_or(body, "uc", "").trim().to_string();
    (combined, uc)
}

struct Character {
    prompt: String,
    uc: String,
    x: f64,
    y: f64,
}

fn characters(body: &Value) -> Vec<Character> {
    let Some(raw) = get(body, "characters").as_array() else { return vec![] };
    let mut out = Vec::new();
    for item in raw.iter().take(MAX_CHARS) {
        if !item.is_object() {
            continue;
        }
        let prompt = str_or(item, "prompt", "").trim().to_string();
        if prompt.is_empty() {
            continue;
        }
        let coord = |key: &str| -> Option<f64> {
            match item.get(key) {
                None => Some(0.5),
                Some(v) => to_float(v),
            }
        };
        let (x, y) = match (coord("x"), coord("y")) {
            (Some(x), Some(y)) => (x, y),
            _ => (0.5, 0.5),
        };
        out.push(Character {
            prompt,
            uc: str_or(item, "uc", "").trim().to_string(),
            x: x.clamp(0.0, 1.0),
            y: y.clamp(0.0, 1.0),
        });
    }
    out
}

fn center(c: &Character) -> Value {
    json!({"x": num_f(c.x), "y": num_f(c.y)})
}

/// V5 Full 的节约模式走蒸馏模型，不看界面上另存的步数和采样器。
pub fn uses_medium(body: &Value) -> bool {
    let raw = str_or(body, "model", FULL_MODEL);
    if raw == MEDIUM_MODEL {
        return true;
    }
    raw == FULL_MODEL && str_or(body, "effort", "") == "medium"
}

pub fn resolve_model(body: &Value) -> NaiRes<(String, &'static str)> {
    let raw = str_or(body, "model", FULL_MODEL);
    if !MODELS.contains(&raw.as_str()) {
        return Err(NaiError::new(400, "仅支持 NovelAI V5 模型"));
    }
    if uses_medium(body) {
        return Ok((MEDIUM_MODEL.to_string(), "medium"));
    }
    Ok((raw, "high"))
}

fn random_seed() -> i64 {
    (uuid::Uuid::new_v4().as_u128() & 0xFFFF_FFFF) as i64
}

fn bool_of(v: &Value) -> bool {
    truthy(v)
}

pub fn build_payload(body: &Value) -> NaiRes<(Value, Value)> {
    let (model, effort) = resolve_model(body)?;
    let medium = effort == "medium";
    let (prompt, mut uc) = assemble_prompt(body);
    if prompt.is_empty() {
        return Err(NaiError::new(400, "Prompt 不能为空"));
    }
    let width = snap64(int_or(body, "width", 832)?);
    let height = snap64(int_or(body, "height", 1216)?);
    let steps = if medium { 14 } else { int_or(body, "steps", 28)?.clamp(1, 50).max(1) };
    let scale = {
        let v = get(body, "scale");
        let f = if v.is_null() { 5.0 } else { to_float(v).ok_or_else(|| NaiError::new(400, "参数 scale 格式错误"))? };
        f.clamp(0.0, 30.0)
    };
    let cfg_rescale = if medium {
        0.0
    } else {
        let v = get(body, "cfgRescale");
        let f = if truthy(v) { to_float(v).ok_or_else(|| NaiError::new(400, "参数 cfgRescale 格式错误"))? } else { 0.0 };
        f.clamp(0.0, 1.0)
    };
    let n_samples = int_or(body, "nSamples", 1)?.clamp(1, 4);
    let sampler = if medium { "k_euler_ancestral".to_string() } else { str_or(body, "sampler", "k_euler_ancestral") };
    if !SAMPLERS.contains(&sampler.as_str()) {
        return Err(NaiError::new(400, "不支持的 sampler"));
    }
    let mut schedule = if medium { "karras".to_string() } else { str_or(body, "noiseSchedule", "karras") };
    if !SCHEDULES.contains(&schedule.as_str()) {
        return Err(NaiError::new(400, "不支持的 noise schedule"));
    }
    if schedule == "native" {
        schedule = "karras".into();
    }
    if medium {
        uc = String::new();
    }
    let mut seed = to_int(get(body, "seed")).unwrap_or(-1);
    if seed < 0 {
        seed = random_seed();
    }
    seed = seed.rem_euclid(1 << 32);
    let mut chars = characters(body);
    if medium {
        for c in chars.iter_mut() {
            c.uc = String::new();
        }
    }
    let use_coords_raw = get(body, "useCoords");
    let use_coords = if use_coords_raw.is_null() {
        chars.iter().any(|c| c.x != 0.5 || c.y != 0.5)
    } else {
        bool_of(use_coords_raw)
    };
    let char_captions: Vec<Value> =
        chars.iter().map(|c| json!({"char_caption": c.prompt, "centers": [center(c)]})).collect();
    let neg_captions: Vec<Value> =
        chars.iter().map(|c| json!({"char_caption": c.uc, "centers": [center(c)]})).collect();
    let straight_alpha_raw = get(body, "straightAlpha");
    let straight_alpha = if straight_alpha_raw.is_null() { true } else { bool_of(straight_alpha_raw) };
    let prefer_brownian = if medium {
        true
    } else {
        match body.get("preferBrownian") {
            None => true,
            Some(v) => bool_of(v),
        }
    };
    let v4_prompt = json!({
        "caption": {"base_caption": prompt, "char_captions": char_captions},
        "use_coords": use_coords,
        "use_order": true,
        "legacy_uc": false,
    });
    let v4_negative = json!({
        "caption": {"base_caption": uc, "char_captions": neg_captions},
        "legacy_uc": false,
    });
    let mut parameters = json!({
        "params_version": 4,
        "width": width,
        "height": height,
        "scale": num_f(scale),
        "sampler": sampler,
        "steps": steps,
        "seed": seed,
        "n_samples": n_samples,
        "extra_noise_seed": seed,
        "noise_schedule": schedule,
        "negative_prompt": uc,
        "legacy": false,
        "legacy_uc": false,
        "legacy_v3_extend": false,
        "prefer_brownian": prefer_brownian,
        "deliberate_euler_ancestral_bug": false,
        "dynamic_thresholding": bool_of(get(body, "decrisp")),
        "controlnet_strength": 1,
        "use_coords": use_coords,
        "ucPresetId": "none",
        "qualityPresetId": "standard",
        "tag_hint_qt": 1,
        "tag_hint_uc_preset": 2,
        "normalize_reference_strength_multiple": true,
        "straight_alpha": straight_alpha,
        "image_format": "png",
        "inpaintImg2ImgStrength": 1,
        "add_original_image": true,
        "v4_prompt": v4_prompt.clone(),
        "v4_negative_prompt": v4_negative.clone(),
    });
    if !medium {
        parameters["cfg_rescale"] = num_f(cfg_rescale);
    }
    if !chars.is_empty() {
        parameters["characterPrompts"] = Value::Array(
            chars
                .iter()
                .map(|c| json!({"prompt": c.prompt, "uc": c.uc, "center": center(c), "enabled": true}))
                .collect(),
        );
    }
    let payload = json!({"input": prompt, "model": model, "action": "generate", "parameters": parameters});
    let meta_chars: Vec<Value> =
        chars.iter().map(|c| json!({"prompt": c.prompt, "uc": c.uc, "center": center(c)})).collect();
    let meta = json!({
        "prompt": prompt,
        "uc": uc,
        "model": model,
        "effort": effort,
        "width": width,
        "height": height,
        "steps": steps,
        "sampler": sampler,
        "scale": num_f(scale),
        "seed": seed,
        "noiseSchedule": schedule,
        "cfgRescale": num_f(cfg_rescale),
        "nSamples": n_samples,
        "useCoords": use_coords,
        "v5Mode": str_or(body, "v5Mode", "anime"),
        "quality": str_or(body, "quality", "gallery"),
        "characters": meta_chars,
        "v4Prompt": v4_prompt,
        "v4Negative": v4_negative,
        "software": "NovelAI",
        "source": "nai-v5",
        "requestType": "generate",
        "straightAlpha": straight_alpha,
    });
    Ok((payload, meta))
}

/// 取最接近的 64 倍数，NAI 要求图片与蒙版的宽高都对齐 64。
pub fn fit64(value: f64) -> i64 {
    64.max(2048.min((value / 64.0 + 0.5) as i64 * 64))
}

/// `_clamp(value, lo, hi, default)`：非数字和 NaN 都回到默认值。
pub fn clamp_num(v: &Value, lo: f64, hi: f64, default: f64) -> f64 {
    let n = to_float(v).unwrap_or(default);
    let n = if n.is_nan() { default } else { n };
    n.max(lo).min(hi)
}

#[derive(Debug, Clone)]
pub struct EnhanceParams {
    pub magnitude: i64,
    pub upscale_amount: String,
    pub scale: f64,
    pub strength: f64,
    pub noise: f64,
    pub upscaled_enhance: bool,
}

/// Enhance 面板参数 -> strength / noise / 放大倍数。显式给了 strength/noise 时以显式值为准。
pub fn enhance_params(body: &Value) -> EnhanceParams {
    let mag_v = body.get("magnitude").cloned().unwrap_or(json!(2));
    let magnitude = clamp_num(&mag_v, 1.0, 5.0, 2.0) as i64;
    let mut amount = str_or(body, "upscaleAmount", "1x").to_lowercase();
    if enhance_scale(&amount).is_none() {
        amount = "1x".into();
    }
    let strength = get(body, "strength");
    let noise = get(body, "noise");
    let strength_v = if strength.is_null() { num_f(enhance_strength(magnitude)) } else { strength.clone() };
    let noise_v = if noise.is_null() { num_f(ENHANCE_NOISE) } else { noise.clone() };
    EnhanceParams {
        magnitude,
        scale: enhance_scale(&amount).unwrap_or(1.0),
        strength: clamp_num(&strength_v, 0.01, 0.99, 0.5),
        noise: clamp_num(&noise_v, 0.0, 0.99, 0.0),
        upscaled_enhance: amount == "max",
        upscale_amount: amount,
    }
}

pub fn upscale_factor(_body: &Value) -> i64 {
    UPSCALE_DEFAULT
}

pub fn upscale_model(model: &Value) -> String {
    match model.as_str() {
        Some(m) if m == FULL_MODEL || m == CURATED_MODEL => m.to_string(),
        _ => CURATED_MODEL.to_string(),
    }
}

pub fn plan_size(kind: &str, body: &Value, src_w: i64, src_h: i64) -> (i64, i64) {
    if kind == "upscale" {
        let f = upscale_factor(body);
        return (src_w * f, src_h * f);
    }
    if kind == "enhance" {
        let p = enhance_params(body);
        return enhance_output_size(src_w, src_h, &p.upscale_amount);
    }
    (fit64(src_w as f64), fit64(src_h as f64))
}

fn base_cost(width: i64, height: i64, steps: i64) -> i64 {
    let pixels = (width * height).max(ANLAS_MIN_PIXELS) as f64;
    1.max((ANLAS_PIXEL_COEF * pixels + ANLAS_STEP_COEF * pixels * steps as f64).ceil() as i64)
}

pub fn i2i_cost(width: i64, height: i64, steps: i64, strength: f64, samples: i64) -> i64 {
    let per = ANLAS_I2I_MIN.max((base_cost(width, height, steps) as f64 * strength).ceil() as i64);
    per * samples.max(1)
}

pub fn upscale_cost(width: i64, height: i64) -> i64 {
    1.max((((width * height) as f64) / ANLAS_UPSCALE_UNIT_PIXELS as f64).ceil() as i64)
}

pub fn enhance_output_size(width: i64, height: i64, amount: &str) -> (i64, i64) {
    let (width, height) = (width.max(1), height.max(1));
    if amount == "1.5x" {
        return (fit64(width as f64 * 1.5), fit64(height as f64 * 1.5));
    }
    if amount == "max" && width * height < ENHANCE_MAX_PIXELS {
        let factor = (ENHANCE_MAX_PIXELS as f64 / (width * height) as f64).sqrt();
        return ((width as f64 * factor).floor() as i64, (height as f64 * factor).floor() as i64);
    }
    (width, height)
}

pub fn enhance_cost(
    width: i64,
    height: i64,
    magnitude: i64,
    amount: &str,
    strength: f64,
    explicit: bool,
    opus: bool,
) -> i64 {
    let (ow, oh) = enhance_output_size(width, height, amount);
    if opus && ow * oh <= OPUS_FREE_PIXELS {
        return 0;
    }
    let factor = if explicit { strength } else { enhance_bill_factor(magnitude) };
    ANLAS_I2I_MIN.max((base_cost(ow, oh, ENHANCE_BILL_STEPS) as f64 * factor).ceil() as i64)
}

fn snap_from(v: &Value, fallback: i64) -> i64 {
    snap64(if truthy(v) { to_int(v).unwrap_or(fallback) } else { fallback })
}

pub fn generate_cost(body: &Value, steps: i64) -> i64 {
    let gw_raw = if truthy(get(body, "genWidth")) { get(body, "genWidth") } else { get(body, "width") };
    let gh_raw = if truthy(get(body, "genHeight")) { get(body, "genHeight") } else { get(body, "height") };
    let gw = snap_from(gw_raw, 832);
    let gh = snap_from(gh_raw, 1216);
    let mut samples = clamp_num(get(body, "genSamples"), 1.0, 4.0, 1.0) as i64;
    let mut per = base_cost(gw, gh, steps);
    if !get(body, "genStrength").is_null() {
        let s = clamp_num(get(body, "genStrength"), 0.01, 0.99, 0.7);
        per = ANLAS_I2I_MIN.max((per as f64 * s).ceil() as i64);
    }
    if truthy(get(body, "opus")) && gw * gh <= OPUS_FREE_PIXELS && steps <= OPUS_FREE_STEPS {
        samples -= 1;
    }
    per * samples.max(0)
}

fn fit_from(v: &Value, fallback: i64) -> i64 {
    fit64(if truthy(v) { to_float(v).unwrap_or(fallback as f64) } else { fallback as f64 })
}

/// 工具栏按钮旁边的 Anlas 估算：width/height 是当前图的尺寸。
pub fn estimate_costs(body: &Value) -> Value {
    let width = fit_from(get(body, "width"), 832);
    let height = fit_from(get(body, "height"), 1216);
    let steps = (if uses_medium(body) { 14 } else { clamp_num(get(body, "steps"), 1.0, 50.0, 28.0) as i64 }).max(1);
    let variation = i2i_cost(
        width,
        height,
        steps,
        clamp_num(get(body, "variationStrength"), 0.01, 0.99, VARIATION_STRENGTH),
        VARIATION_SAMPLES,
    );
    let enh = enhance_params(body);
    let enhance = enhance_cost(
        width,
        height,
        enh.magnitude,
        &enh.upscale_amount,
        enh.strength,
        !get(body, "strength").is_null(),
        truthy(get(body, "opus")),
    );
    json!({
        "generate": generate_cost(body, steps),
        "variation": variation,
        "upscale": upscale_cost(width, height),
        "enhance": enhance,
        "upscaleScale": upscale_factor(body),
        "estimated": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snap_and_fit() {
        assert_eq!(snap64(833), 832);
        assert_eq!(snap64(10), 64);
        assert_eq!(fit64(100.0), 128);
        assert_eq!(fit64(95.9), 64);
    }

    #[test]
    fn payload_basics() {
        let body = json!({"prompt": "1girl", "artists": "artist:foo", "seed": 7, "width": 833});
        let (payload, meta) = build_payload(&body).unwrap();
        assert_eq!(payload["parameters"]["width"], 832);
        assert_eq!(payload["parameters"]["seed"], 7);
        assert_eq!(meta["effort"], "high");
        assert!(payload["input"].as_str().unwrap().contains("artist:foo, 1girl"));
        assert!(build_payload(&json!({"prompt": "", "quality": "off"})).is_err());
    }

    #[test]
    fn medium_clears_negative() {
        let body = json!({"prompt": "x", "uc": "bad", "effort": "medium", "steps": 40});
        let (payload, _) = build_payload(&body).unwrap();
        assert_eq!(payload["model"], MEDIUM_MODEL);
        assert_eq!(payload["parameters"]["steps"], 14);
        assert_eq!(payload["parameters"]["negative_prompt"], "");
        assert!(payload["parameters"].get("cfg_rescale").is_none());
    }

    #[test]
    fn anlas_calibration() {
        // 官方截图校准：832x1216 / 28 步 / 3 张 / strength 0.6 = 36
        assert_eq!(i2i_cost(832, 1216, 28, 0.6, 3), 36);
    }
}
