from __future__ import annotations

import base64
import codecs
import copy
import io
import json
import math
import os
import random
import re
import zipfile
from pathlib import Path
from typing import Any, Callable, Iterator

import httpx
from PIL import Image

IMAGE_API = "https://image.novelai.net"
FULL_MODEL = "nai-diffusion-5-full"
MEDIUM_MODEL = "nai-diffusion-5-full-medium"
CURATED_MODEL = "nai-diffusion-5-curated"
MODELS = {
    FULL_MODEL: "V5 Full",
    MEDIUM_MODEL: "V5 Full Medium",
    CURATED_MODEL: "V5 Curated",
}
SAMPLERS = (
    "k_euler_ancestral",
    "k_euler",
    "k_dpmpp_2s_ancestral",
    "k_dpmpp_2m",
    "k_dpmpp_2m_sde",
    "k_dpmpp_sde",
)
SCHEDULES = ("karras", "native", "exponential", "polyexponential")
QUALITY_PRESETS = {
    "off": "",
    "official": "very aesthetic, masterpiece, no text",
    "gallery": "ultra complexity, very aesthetic, best quality, amazing quality, absurdres",
}
UC_PRESETS = {
    "heavy": (
        "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, "
        "jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, "
        "screentone, multiple views, logo, too many watermarks, negative space, blank page"
    ),
    "comic": (
        "worst quality, bad quality, blurry, watermark, bad anatomy, extra fingers, ugly, "
        "fused face, cropped, jpeg artifacts, mutation, extra legs, missing fingers, "
        "poorly drawn hands, extra arms"
    ),
    "none": "",
}
TIER_NAMES = {0: "无订阅", 1: "Tablet", 2: "Scroll", 3: "Opus"}
MAX_CHARS = 22

API_ROOT = "https://api.novelai.net"
JOB_KINDS = ("generate", "img2img", "variation", "infill", "enhance", "upscale")
IMAGE_KINDS = ("img2img", "variation", "infill", "enhance")
# Generate Variations：官方没有独立接口，就是同一张图走 img2img，随机新 seed 出 3 张（加上原图正好 2x2）。
# strength / noise 是联调时可能要微调的常量。
VARIATION_SAMPLES = 3
VARIATION_STRENGTH = 0.6
VARIATION_NOISE = 0.0
# /ai/upscale 官方只认 2 或 4；工具栏默认 2x。
UPSCALE_DEFAULT = 2
INPAINT_SUFFIX = "-inpainting"
# 官方 Enhance 1.5x 会在 prompt 末尾自动追加这段，抑制放大伪影。
ENHANCE_TAIL = "-2::upscaled, blurry::"
# Magnitude 1~5 对应的 strength；官方只实测过 2 -> 0.5（noise 0），其余档位按 0.1 递进，可按联调结果微调。
ENHANCE_STRENGTH = {1: 0.4, 2: 0.5, 3: 0.6, 4: 0.7, 5: 0.8}
ENHANCE_NOISE = 0.0
ENHANCE_SCALES = {"1x": 1.0, "1.5x": 1.5, "max": 1.0}


class NaiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def token_hint(token: str) -> str:
    token = (token or "").strip()
    if len(token) < 8:
        return "已保存"
    return f"••••{token[-4:]}"


class TokenVault:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> str:
        try:
            stored = self.path.read_text(encoding="utf-8").strip()
            if stored:
                return stored
        except OSError:
            pass
        return (os.environ.get("NAI_ACCESS_TOKEN") or os.environ.get("NAI_API_TOKEN") or "").strip()

    def save(self, token: str) -> None:
        token = (token or "").strip()
        if not token:
            if self.path.exists():
                self.path.unlink()
            return
        self.path.write_text(token, encoding="utf-8")


def snap64(value: int, lo: int = 64, hi: int = 2048) -> int:
    value = max(lo, min(hi, int(value)))
    return max(lo, (value // 64) * 64)


def unzip_images(blob: bytes) -> list[bytes]:
    images: list[bytes] = []
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        for info in zf.infolist():
            name = info.filename.lower()
            if info.is_dir():
                continue
            if name.endswith((".png", ".webp", ".jpg", ".jpeg")):
                images.append(zf.read(info))
    if not images:
        raise NaiError(502, "NovelAI 返回的压缩包里没有图片")
    return images


def pad_numeric_closers(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        body = match.group(2).rstrip()
        if re.search(r"\d$", body):
            body = f"{body} "
        return f"{match.group(1)}::{body}::"

    return re.sub(r"(-?\d*\.?\d+)\s*::\s*(.*?)\s*::", repl, text or "", flags=re.S)


def _join(*parts: str) -> str:
    return ", ".join(p.strip().strip(",") for p in parts if p and p.strip())


def assemble_prompt(body: dict) -> tuple[str, str]:
    prompt = str(body.get("prompt") or "").strip()
    artists = pad_numeric_closers(str(body.get("artists") or body.get("artistLine") or "").strip())
    quality_key = str(body.get("quality") or "gallery")
    if quality_key not in QUALITY_PRESETS:
        quality_key = "gallery"
    quality = QUALITY_PRESETS[quality_key]
    v5_mode = str(body.get("v5Mode") or "anime")
    prefix = "fur dataset" if v5_mode == "furry" else ""
    if quality and quality.lower() in prompt.lower():
        quality = ""
    combined = _join(prefix, quality, artists, prompt)
    uc = str(body.get("uc") or "").strip()
    return combined, uc


def _characters(body: dict) -> list[dict]:
    raw = body.get("characters")
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw[:MAX_CHARS]:
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt") or "").strip()
        if not prompt:
            continue
        try:
            x = float(item.get("x", 0.5))
            y = float(item.get("y", 0.5))
        except (TypeError, ValueError):
            x, y = 0.5, 0.5
        out.append(
            {
                "prompt": prompt,
                "uc": str(item.get("uc") or "").strip(),
                "center": {"x": max(0.0, min(1.0, x)), "y": max(0.0, min(1.0, y))},
            }
        )
    return out


def uses_medium(body: dict) -> bool:
    """V5 Full 的节约模式走蒸馏模型，不看界面上另存的步数和采样器。"""
    raw = str(body.get("model") or FULL_MODEL)
    if raw == MEDIUM_MODEL:
        return True
    return raw == FULL_MODEL and str(body.get("effort") or "") == "medium"


def resolve_model(body: dict) -> tuple[str, str]:
    raw = str(body.get("model") or FULL_MODEL)
    if raw not in MODELS:
        raise NaiError(400, "仅支持 NovelAI V5 模型")
    if uses_medium(body):
        return MEDIUM_MODEL, "medium"
    return raw, "high"


def build_payload(body: dict) -> tuple[dict, dict]:
    model, effort = resolve_model(body)
    medium = effort == "medium"
    prompt, uc = assemble_prompt(body)
    if not prompt:
        raise NaiError(400, "Prompt 不能为空")
    width = snap64(body.get("width") or 832)
    height = snap64(body.get("height") or 1216)
    steps = 14 if medium else max(1, min(50, int(body.get("steps") or 28)))
    scale = float(body.get("scale") if body.get("scale") is not None else 5)
    scale = max(0.0, min(30.0, scale))
    cfg_rescale = 0.0 if medium else max(0.0, min(1.0, float(body.get("cfgRescale") or 0)))
    n_samples = max(1, min(4, int(body.get("nSamples") or 1)))
    sampler = "k_euler_ancestral" if medium else str(body.get("sampler") or "k_euler_ancestral")
    if sampler not in SAMPLERS:
        raise NaiError(400, "不支持的 sampler")
    schedule = "karras" if medium else str(body.get("noiseSchedule") or "karras")
    if schedule not in SCHEDULES:
        raise NaiError(400, "不支持的 noise schedule")
    if schedule == "native":
        schedule = "karras"
    if medium:
        uc = ""
    try:
        seed = int(body.get("seed"))
    except (TypeError, ValueError):
        seed = -1
    if seed is None or seed < 0:
        seed = random.randint(0, 2**32 - 1)
    seed = seed % (2**32)
    characters = _characters(body)
    if medium:
        for character in characters:
            character["uc"] = ""
    use_coords = bool(body.get("useCoords"))
    if body.get("useCoords") is None:
        use_coords = any(c["center"] != {"x": 0.5, "y": 0.5} for c in characters)
    char_captions = [{"char_caption": c["prompt"], "centers": [c["center"]]} for c in characters]
    neg_captions = [{"char_caption": c["uc"], "centers": [c["center"]]} for c in characters]
    straight_alpha = True if body.get("straightAlpha") is None else bool(body.get("straightAlpha"))
    parameters = {
        "params_version": 4,
        "width": width,
        "height": height,
        "scale": scale,
        "sampler": sampler,
        "steps": steps,
        "seed": seed,
        "n_samples": n_samples,
        "extra_noise_seed": seed,
        "noise_schedule": schedule,
        "negative_prompt": uc,
        "legacy": False,
        "legacy_uc": False,
        "legacy_v3_extend": False,
        "prefer_brownian": True if medium else bool(body.get("preferBrownian", True)),
        "deliberate_euler_ancestral_bug": False,
        "dynamic_thresholding": bool(body.get("decrisp", False)),
        "controlnet_strength": 1,
        "use_coords": use_coords,
        "ucPresetId": "none",
        "qualityPresetId": "standard",
        "tag_hint_qt": 1,
        "tag_hint_uc_preset": 2,
        "normalize_reference_strength_multiple": True,
        "straight_alpha": straight_alpha,
        "image_format": "png",
        "inpaintImg2ImgStrength": 1,
        "add_original_image": True,
        "v4_prompt": {
            "caption": {"base_caption": prompt, "char_captions": char_captions},
            "use_coords": use_coords,
            "use_order": True,
            "legacy_uc": False,
        },
        "v4_negative_prompt": {
            "caption": {"base_caption": uc, "char_captions": neg_captions},
            "legacy_uc": False,
        },
    }
    if not medium:
        parameters["cfg_rescale"] = cfg_rescale
    if characters:
        parameters["characterPrompts"] = [
            {"prompt": c["prompt"], "uc": c["uc"], "center": c["center"], "enabled": True}
            for c in characters
        ]
    payload = {"input": prompt, "model": model, "action": "generate", "parameters": parameters}
    meta = {
        "prompt": prompt,
        "uc": uc,
        "model": model,
        "effort": effort,
        "width": width,
        "height": height,
        "steps": steps,
        "sampler": sampler,
        "scale": scale,
        "seed": seed,
        "noiseSchedule": schedule,
        "cfgRescale": cfg_rescale,
        "nSamples": n_samples,
        "useCoords": use_coords,
        "v5Mode": str(body.get("v5Mode") or "anime"),
        "quality": str(body.get("quality") or "gallery"),
        "characters": characters,
        "v4Prompt": parameters["v4_prompt"],
        "v4Negative": parameters["v4_negative_prompt"],
        "software": "NovelAI",
        "source": "nai-v5",
        "requestType": "generate",
        "straightAlpha": straight_alpha,
    }
    return payload, meta


def fit64(value: float) -> int:
    """取最接近的 64 倍数，NAI 要求图片与蒙版的宽高都对齐 64。"""
    return max(64, min(2048, int(float(value) / 64.0 + 0.5) * 64))


def _clamp(value: Any, lo: float, hi: float, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    if number != number:
        number = default
    return max(lo, min(hi, number))


def enhance_params(body: dict) -> dict:
    """Enhance 面板参数 -> strength / noise / 放大倍数。显式给了 strength/noise 时（Show Advanced）以显式值为准。"""
    magnitude = int(_clamp(body.get("magnitude", 2), 1, 5, 2))
    amount = str(body.get("upscaleAmount") or "1x").lower()
    if amount not in ENHANCE_SCALES:
        amount = "1x"
    strength = body.get("strength")
    noise = body.get("noise")
    return {
        "magnitude": magnitude,
        "upscaleAmount": amount,
        "scale": ENHANCE_SCALES[amount],
        "strength": _clamp(strength if strength is not None else ENHANCE_STRENGTH[magnitude], 0.01, 0.99, 0.5),
        "noise": _clamp(noise if noise is not None else ENHANCE_NOISE, 0.0, 0.99, 0.0),
        # Max 不是再调一次 2x 放大，而是请求里带 upscaled_enhance，由官方放大到约 3MP。
        "upscaledEnhance": amount == "max",
    }


def upscale_factor(body: dict) -> int:
    """官方 /ai/upscale 固定 2 倍，scale 参数已经不收了。"""
    return UPSCALE_DEFAULT


def upscale_model(model: Any) -> str:
    """放大要带模型名；只认 V5 的 full / curated，其它（medium、inpainting、旧模型）退回 curated。"""
    return str(model) if model in (FULL_MODEL, CURATED_MODEL) else CURATED_MODEL


def plan_size(kind: str, body: dict, src_w: int, src_h: int) -> tuple[int, int]:
    """任务最终产出的尺寸，给前端画占位用。"""
    if kind == "upscale":
        factor = upscale_factor(body)
        return src_w * factor, src_h * factor
    if kind == "enhance":
        p = enhance_params(body)
        return enhance_output_size(src_w, src_h, p["upscaleAmount"])
    return fit64(src_w), fit64(src_h)


# ---- Anlas 消耗估算 ----
# 官方没有公开计费接口。单张基础价沿用社区 SDK（novelai-sdk calculate_anlas）里的系数，
# img2img 再乘 strength（最低 2）；用官方截图校准：832x1216 / 28 步 / 3 张 / strength 0.6 = 36。
ANLAS_PIXEL_COEF = 2.951823174884865e-6
ANLAS_STEP_COEF = 5.753298233447344e-7
ANLAS_MIN_PIXELS = 64 * 1024
ANLAS_I2I_MIN = 2
# /ai/upscale：不超过 1MP 记 1，超出后每多 1MP 加 1（截图里 832x1216 放大显示 1）。
ANLAS_UPSCALE_UNIT_PIXELS = 1024 * 1024
# Enhance Max 的产出面积上限，和官方实测 832x1216 -> 1467x2144 一致。
ENHANCE_MAX_PIXELS = 1536 * 2048
# 官方增强按钮不跟步数滑杆走，按 28 步的产出尺寸计价。
# Magnitude 1~5 的计价系数按 832x1216 官方按钮校准（和请求里的 strength 不是同一个数）：
# 1x 在 Opus 且不超过 1MP 时是 0；1.5x 为 11/21/27/32/37；Max 为 14/27/34/41/48。
ENHANCE_BILL_STEPS = 28
ENHANCE_BILL_FACTOR = {1: 0.23, 2: 0.45, 3: 0.566, 4: 0.68, 5: 0.8}
OPUS_FREE_PIXELS = 1024 * 1024
OPUS_FREE_STEPS = 28


def _base_cost(width: int, height: int, steps: int) -> int:
    pixels = max(int(width) * int(height), ANLAS_MIN_PIXELS)
    return max(1, math.ceil(ANLAS_PIXEL_COEF * pixels + ANLAS_STEP_COEF * pixels * int(steps)))


def i2i_cost(width: int, height: int, steps: int, strength: float, samples: int = 1) -> int:
    per = max(ANLAS_I2I_MIN, math.ceil(_base_cost(width, height, steps) * float(strength)))
    return per * max(1, int(samples))


def upscale_cost(width: int, height: int) -> int:
    return max(1, math.ceil(int(width) * int(height) / ANLAS_UPSCALE_UNIT_PIXELS))


def enhance_output_size(width: int, height: int, amount: str) -> tuple[int, int]:
    """Enhance 最终图片尺寸。1.5x 对齐 64；Max 按面积放到 3MP，宽高取整，和官方产出一致。"""
    width, height = max(1, int(width)), max(1, int(height))
    if amount == "1.5x":
        return fit64(width * 1.5), fit64(height * 1.5)
    if amount == "max" and width * height < ENHANCE_MAX_PIXELS:
        factor = math.sqrt(ENHANCE_MAX_PIXELS / (width * height))
        return math.floor(width * factor), math.floor(height * factor)
    return width, height


def enhance_cost(width: int, height: int, magnitude: int, amount: str, strength: float, explicit: bool, opus: bool) -> int:
    out_w, out_h = enhance_output_size(width, height, amount)
    if opus and out_w * out_h <= OPUS_FREE_PIXELS:
        return 0
    factor = float(strength) if explicit else ENHANCE_BILL_FACTOR.get(int(magnitude), 0.45)
    return max(ANLAS_I2I_MIN, math.ceil(_base_cost(out_w, out_h, ENHANCE_BILL_STEPS) * factor))


def generate_cost(body: dict, steps: int) -> int:
    """生图按钮：genWidth/genHeight/genSamples 是表单参数，genStrength 有值时按图生图计。
    Opus 每次请求有 1 张免费（≤1MP 且 ≤28 步），多出来的张数照常扣。"""
    gw = snap64(body.get("genWidth") or body.get("width") or 832)
    gh = snap64(body.get("genHeight") or body.get("height") or 1216)
    samples = int(_clamp(body.get("genSamples"), 1, 4, 1))
    per = _base_cost(gw, gh, steps)
    if body.get("genStrength") is not None:
        per = max(ANLAS_I2I_MIN, math.ceil(per * _clamp(body.get("genStrength"), 0.01, 0.99, 0.7)))
    if body.get("opus") and gw * gh <= OPUS_FREE_PIXELS and steps <= OPUS_FREE_STEPS:
        samples -= 1
    return per * max(0, samples)


def estimate_costs(body: dict) -> dict:
    """工具栏按钮旁边的 Anlas 估算：width/height 是当前图的尺寸。"""
    width = fit64(body.get("width") or 832)
    height = fit64(body.get("height") or 1216)
    steps = 14 if uses_medium(body) else max(1, min(50, int(_clamp(body.get("steps"), 1, 50, 28))))
    variation = i2i_cost(width, height, steps, _clamp(body.get("variationStrength"), 0.01, 0.99, VARIATION_STRENGTH), VARIATION_SAMPLES)
    enh = enhance_params(body)
    enhance = enhance_cost(
        width,
        height,
        enh["magnitude"],
        enh["upscaleAmount"],
        enh["strength"],
        body.get("strength") is not None,
        bool(body.get("opus")),
    )
    factor = upscale_factor(body)
    return {
        "generate": generate_cost(body, steps),
        "variation": variation,
        "upscale": upscale_cost(width, height),
        "enhance": enhance,
        "upscaleScale": factor,
        "estimated": True,
    }


def _flatten_rgb(data: bytes, what: str) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:
        raise NaiError(400, f"无法读取{what}") from exc
    if img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info:
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[3])
        return bg
    return img.convert("RGB")


def _mask_luma(mask: Image.Image) -> Image.Image:
    """编辑器存的是不透明黑白图，白即重绘。若透明通道本身有变化，则以不透明处为重绘区。"""
    if "A" in mask.getbands():
        alpha = mask.convert("RGBA").getchannel("A")
        if alpha.getextrema()[0] < 255:
            return alpha
    return mask.convert("L")


def _point_resize(src: Image.Image, width: int, height: int) -> Image.Image:
    """官方 p0：每个目标像素取源图里对应中心点，不做插值。"""
    src_l = src.convert("L")
    out = Image.new("L", (width, height))
    sp = src_l.load()
    dp = out.load()
    sw, sh = src_l.size
    for y in range(height):
        sy = min(sh - 1, int((y + 0.5) * sh / height))
        for x in range(width):
            sx = min(sw - 1, int((x + 0.5) * sw / width))
            dp[x, y] = sp[sx, sy]
    return out


def inpaint_mask_luma(mask_bytes: bytes, width: int, height: int) -> Image.Image:
    """和官网 generateInfill 同一条路径：先缩到 1/8，alpha > 155 才算涂到，再放大回成图尺寸。
    返回的 L 图里 255 是要重绘的像素。"""
    try:
        mask = Image.open(io.BytesIO(mask_bytes))
        mask.load()
    except Exception as exc:
        raise NaiError(400, "无法读取蒙版") from exc
    small = _point_resize(_mask_luma(mask), max(1, width // 8), max(1, height // 8))
    small = small.point(lambda v: 255 if v > 155 else 0)
    return _point_resize(small, width, height)


def encode_inpaint_mask(mask_bytes: bytes, width: int, height: int) -> str:
    """官网发出去的蒙版是成图原尺寸：重绘处纯白不透明，其余纯黑不透明。"""
    gray = inpaint_mask_luma(mask_bytes, width, height)
    rgba = Image.new("RGBA", gray.size)
    rgba.putdata([(255, 255, 255, 255) if v else (0, 0, 0, 255) for v in gray.getdata()])
    buf = io.BytesIO()
    rgba.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def composite_infill(original: bytes, generated: bytes, mask_bytes: bytes) -> bytes:
    """官网把 add_original_image 关掉，生成后再把蒙版外的像素贴回原图。"""
    src = _flatten_rgb(original, "底图").convert("RGBA")
    width, height = fit64(src.width), fit64(src.height)
    if src.size != (width, height):
        src = src.resize((width, height), Image.Resampling.LANCZOS)
    try:
        gen = Image.open(io.BytesIO(generated))
        gen.load()
    except Exception as exc:
        raise NaiError(502, "无法读取重绘结果") from exc
    gen = gen.convert("RGBA")
    if gen.size != (width, height):
        gen = gen.resize((width, height), Image.Resampling.LANCZOS)
    out = Image.composite(gen, src, inpaint_mask_luma(mask_bytes, width, height))
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


def _png_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def image_to_png(data: bytes) -> bytes:
    buf = io.BytesIO()
    _flatten_rgb(data, "图片").save(buf, format="PNG")
    return buf.getvalue()


def build_image_payload(body: dict, image_bytes: bytes, mask_bytes: bytes | None = None) -> tuple[dict, dict]:
    """图生图 / 局部重绘 / 增强：在 build_payload 的基础上换 action 并附上底图与蒙版。"""
    kind = str(body.get("kind") or "img2img")
    if kind not in IMAGE_KINDS:
        raise NaiError(400, "不支持的图片任务类型")
    if kind == "infill" and not mask_bytes:
        raise NaiError(400, "局部重绘需要蒙版")
    src = _flatten_rgb(image_bytes, "底图")
    work = dict(body)
    enh: dict | None = None
    if kind == "enhance":
        enh = enhance_params(body)
        work["nSamples"] = 1
        strength, noise = enh["strength"], enh["noise"]
        width, height = fit64(src.width * enh["scale"]), fit64(src.height * enh["scale"])
    elif kind == "variation":
        work["nSamples"] = VARIATION_SAMPLES
        work["seed"] = -1
        strength = _clamp(body.get("strength", VARIATION_STRENGTH), 0.01, 0.99, VARIATION_STRENGTH)
        noise = _clamp(body.get("noise", VARIATION_NOISE), 0.0, 0.99, VARIATION_NOISE)
        width, height = fit64(src.width), fit64(src.height)
    else:
        strength = _clamp(body.get("strength", 0.7), 0.01, 0.99, 0.7)
        noise = _clamp(body.get("noise", 0.0), 0.0, 0.99, 0.0)
        width, height = fit64(src.width), fit64(src.height)
    if kind == "infill":
        # 蒸馏的节约模型没有 inpainting 版本，局部重绘一律走 V5 Full / Curated。
        work["effort"] = "high"
        if work.get("model") == MEDIUM_MODEL:
            work["model"] = FULL_MODEL
    work["width"], work["height"] = width, height
    payload, meta = build_payload(work)
    params = payload["parameters"]
    meta["v4Prompt"] = copy.deepcopy(params["v4_prompt"])
    meta["v4Negative"] = copy.deepcopy(params["v4_negative_prompt"])
    if src.size != (width, height):
        src = src.resize((width, height), Image.LANCZOS)
    params["image"] = _png_b64(src)
    params["strength"] = strength
    params["noise"] = noise
    params["extra_noise_seed"] = params["seed"]
    params["add_original_image"] = True
    payload["action"] = "infill" if kind == "infill" else "img2img"
    if kind == "infill":
        # 官网在请求里关掉这项，生成完再自己把蒙版外贴回原图。开着会把笔刷形状涂成色块。
        params["add_original_image"] = False
        params["mask"] = encode_inpaint_mask(mask_bytes or b"", width, height)
        params["inpaintImg2ImgStrength"] = _clamp(body.get("inpaintStrength", 1), 0.01, 1.0, 1.0)
        payload["model"] = f"{payload['model']}{INPAINT_SUFFIX}"
        meta["model"] = payload["model"]
        meta["inpaintStrength"] = params["inpaintImg2ImgStrength"]
    if enh and enh["upscaleAmount"] == "1.5x":
        tail = ENHANCE_TAIL
        payload["input"] = f"{payload['input']}, {tail}"
        params["v4_prompt"]["caption"]["base_caption"] = payload["input"]
    meta.update(
        {
            "requestType": kind,
            "strength": strength,
            "noise": noise,
            "width": width,
            "height": height,
            "sourceHash": str(body.get("imageHash") or ""),
        }
    )
    if enh:
        meta["magnitude"] = enh["magnitude"]
        meta["upscaleAmount"] = enh["upscaleAmount"]
        meta["postUpscale"] = 0
        if enh["upscaledEnhance"]:
            params["upscaled_enhance"] = True
            meta["upscaledEnhance"] = True
    return payload, meta


def unwrap_image(blob: bytes) -> bytes:
    """/ai/upscale 可能回 ZIP 也可能直接回 PNG。"""
    if blob[:2] == b"PK":
        return unzip_images(blob)[0]
    return blob


def decode_image_b64(raw: str) -> bytes:
    text = (raw or "").strip()
    if text.lower().startswith("data:") and "," in text:
        text = text.split(",", 1)[1]
    try:
        return base64.b64decode(text)
    except Exception as exc:
        raise NaiError(502, "无法解码流式图片") from exc


def _parse_error(resp: httpx.Response) -> NaiError:
    message = ""
    try:
        parsed = resp.json()
        message = parsed.get("message") or parsed.get("error") or ""
        if isinstance(message, dict):
            message = message.get("message") or json.dumps(message, ensure_ascii=False)
    except Exception:
        message = resp.text[:400]
    return NaiError(resp.status_code, str(message) or "NovelAI 请求失败")


class NaiGateway:
    def __init__(self, vault: TokenVault):
        self.vault = vault
        self._client = httpx.Client(timeout=20)
        # 生图请求超时（秒），由设置服务注入。
        self.timeout_provider: Callable[[], float] | None = None

    def _gen_timeout(self) -> float:
        return float(self.timeout_provider()) if self.timeout_provider else 180.0

    def _headers(self, token: str, accept: str = "*/*") -> dict[str, str]:
        return {
            "Authorization": f"Bearer {token}",
            "Accept": accept,
            "User-Agent": "ArtistGallery/1.0",
            "Content-Type": "application/json",
        }

    def fetch_subscription(self, token: str | None = None) -> dict:
        token = token or self.vault.load()
        if not token:
            raise NaiError(401, "还没有配置 NovelAI Persistent API Token")
        resp = self._client.get(f"{IMAGE_API}/user/subscription", headers=self._headers(token))
        if resp.status_code >= 400:
            raise _parse_error(resp)
        data = resp.json()
        training = data.get("trainingStepsLeft") or data.get("training_steps_left") or {}
        fixed = int(training.get("fixedTrainingStepsLeft") or training.get("fixed_training_steps_left") or 0)
        purchased = int(
            training.get("purchasedTrainingSteps")
            or training.get("purchased_training_steps")
            or data.get("purchasedTrainingSteps")
            or 0
        )
        tier = int(data.get("tier") or 0)
        name = str(data.get("tierName") or data.get("tier_name") or TIER_NAMES.get(tier, f"Tier {tier}"))
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        percent = usage.get("percent")
        try:
            usage_percent = float(percent) if percent is not None else None
        except (TypeError, ValueError):
            usage_percent = None
        return {
            "tier": tier,
            "tierName": name,
            "active": bool(data.get("active", True)),
            "opus": tier >= 3 or name.lower() == "opus",
            "anlas": max(0, fixed + purchased),
            "anlasFixed": max(0, fixed),
            "anlasPurchased": max(0, purchased),
            "usagePercent": usage_percent,
            "usageNegative": bool(usage.get("isNegative") or usage.get("is_negative")),
            "expiresAt": data.get("expiresAt") or data.get("expires_at"),
        }

    def upscale_image(self, png: bytes, model: str | None = None) -> bytes:
        """专用放大（不受 prompt 影响）。现在的 image.novelai.net/ai/upscale 只收 image + model，
        固定放大 2 倍；旧版的 width/height/scale 字段会被拒绝。"""
        token = self.vault.load()
        if not token:
            raise NaiError(401, "还没有配置 NovelAI Persistent API Token")
        body = {"image": base64.b64encode(png).decode("ascii"), "model": upscale_model(model)}
        try:
            with httpx.Client(timeout=self._gen_timeout()) as client:
                resp = client.post(f"{IMAGE_API}/ai/upscale", headers=self._headers(token), json=body)
        except httpx.HTTPError as exc:
            raise NaiError(502, f"无法连接 NovelAI：{exc}") from exc
        if resp.status_code >= 400:
            raise _parse_error(resp)
        return unwrap_image(resp.content)

    def generate_images(self, body: dict, prepared: tuple[dict, dict] | None = None) -> tuple[list[bytes], dict]:
        token = self.vault.load()
        if not token:
            raise NaiError(401, "还没有配置 NovelAI Persistent API Token")
        payload, meta = prepared if prepared is not None else build_payload(body)
        with httpx.Client(timeout=self._gen_timeout()) as client:
            resp = client.post(
                f"{IMAGE_API}/ai/generate-image",
                headers=self._headers(token),
                json=payload,
            )
        if resp.status_code >= 400:
            raise _parse_error(resp)
        return unzip_images(resp.content), meta

    def iter_stream(
        self, body: dict, prepared: tuple[dict, dict] | None = None
    ) -> tuple[Iterator[dict], dict, Any]:
        token = self.vault.load()
        if not token:
            raise NaiError(401, "还没有配置 NovelAI Persistent API Token")
        payload, meta = prepared if prepared is not None else build_payload(body)
        payload = {**payload, "parameters": {**payload["parameters"], "stream": "sse"}}
        client = httpx.Client(timeout=self._gen_timeout())
        try:
            req = client.build_request(
                "POST",
                f"{IMAGE_API}/ai/generate-image-stream",
                headers=self._headers(token, "text/event-stream"),
                json=payload,
            )
            resp = client.send(req, stream=True)
            if resp.status_code >= 400:
                raw = resp.read()
                resp.close()
                client.close()
                fake = httpx.Response(resp.status_code, content=raw)
                raise _parse_error(fake)
        except NaiError:
            raise
        except httpx.HTTPError as exc:
            client.close()
            raise NaiError(502, f"无法连接 NovelAI：{exc}") from exc
        return _iter_sse(resp), meta, (resp, client)


def _iter_sse(resp: httpx.Response) -> Iterator[dict]:
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    buf = ""
    for chunk in resp.iter_bytes():
        buf += decoder.decode(chunk)
        while True:
            crlf = buf.find("\r\n\r\n")
            lf = buf.find("\n\n")
            if crlf == -1 and lf == -1:
                break
            if lf != -1 and (crlf == -1 or lf < crlf):
                event, buf = buf[:lf], buf[lf + 2 :]
            else:
                event, buf = buf[:crlf], buf[crlf + 4 :]
            parsed = _parse_sse_json(event)
            if parsed:
                yield parsed
    buf += decoder.decode(b"", final=True)
    if buf.strip():
        parsed = _parse_sse_json(buf)
        if parsed:
            yield parsed


def _parse_sse_json(event: str) -> dict | None:
    lines: list[str] = []
    for line in event.splitlines():
        if line.startswith("data:"):
            lines.append(line[5:].lstrip())
    if not lines:
        return None
    raw = "\n".join(lines).strip()
    if not raw or raw == "[DONE]":
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None
