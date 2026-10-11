import base64
import io
import zipfile

import pytest
from PIL import Image

from contexts.generation.nai_client import (
    ENHANCE_TAIL,
    NaiError,
    build_image_payload,
    enhance_params,
    fit64,
    plan_size,
    unwrap_image,
)


def _png(size=(500, 700), color=(200, 30, 30), mode="RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, format="PNG")
    return buf.getvalue()


def _decode(b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(b64)))


BASE = {"prompt": "1girl", "uc": "lowres", "model": "nai-diffusion-5-full", "seed": 5, "steps": 28}


def test_fit64_rounds_to_multiple():
    assert fit64(500) == 512
    assert fit64(700) == 704
    assert fit64(10) == 64
    assert fit64(9999) == 2048


def test_img2img_payload_aligns_size_and_carries_strength():
    payload, meta = build_image_payload({**BASE, "kind": "img2img", "strength": 0.6, "noise": 0.1, "imageHash": "ab"}, _png())
    params = payload["parameters"]
    assert payload["action"] == "img2img"
    assert payload["model"] == "nai-diffusion-5-full"
    assert (params["width"], params["height"]) == (512, 704)
    assert _decode(params["image"]).size == (512, 704)
    assert params["strength"] == 0.6 and params["noise"] == 0.1
    assert params["extra_noise_seed"] == params["seed"] == 5
    assert "mask" not in params
    assert meta["requestType"] == "img2img" and meta["sourceHash"] == "ab"


def test_strength_noise_are_clamped():
    payload, _ = build_image_payload({**BASE, "kind": "img2img", "strength": 5, "noise": -1}, _png())
    assert payload["parameters"]["strength"] == 0.99
    assert payload["parameters"]["noise"] == 0.0


def test_infill_switches_model_and_binarizes_mask():
    mask = Image.new("L", (500, 700), 0)
    for x in range(100, 200):
        for y in range(100, 200):
            mask.putpixel((x, y), 180)
    buf = io.BytesIO()
    mask.save(buf, format="PNG")
    payload, meta = build_image_payload({**BASE, "kind": "infill", "inpaintStrength": 0.5}, _png(), buf.getvalue())
    params = payload["parameters"]
    assert payload["action"] == "infill"
    assert payload["model"] == "nai-diffusion-5-full-inpainting"
    out = _decode(params["mask"])
    assert _decode(params["image"]).size == (512, 704)
    assert out.size == (512, 704)
    assert out.getpixel((155, 147)) == (255, 255, 255, 255)
    assert out.getpixel((400, 400)) == (0, 0, 0, 255)
    assert params["add_original_image"] is False
    assert params["inpaintImg2ImgStrength"] == 0.5
    assert meta["model"] == "nai-diffusion-5-full-inpainting"


def test_infill_medium_falls_back_to_full_inpainting():
    mask = _png(mode="L", color=255)
    payload, _ = build_image_payload({**BASE, "effort": "medium", "kind": "infill"}, _png(), mask)
    assert payload["model"] == "nai-diffusion-5-full-inpainting"
    assert payload["parameters"]["steps"] == 28


def test_infill_requires_mask():
    with pytest.raises(NaiError):
        build_image_payload({**BASE, "kind": "infill"}, _png())


def test_curated_infill_model():
    payload, _ = build_image_payload(
        {**BASE, "model": "nai-diffusion-5-curated", "kind": "infill"}, _png(), _png(mode="L", color=255)
    )
    assert payload["model"] == "nai-diffusion-5-curated-inpainting"


def test_enhance_magnitude_mapping_and_advanced_override():
    assert enhance_params({"magnitude": 2})["strength"] == 0.5
    assert enhance_params({"magnitude": 99})["magnitude"] == 5
    adv = enhance_params({"magnitude": 2, "strength": 0.33, "noise": 0.2})
    assert adv["strength"] == 0.33 and adv["noise"] == 0.2
    assert enhance_params({"upscaleAmount": "bogus"})["upscaleAmount"] == "1x"


def test_enhance_1_5x_enlarges_and_appends_tail():
    payload, meta = build_image_payload({**BASE, "kind": "enhance", "upscaleAmount": "1.5x", "nSamples": 3}, _png((832, 1216)))
    params = payload["parameters"]
    assert (params["width"], params["height"]) == (1280, 1856)
    assert params["n_samples"] == 1
    assert payload["input"].endswith(ENHANCE_TAIL)
    assert params["v4_prompt"]["caption"]["base_caption"].endswith(ENHANCE_TAIL)
    # 元数据里不带这段自动追加的尾巴
    assert ENHANCE_TAIL not in meta["v4Prompt"]["caption"]["base_caption"]
    assert ENHANCE_TAIL not in meta["prompt"]
    assert meta["postUpscale"] == 0


def test_enhance_max_keeps_size_and_flags_post_upscale():
    payload, meta = build_image_payload({**BASE, "kind": "enhance", "upscaleAmount": "max"}, _png((832, 1216)))
    assert (payload["parameters"]["width"], payload["parameters"]["height"]) == (832, 1216)
    assert ENHANCE_TAIL not in payload["input"]
    assert meta["postUpscale"] == 0
    assert payload["parameters"]["upscaled_enhance"] is True


def test_plan_size():
    assert plan_size("upscale", {"scale": 4}, 832, 1216) == (1664, 2432)
    assert plan_size("upscale", {"scale": 2}, 832, 1216) == (1664, 2432)
    assert plan_size("enhance", {"upscaleAmount": "1.5x"}, 832, 1216) == (1280, 1856)
    assert plan_size("enhance", {"upscaleAmount": "max"}, 832, 1216) == (1467, 2144)
    assert plan_size("img2img", {}, 500, 700) == (512, 704)


def test_transparent_base_is_flattened_to_white():
    rgba = _png((64, 64), (0, 0, 0, 0), mode="RGBA")
    payload, _ = build_image_payload({**BASE, "kind": "img2img"}, rgba)
    assert _decode(payload["parameters"]["image"]).convert("RGB").getpixel((10, 10)) == (255, 255, 255)


def test_unwrap_image_handles_zip_and_png():
    png = _png((8, 8))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("image_0.png", png)
    assert unwrap_image(buf.getvalue()) == png
    assert unwrap_image(png) == png
