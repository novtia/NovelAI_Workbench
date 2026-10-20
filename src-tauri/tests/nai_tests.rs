//! 对应 Python 的 test_nai_payload.py / test_nai_img2img.py。

mod common;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use common::png_image;
use image::{DynamicImage, GenericImageView, GrayImage, ImageFormat, Luma, Rgba, RgbaImage};
use serde_json::{json, Value};
use std::io::{Cursor, Write};
use workbench_lib::contexts::generation::nai_images::{build_image_payload, unwrap_image};
use workbench_lib::contexts::generation::nai_payload::{
    build_payload, enhance_params, fit64, plan_size, uses_medium, ENHANCE_TAIL,
};

fn merge(base: &Value, extra: Value) -> Value {
    let mut out = base.as_object().unwrap().clone();
    for (k, v) in extra.as_object().unwrap() {
        out.insert(k.clone(), v.clone());
    }
    Value::Object(out)
}

fn base() -> Value {
    json!({"prompt": "1girl", "uc": "lowres", "model": "nai-diffusion-5-full", "seed": 5, "steps": 28})
}

fn decode(b64: &Value) -> DynamicImage {
    image::load_from_memory(&STANDARD.decode(b64.as_str().unwrap()).unwrap()).unwrap()
}

fn encode(img: DynamicImage) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, ImageFormat::Png).unwrap();
    buf.into_inner()
}

fn gray_png(size: (u32, u32), value: u8) -> Vec<u8> {
    encode(DynamicImage::ImageLuma8(GrayImage::from_pixel(size.0, size.1, Luma([value]))))
}

// ---------- test_nai_payload.py ----------

#[test]
fn high_keeps_requested_sampler_steps_and_uc() {
    let (payload, meta) = build_payload(&json!({
        "prompt": "1girl", "uc": "lowres", "model": "nai-diffusion-5-full", "effort": "high",
        "steps": 23, "sampler": "k_euler", "cfgRescale": 0.2, "seed": 7,
        "characters": [{"prompt": "girl", "uc": "hat", "x": 0.2, "y": 0.4}],
    }))
    .unwrap();
    let p = &payload["parameters"];
    assert_eq!(payload["model"], "nai-diffusion-5-full");
    assert_eq!(p["steps"], 23);
    assert_eq!(p["sampler"], "k_euler");
    assert_eq!(p["cfg_rescale"].as_f64(), Some(0.2));
    assert_eq!(p["negative_prompt"], "lowres");
    assert_eq!(p["v4_negative_prompt"]["caption"]["char_captions"][0]["char_caption"], "hat");
    assert_eq!(meta["effort"], "high");
}

#[test]
fn medium_switches_model_and_locks_unsupported_settings() {
    let body = json!({
        "prompt": "1girl, silver hair", "uc": "lowres, hat", "model": "nai-diffusion-5-full", "effort": "medium",
        "steps": 28, "sampler": "k_dpmpp_2m", "noiseSchedule": "exponential", "cfgRescale": 0.4, "scale": 6, "seed": 3,
        "characters": [{"prompt": "girl", "uc": "hat", "x": 0.5, "y": 0.5}],
    });
    let (payload, meta) = build_payload(&body).unwrap();
    let p = &payload["parameters"];
    assert_eq!(payload["model"], "nai-diffusion-5-full-medium");
    assert_eq!(p["steps"], 14);
    assert_eq!(p["sampler"], "k_euler_ancestral");
    assert_eq!(p["noise_schedule"], "karras");
    assert_eq!(p["scale"].as_f64(), Some(6.0));
    assert!(p.get("cfg_rescale").is_none());
    assert_eq!(p["negative_prompt"], "");
    assert_eq!(p["v4_negative_prompt"]["caption"]["base_caption"], "");
    assert_eq!(p["v4_negative_prompt"]["caption"]["char_captions"][0]["char_caption"], "");
    assert_eq!(p["prefer_brownian"], true);
    assert_eq!(meta["effort"], "medium");
    assert_eq!(meta["model"], "nai-diffusion-5-full-medium");
    assert!(uses_medium(&json!({"model": "nai-diffusion-5-full", "effort": "medium", "steps": 28})));
}

#[test]
fn curated_ignores_medium_effort() {
    let (payload, meta) = build_payload(
        &json!({"prompt": "cat", "model": "nai-diffusion-5-curated", "effort": "medium", "seed": 1, "uc": "lowres"}),
    )
    .unwrap();
    assert_eq!(payload["model"], "nai-diffusion-5-curated");
    assert_eq!(payload["parameters"]["steps"], 28);
    assert_eq!(payload["parameters"]["negative_prompt"], "lowres");
    assert!(payload["parameters"].get("cfg_rescale").is_some());
    assert_eq!(meta["effort"], "high");
}

#[test]
fn medium_model_id_is_accepted_directly() {
    let (payload, _) = build_payload(
        &json!({"prompt": "cat", "model": "nai-diffusion-5-full-medium", "steps": 30, "seed": 1, "uc": "lowres"}),
    )
    .unwrap();
    assert_eq!(payload["model"], "nai-diffusion-5-full-medium");
    assert_eq!(payload["parameters"]["steps"], 14);
    assert_eq!(payload["parameters"]["negative_prompt"], "");
}

#[test]
fn unknown_model_is_rejected() {
    let e = build_payload(&json!({"prompt": "cat", "model": "nai-diffusion-4-full", "seed": 1})).unwrap_err();
    assert_eq!(e.status, 400);
}

// ---------- test_nai_img2img.py ----------

#[test]
fn fit64_rounds_to_multiple() {
    assert_eq!(fit64(500.0), 512);
    assert_eq!(fit64(700.0), 704);
    assert_eq!(fit64(10.0), 64);
    assert_eq!(fit64(9999.0), 2048);
}

#[test]
fn img2img_payload_aligns_size_and_carries_strength() {
    let body = merge(&base(), json!({"kind": "img2img", "strength": 0.6, "noise": 0.1, "imageHash": "ab"}));
    let (payload, meta) = build_image_payload(&body, &png_image((500, 700)), None).unwrap();
    let p = &payload["parameters"];
    assert_eq!(payload["action"], "img2img");
    assert_eq!(payload["model"], "nai-diffusion-5-full");
    assert_eq!((p["width"].as_i64(), p["height"].as_i64()), (Some(512), Some(704)));
    assert_eq!(decode(&p["image"]).dimensions(), (512, 704));
    assert!(p["strength"].as_f64() == Some(0.6) && p["noise"].as_f64() == Some(0.1));
    assert_eq!(p["extra_noise_seed"], p["seed"]);
    assert_eq!(p["seed"], 5);
    assert!(p.get("mask").is_none());
    assert!(meta["requestType"] == "img2img" && meta["sourceHash"] == "ab");
}

#[test]
fn strength_noise_are_clamped() {
    let body = merge(&base(), json!({"kind": "img2img", "strength": 5, "noise": -1}));
    let (payload, _) = build_image_payload(&body, &png_image((500, 700)), None).unwrap();
    assert_eq!(payload["parameters"]["strength"].as_f64(), Some(0.99));
    assert_eq!(payload["parameters"]["noise"].as_f64(), Some(0.0));
}

#[test]
fn infill_switches_model_and_binarizes_mask() {
    let mut mask = GrayImage::new(500, 700);
    for x in 100..200 {
        for y in 100..200 {
            mask.put_pixel(x, y, Luma([180]));
        }
    }
    let mask_png = encode(DynamicImage::ImageLuma8(mask));
    let body = merge(&base(), json!({"kind": "infill", "inpaintStrength": 0.5}));
    let (payload, meta) = build_image_payload(&body, &png_image((500, 700)), Some(&mask_png)).unwrap();
    let p = &payload["parameters"];
    assert_eq!(payload["action"], "infill");
    assert_eq!(payload["model"], "nai-diffusion-5-full-inpainting");
    let out = decode(&p["mask"]);
    assert_eq!(decode(&p["image"]).dimensions(), (512, 704));
    assert_eq!(out.dimensions(), (512, 704));
    assert_eq!(out.get_pixel(155, 147), Rgba([255, 255, 255, 255]));
    assert_eq!(out.get_pixel(400, 400), Rgba([0, 0, 0, 255]));
    assert_eq!(p["add_original_image"], false);
    assert_eq!(p["inpaintImg2ImgStrength"].as_f64(), Some(0.5));
    assert_eq!(meta["model"], "nai-diffusion-5-full-inpainting");
}

#[test]
fn infill_medium_falls_back_to_full_inpainting() {
    let body = merge(&base(), json!({"effort": "medium", "kind": "infill"}));
    let (payload, _) = build_image_payload(&body, &png_image((500, 700)), Some(&gray_png((500, 700), 255))).unwrap();
    assert_eq!(payload["model"], "nai-diffusion-5-full-inpainting");
    assert_eq!(payload["parameters"]["steps"], 28);
}

#[test]
fn infill_requires_mask() {
    let body = merge(&base(), json!({"kind": "infill"}));
    assert!(build_image_payload(&body, &png_image((500, 700)), None).is_err());
}

#[test]
fn curated_infill_model() {
    let body = merge(&base(), json!({"model": "nai-diffusion-5-curated", "kind": "infill"}));
    let (payload, _) = build_image_payload(&body, &png_image((500, 700)), Some(&gray_png((500, 700), 255))).unwrap();
    assert_eq!(payload["model"], "nai-diffusion-5-curated-inpainting");
}

#[test]
fn enhance_magnitude_mapping_and_advanced_override() {
    assert_eq!(enhance_params(&json!({"magnitude": 2})).strength, 0.5);
    assert_eq!(enhance_params(&json!({"magnitude": 99})).magnitude, 5);
    let adv = enhance_params(&json!({"magnitude": 2, "strength": 0.33, "noise": 0.2}));
    assert!(adv.strength == 0.33 && adv.noise == 0.2);
    assert_eq!(enhance_params(&json!({"upscaleAmount": "bogus"})).upscale_amount, "1x");
}

#[test]
fn enhance_1_5x_enlarges_and_appends_tail() {
    let body = merge(&base(), json!({"kind": "enhance", "upscaleAmount": "1.5x", "nSamples": 3}));
    let (payload, meta) = build_image_payload(&body, &png_image((832, 1216)), None).unwrap();
    let p = &payload["parameters"];
    assert_eq!((p["width"].as_i64(), p["height"].as_i64()), (Some(1280), Some(1856)));
    assert_eq!(p["n_samples"], 1);
    assert!(payload["input"].as_str().unwrap().ends_with(ENHANCE_TAIL));
    assert!(p["v4_prompt"]["caption"]["base_caption"].as_str().unwrap().ends_with(ENHANCE_TAIL));
    // 元数据里不带这段自动追加的尾巴
    assert!(!meta["v4Prompt"]["caption"]["base_caption"].as_str().unwrap().contains(ENHANCE_TAIL));
    assert!(!meta["prompt"].as_str().unwrap().contains(ENHANCE_TAIL));
    assert_eq!(meta["postUpscale"], 0);
}

#[test]
fn enhance_max_keeps_size_and_flags_post_upscale() {
    let body = merge(&base(), json!({"kind": "enhance", "upscaleAmount": "max"}));
    let (payload, meta) = build_image_payload(&body, &png_image((832, 1216)), None).unwrap();
    assert_eq!(
        (payload["parameters"]["width"].as_i64(), payload["parameters"]["height"].as_i64()),
        (Some(832), Some(1216))
    );
    assert!(!payload["input"].as_str().unwrap().contains(ENHANCE_TAIL));
    assert_eq!(meta["postUpscale"], 0);
    assert_eq!(payload["parameters"]["upscaled_enhance"], true);
}

#[test]
fn plan_size_by_kind() {
    assert_eq!(plan_size("upscale", &json!({"scale": 4}), 832, 1216), (1664, 2432));
    assert_eq!(plan_size("upscale", &json!({"scale": 2}), 832, 1216), (1664, 2432));
    assert_eq!(plan_size("enhance", &json!({"upscaleAmount": "1.5x"}), 832, 1216), (1280, 1856));
    assert_eq!(plan_size("enhance", &json!({"upscaleAmount": "max"}), 832, 1216), (1467, 2144));
    assert_eq!(plan_size("img2img", &json!({}), 500, 700), (512, 704));
}

#[test]
fn transparent_base_is_flattened_to_white() {
    let rgba = encode(DynamicImage::ImageRgba8(RgbaImage::from_pixel(64, 64, Rgba([0, 0, 0, 0]))));
    let body = merge(&base(), json!({"kind": "img2img"}));
    let (payload, _) = build_image_payload(&body, &rgba, None).unwrap();
    let px = decode(&payload["parameters"]["image"]).to_rgb8().get_pixel(10, 10).0;
    assert_eq!(px, [255, 255, 255]);
}

#[test]
fn unwrap_image_handles_zip_and_png() {
    let png = png_image((8, 8));
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zf = zip::ZipWriter::new(&mut buf);
        zf.start_file("image_0.png", zip::write::SimpleFileOptions::default()).unwrap();
        zf.write_all(&png).unwrap();
        zf.finish().unwrap();
    }
    assert_eq!(unwrap_image(buf.into_inner()).unwrap(), png);
    assert_eq!(unwrap_image(png.clone()).unwrap(), png);
}
