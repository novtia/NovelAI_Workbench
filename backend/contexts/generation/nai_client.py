from __future__ import annotations

import base64
import codecs
import io
import json
import os
import random
import re
import zipfile
from pathlib import Path
from typing import Any, Iterator

import httpx

IMAGE_API = "https://image.novelai.net"
MODELS = {
    "nai-diffusion-5-full": "V5 Full",
    "nai-diffusion-5-curated": "V5 Curated",
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


def build_payload(body: dict) -> tuple[dict, dict]:
    model = str(body.get("model") or "nai-diffusion-5-full")
    if model not in MODELS:
        raise NaiError(400, "仅支持 NovelAI V5 模型")
    prompt, uc = assemble_prompt(body)
    if not prompt:
        raise NaiError(400, "Prompt 不能为空")
    width = snap64(body.get("width") or 832)
    height = snap64(body.get("height") or 1216)
    steps = max(1, min(50, int(body.get("steps") or 28)))
    scale = float(body.get("scale") if body.get("scale") is not None else 5)
    scale = max(0.0, min(30.0, scale))
    cfg_rescale = max(0.0, min(1.0, float(body.get("cfgRescale") or 0)))
    n_samples = max(1, min(4, int(body.get("nSamples") or 1)))
    sampler = str(body.get("sampler") or "k_euler_ancestral")
    if sampler not in SAMPLERS:
        raise NaiError(400, "不支持的 sampler")
    schedule = str(body.get("noiseSchedule") or "karras")
    if schedule not in SCHEDULES:
        raise NaiError(400, "不支持的 noise schedule")
    if schedule == "native":
        schedule = "karras"
    try:
        seed = int(body.get("seed"))
    except (TypeError, ValueError):
        seed = -1
    if seed is None or seed < 0:
        seed = random.randint(0, 2**32 - 1)
    seed = seed % (2**32)
    characters = _characters(body)
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
        "cfg_rescale": cfg_rescale,
        "legacy": False,
        "legacy_uc": False,
        "legacy_v3_extend": False,
        "prefer_brownian": bool(body.get("preferBrownian", True)),
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
        with httpx.Client(timeout=20) as client:
            resp = client.get(f"{IMAGE_API}/user/subscription", headers=self._headers(token))
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

    def generate_images(self, body: dict) -> tuple[list[bytes], dict]:
        token = self.vault.load()
        if not token:
            raise NaiError(401, "还没有配置 NovelAI Persistent API Token")
        payload, meta = build_payload(body)
        with httpx.Client(timeout=180) as client:
            resp = client.post(
                f"{IMAGE_API}/ai/generate-image",
                headers=self._headers(token),
                json=payload,
            )
        if resp.status_code >= 400:
            raise _parse_error(resp)
        return unzip_images(resp.content), meta

    def iter_stream(self, body: dict) -> tuple[Iterator[dict], dict, Any]:
        token = self.vault.load()
        if not token:
            raise NaiError(401, "还没有配置 NovelAI Persistent API Token")
        payload, meta = build_payload(body)
        payload["parameters"]["stream"] = "sse"
        client = httpx.Client(timeout=180)
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
