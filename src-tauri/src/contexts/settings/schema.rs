//! 设置项的唯一定义：分组、类型、默认值、范围。服务端据此校验并 clamp，前端默认值需与这里对齐。

use crate::util::{round4, round_half_even, to_float};
use once_cell::sync::Lazy;
use serde_json::{json, Map, Value};

#[derive(Clone)]
pub enum Kind {
    Bool,
    Int,
    Float,
    Choice(Vec<Value>),
    Str,
}

#[derive(Clone)]
pub struct Spec {
    pub kind: Kind,
    pub default: Value,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

fn same_json_type(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::String(_), Value::String(_)) => a == b,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => {
            let xi = x.is_i64() || x.is_u64();
            let yi = y.is_i64() || y.is_u64();
            xi == yi && x.as_f64() == y.as_f64()
        }
        _ => false,
    }
}

impl Spec {
    /// 把任意输入规整成合法值；不合法时返回默认值。
    pub fn coerce(&self, value: &Value) -> Value {
        match &self.kind {
            Kind::Str => match value {
                Value::String(s) => match self.max {
                    Some(m) => Value::String(s.chars().take(m as usize).collect()),
                    None => value.clone(),
                },
                _ => self.default.clone(),
            },
            Kind::Bool => match value {
                Value::Bool(_) => value.clone(),
                Value::Number(n) => match n.as_f64() {
                    Some(f) if f == 0.0 || f == 1.0 => Value::Bool(f == 1.0),
                    _ => self.default.clone(),
                },
                _ => self.default.clone(),
            },
            Kind::Choice(choices) => {
                for c in choices {
                    if same_json_type(value, c) {
                        return c.clone();
                    }
                }
                self.default.clone()
            }
            Kind::Int | Kind::Float => {
                if value.is_boolean() {
                    return self.default.clone();
                }
                let Some(mut number) = to_float(value) else {
                    return self.default.clone();
                };
                if !number.is_finite() {
                    return self.default.clone();
                }
                // Python 的 `max(lo, number)` / `min(hi, number)` 在相等时返回第一个参数，
                // 所以刚好落在整数边界上的浮点数会变回边界本身的整数类型（如 cfgRescale = 0 而不是 0.0）。
                let mut int_typed = false;
                if let Some(lo) = self.min {
                    if lo >= number {
                        number = lo;
                        int_typed = lo.fract() == 0.0;
                    }
                }
                if let Some(hi) = self.max {
                    if hi <= number {
                        number = hi;
                        int_typed = hi.fract() == 0.0;
                    }
                }
                if matches!(self.kind, Kind::Int) {
                    json!(round_half_even(number) as i64)
                } else if int_typed {
                    json!(number as i64)
                } else {
                    crate::util::num_f(round4(number))
                }
            }
        }
    }
}

fn spec(kind: Kind, default: Value, min: Option<f64>, max: Option<f64>) -> Spec {
    Spec { kind, default, min, max }
}

fn bool_(d: bool) -> Spec {
    spec(Kind::Bool, json!(d), None, None)
}

fn int(d: i64, lo: i64, hi: i64) -> Spec {
    spec(Kind::Int, json!(d), Some(lo as f64), Some(hi as f64))
}

/// 默认值保持 Python 里的写法：整数默认值（如 5、0、1）仍然是整数，才能和旧数据逐字节一致。
fn float(d: Value, lo: f64, hi: f64) -> Spec {
    spec(Kind::Float, d, Some(lo), Some(hi))
}

fn choice(default: Value, choices: &[Value]) -> Spec {
    spec(Kind::Choice(choices.to_vec()), default, None, None)
}

fn strs(default: &str, choices: &[&str]) -> Spec {
    choice(json!(default), &choices.iter().map(|c| json!(c)).collect::<Vec<_>>())
}

fn str_(d: &str, max_len: usize) -> Spec {
    spec(Kind::Str, json!(d), None, Some(max_len as f64))
}

pub type Section = Vec<(&'static str, Spec)>;

const SAMPLERS: [&str; 6] =
    ["k_euler_ancestral", "k_euler", "k_dpmpp_2s_ancestral", "k_dpmpp_2m", "k_dpmpp_2m_sde", "k_dpmpp_sde"];
const SCHEDULES: [&str; 4] = ["karras", "native", "exponential", "polyexponential"];

pub static SCHEMA: Lazy<Vec<(&'static str, Section)>> = Lazy::new(|| {
    vec![
        (
            "appearance",
            vec![
                ("theme", strs("light", &["light", "dark", "auto"])),
                ("font", strs("serif", &["serif", "sans"])),
                ("liveInk", bool_(true)),
                ("grain", bool_(true)),
                ("reduceMotion", bool_(false)),
                ("sidebarLabels", bool_(true)),
                ("toastMs", int(3200, 1500, 10000)),
            ],
        ),
        (
            "gallery",
            vec![
                ("density", strs("comfortable", &["comfortable", "compact"])),
                ("cardMinWidth", int(230, 150, 400)),
                ("sort", strs("added_desc", &["added_desc", "added_asc"])),
                ("pageSize", choice(json!(0), &[json!(0), json!(100), json!(200), json!(500)])),
                ("showArtists", bool_(true)),
                ("hoverPreview", bool_(true)),
                ("startAlbum", strs("last", &["last", "default"])),
                ("confirmDelete", bool_(true)),
                ("thumbSize", int(420, 200, 800)),
                ("thumbQuality", int(82, 40, 95)),
            ],
        ),
        (
            "generation",
            vec![
                ("model", strs("nai-diffusion-5-full", &["nai-diffusion-5-full", "nai-diffusion-5-curated"])),
                ("effort", strs("high", &["high", "medium"])),
                ("v5Mode", strs("anime", &["anime", "furry"])),
                ("quality", strs("gallery", &["off", "official", "gallery"])),
                ("preset", strs("Normal", &["Small", "Normal", "Large"])),
                ("aspect", strs("port", &["port", "land", "square"])),
                ("sampler", strs("k_euler_ancestral", &SAMPLERS)),
                ("noiseSchedule", strs("karras", &SCHEDULES)),
                ("steps", int(28, 1, 50)),
                ("scale", float(json!(5), 0.0, 30.0)),
                ("cfgRescale", float(json!(0), 0.0, 1.0)),
                ("nSamples", int(1, 1, 4)),
                ("ucPreset", strs("heavy", &["heavy", "comic", "none"])),
                ("draftSave", bool_(true)),
                ("draftDebounceMs", int(1200, 300, 5000)),
                ("concurrency", int(1, 1, 3)),
                ("timeoutSec", int(180, 30, 600)),
                ("jobsKeep", int(80, 20, 500)),
                ("autoOpenJobs", bool_(false)),
                ("streamPreview", bool_(true)),
                ("tokenWarn", bool_(true)),
            ],
        ),
        (
            "artistTest",
            vec![
                ("presetId", str_("", 64)),
                ("prompt", str_("", 2000)),
                ("character", str_("girl, solo", 500)),
                ("ucPreset", strs("heavy", &["heavy", "comic", "none"])),
                ("model", strs("nai-diffusion-5-full", &["nai-diffusion-5-full", "nai-diffusion-5-curated"])),
                ("effort", strs("high", &["high", "medium"])),
                ("v5Mode", strs("anime", &["anime", "furry"])),
                ("quality", strs("gallery", &["off", "official", "gallery"])),
                ("preset", strs("Normal", &["Small", "Normal", "Large"])),
                ("aspect", strs("port", &["port", "land", "square"])),
                ("sampler", strs("k_euler_ancestral", &SAMPLERS)),
                ("noiseSchedule", strs("karras", &SCHEDULES)),
                ("steps", int(28, 1, 50)),
                ("scale", float(json!(5), 0.0, 30.0)),
                ("cfgRescale", float(json!(0), 0.0, 1.0)),
                ("seed", int(-1, -1, 4294967295)),
            ],
        ),
        (
            "lottery",
            vec![
                ("min", int(3, 1, 50)),
                ("max", int(5, 1, 50)),
                ("draws", int(8, 1, 50)),
                ("target", float(json!(1), 0.01, 99.0)),
                ("wmin", float(json!(0.05), 0.01, 99.0)),
                ("wmax", float(json!(1), 0.01, 99.0)),
                ("jitter", float(json!(0.6), 0.0, 1.0)),
                ("boost", float(json!(0.4), 0.0, 1.0)),
                ("confirmDelete", bool_(false)),
            ],
        ),
        (
            "basket",
            vec![
                ("separator", strs("comma", &["comma", "newline", "space"])),
                ("underscoreToSpace", bool_(false)),
                ("escapeParens", bool_(false)),
                ("autoOpen", bool_(false)),
            ],
        ),
        (
            "layout",
            vec![("leftWidth", int(392, 300, 640)), ("histWidth", int(268, 108, 480)), ("rememberWidths", bool_(true))],
        ),
        (
            "account",
            vec![
                ("gatewayUrl", str_("", 200)),
                ("quotaRefreshSec", int(60, 15, 600)),
                ("statusTtlSec", int(45, 10, 300)),
                ("showBattery", bool_(true)),
            ],
        ),
        ("system", vec![("ssePingSec", int(15, 5, 60)), ("importConcurrency", int(2, 1, 6))]),
    ]
});

pub fn section_names() -> Vec<&'static str> {
    SCHEMA.iter().map(|(n, _)| *n).collect()
}

pub fn has_section(name: &str) -> bool {
    SCHEMA.iter().any(|(n, _)| *n == name)
}

pub fn section_spec(name: &str) -> Option<&'static Section> {
    SCHEMA.iter().find(|(n, _)| *n == name).map(|(_, s)| s)
}

pub fn spec_of(section: &str, key: &str) -> Option<&'static Spec> {
    section_spec(section)?.iter().find(|(k, _)| *k == key).map(|(_, s)| s)
}

pub fn defaults() -> Value {
    let mut out = Map::new();
    for (name, keys) in SCHEMA.iter() {
        let mut part = Map::new();
        for (k, s) in keys {
            part.insert((*k).to_string(), s.default.clone());
        }
        out.insert((*name).to_string(), Value::Object(part));
    }
    Value::Object(out)
}

pub fn section_defaults(name: &str) -> Value {
    defaults().get(name).cloned().unwrap_or_else(|| json!({}))
}

/// 把存储里读出来的（可能缺字段或含未知字段的）数据补全成完整设置。
pub fn normalize(data: &Value) -> Value {
    let mut out = defaults();
    for (name, keys) in SCHEMA.iter() {
        let Some(part) = data.get(*name).and_then(|v| v.as_object()) else {
            continue;
        };
        for (k, s) in keys {
            if let Some(v) = part.get(*k) {
                out[*name][*k] = s.coerce(v);
            }
        }
    }
    out
}

/// 只保留已知分组/字段，并校验值；未知项直接丢弃。
pub fn clean_patch(patch: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if !patch.is_object() {
        return out;
    }
    for (name, keys) in SCHEMA.iter() {
        let Some(part) = patch.get(*name).and_then(|v| v.as_object()) else {
            continue;
        };
        let mut cleaned = Map::new();
        for (k, s) in keys {
            if let Some(v) = part.get(*k) {
                cleaned.insert((*k).to_string(), s.coerce(v));
            }
        }
        if !cleaned.is_empty() {
            out.insert((*name).to_string(), Value::Object(cleaned));
        }
    }
    out
}

/// Python 的 `==`：数值按大小比较（`5 == 5.0`），容器递归比较。
pub fn py_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            if let (Some(i), Some(j)) = (x.as_i64(), y.as_i64()) {
                i == j
            } else {
                x.as_f64() == y.as_f64()
            }
        }
        (Value::Bool(x), Value::Number(y)) | (Value::Number(y), Value::Bool(x)) => {
            y.as_f64() == Some(if *x { 1.0 } else { 0.0 })
        }
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| py_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).map(|w| py_eq(v, w)).unwrap_or(false))
        }
        _ => a == b,
    }
}
