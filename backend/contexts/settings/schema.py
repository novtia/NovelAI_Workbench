"""设置项的唯一定义：分组、类型、默认值、范围。服务端据此校验并 clamp，前端默认值需与这里对齐。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class Spec:
    kind: str  # bool | int | float | choice
    default: Any
    min: float | None = None
    max: float | None = None
    choices: tuple[Any, ...] = ()

    def coerce(self, value: Any) -> Any:
        """把任意输入规整成合法值；不合法时返回默认值。"""
        if self.kind == "bool":
            if isinstance(value, bool):
                return value
            if isinstance(value, (int, float)) and value in (0, 1):
                return bool(value)
            return self.default
        if self.kind == "choice":
            for choice in self.choices:
                if value == choice and type(value) is type(choice):
                    return choice
            return self.default
        if isinstance(value, bool):
            return self.default
        try:
            number = float(value)
        except (TypeError, ValueError):
            return self.default
        if number != number or number in (float("inf"), float("-inf")):
            return self.default
        if self.min is not None:
            number = max(self.min, number)
        if self.max is not None:
            number = min(self.max, number)
        if self.kind == "int":
            return int(round(number))
        return round(number, 4)


def _bool(default: bool) -> Spec:
    return Spec("bool", default)


def _int(default: int, lo: int, hi: int) -> Spec:
    return Spec("int", default, lo, hi)


def _float(default: float, lo: float, hi: float) -> Spec:
    return Spec("float", default, lo, hi)


def _choice(default: Any, *choices: Any) -> Spec:
    return Spec("choice", default, choices=tuple(choices))


SCHEMA: dict[str, dict[str, Spec]] = {
    "appearance": {
        "theme": _choice("light", "light", "dark", "auto"),
        "font": _choice("serif", "serif", "sans"),
        "liveInk": _bool(True),
        "grain": _bool(True),
        "reduceMotion": _bool(False),
        "sidebarLabels": _bool(True),
        "toastMs": _int(3200, 1500, 10000),
    },
    "gallery": {
        "density": _choice("comfortable", "comfortable", "compact"),
        "cardMinWidth": _int(230, 150, 400),
        "sort": _choice("added_desc", "added_desc", "added_asc"),
        "pageSize": _choice(0, 0, 100, 200, 500),
        "showArtists": _bool(True),
        "hoverPreview": _bool(True),
        "startAlbum": _choice("last", "last", "default"),
        "confirmDelete": _bool(True),
        "thumbSize": _int(420, 200, 800),
        "thumbQuality": _int(82, 40, 95),
    },
    "generation": {
        "model": _choice("nai-diffusion-5-full", "nai-diffusion-5-full", "nai-diffusion-5-curated"),
        "v5Mode": _choice("anime", "anime", "furry"),
        "quality": _choice("gallery", "off", "official", "gallery"),
        "preset": _choice("Normal", "Small", "Normal", "Large"),
        "aspect": _choice("port", "port", "land", "square"),
        "sampler": _choice(
            "k_euler_ancestral",
            "k_euler_ancestral",
            "k_euler",
            "k_dpmpp_2s_ancestral",
            "k_dpmpp_2m",
            "k_dpmpp_2m_sde",
            "k_dpmpp_sde",
        ),
        "noiseSchedule": _choice("karras", "karras", "native", "exponential", "polyexponential"),
        "steps": _int(28, 1, 50),
        "scale": _float(5, 0, 30),
        "cfgRescale": _float(0, 0, 1),
        "nSamples": _int(1, 1, 4),
        "ucPreset": _choice("heavy", "heavy", "comic", "none"),
        "draftSave": _bool(True),
        "draftDebounceMs": _int(1200, 300, 5000),
        "concurrency": _int(1, 1, 3),
        "timeoutSec": _int(180, 30, 600),
        "jobsKeep": _int(80, 20, 500),
        "autoOpenJobs": _bool(False),
        "streamPreview": _bool(True),
        "tokenWarn": _bool(True),
    },
    "lottery": {
        "min": _int(3, 1, 50),
        "max": _int(5, 1, 50),
        "draws": _int(8, 1, 50),
        "target": _float(1, 0.01, 99),
        "wmin": _float(0.05, 0.01, 99),
        "wmax": _float(1, 0.01, 99),
        "jitter": _float(0.6, 0, 1),
        "boost": _float(0.4, 0, 1),
        "confirmDelete": _bool(False),
    },
    "basket": {
        "separator": _choice("comma", "comma", "newline", "space"),
        "underscoreToSpace": _bool(False),
        "escapeParens": _bool(False),
        "autoOpen": _bool(False),
    },
    "layout": {
        "leftWidth": _int(392, 300, 640),
        "histWidth": _int(268, 108, 480),
        "rememberWidths": _bool(True),
    },
    "account": {
        "quotaRefreshSec": _int(60, 15, 600),
        "statusTtlSec": _int(45, 10, 300),
        "showBattery": _bool(True),
    },
    "system": {
        "ssePingSec": _int(15, 5, 60),
        "importConcurrency": _int(2, 1, 6),
    },
}


def defaults() -> dict[str, dict[str, Any]]:
    return {section: {key: spec.default for key, spec in keys.items()} for section, keys in SCHEMA.items()}


def normalize(data: Any) -> dict[str, dict[str, Any]]:
    """把存储里读出来的（可能缺字段或含未知字段的）数据补全成完整设置。"""
    src = data if isinstance(data, dict) else {}
    out = defaults()
    for section, keys in SCHEMA.items():
        part = src.get(section)
        if not isinstance(part, dict):
            continue
        for key, spec in keys.items():
            if key in part:
                out[section][key] = spec.coerce(part[key])
    return out


def clean_patch(patch: Any) -> dict[str, dict[str, Any]]:
    """只保留已知分组/字段，并校验值；未知项直接丢弃。"""
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(patch, dict):
        return out
    for section, keys in SCHEMA.items():
        part = patch.get(section)
        if not isinstance(part, dict):
            continue
        cleaned = {key: spec.coerce(part[key]) for key, spec in keys.items() if key in part}
        if cleaned:
            out[section] = cleaned
    return out
