//! 处理 JSON 值时对 Python 语义的一些小工具（真值判断、`int()`、`str()`、`round()`）。

use crate::pyjson;
use serde_json::{Map, Value};

/// Python 的真值判断：None / False / 0 / 0.0 / "" / [] / {} 都是假。
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i != 0
            } else if let Some(u) = n.as_u64() {
                u != 0
            } else {
                n.as_f64().map(|f| f != 0.0).unwrap_or(false)
            }
        }
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `d.get(key)`，缺失时是 Null。
pub fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
    static NULL: Value = Value::Null;
    v.get(key).unwrap_or(&NULL)
}

pub fn has_value(v: &Value, key: &str) -> bool {
    !get(v, key).is_null()
}

/// `int(value)`：数字取整（向零截断），数字字符串按整数解析，其余失败。
pub fn to_int(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(i)
            } else if let Some(u) = n.as_u64() {
                i64::try_from(u).ok()
            } else {
                let f = n.as_f64()?;
                if f.is_finite() {
                    Some(f.trunc() as i64)
                } else {
                    None
                }
            }
        }
        Value::String(s) => s.trim().parse::<i64>().ok(),
        Value::Bool(b) => Some(*b as i64),
        _ => None,
    }
}

/// `float(value)`
pub fn to_float(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(*b as i64 as f64),
        _ => None,
    }
}

/// `str(value)`（容器类型只做近似）。
pub fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::String(s) => s.clone(),
        Value::Number(_) => pyjson::dumps(v),
        _ => pyjson::dumps(v),
    }
}

/// `str(d.get(key) or "")`
pub fn str_or_empty(v: &Value, key: &str) -> String {
    let x = get(v, key);
    if truthy(x) {
        py_str(x)
    } else {
        String::new()
    }
}

/// `s[:n]`（按字符数截断）
pub fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Python `round(x)`：四舍六入五成双。
pub fn round_half_even(x: f64) -> f64 {
    x.round_ties_even()
}

/// Python `round(x, 4)`：按精确十进制值四舍六入五成双。
pub fn round4(x: f64) -> f64 {
    format!("{x:.4}").parse::<f64>().unwrap_or(x)
}

pub fn num_f(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

pub fn obj() -> Map<String, Value> {
    Map::new()
}

pub fn as_obj(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

/// 把 Rust 里存的旧式 `/api/...` 资源地址换成自定义协议地址，仅用于返回给前端的数据。
pub fn to_client(mut v: Value) -> Value {
    rewrite_urls(&mut v);
    v
}

fn rewrite_urls(v: &mut Value) {
    match v {
        Value::String(s) => {
            if let Some(new) = crate::assets::rewrite_legacy(s) {
                *s = new;
            }
        }
        Value::Array(a) => a.iter_mut().for_each(rewrite_urls),
        Value::Object(o) => o.iter_mut().for_each(|(_, x)| rewrite_urls(x)),
        _ => {}
    }
}

/// JSON 值 -> SQLite 参数（对应 Python sqlite3 对 int / float / str / None 的绑定）。
pub fn sql(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as S;
    match v {
        Value::Null => S::Null,
        Value::Bool(b) => S::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                S::Integer(i)
            } else if let Some(f) = n.as_f64() {
                S::Real(f)
            } else {
                S::Null
            }
        }
        Value::String(s) => S::Text(s.clone()),
        other => S::Text(pyjson::dumps(other)),
    }
}

/// `x or default`
pub fn or_else<'a>(v: &'a Value, default: &'a Value) -> &'a Value {
    if truthy(v) {
        v
    } else {
        default
    }
}
/// `re.sub(r"[_\s]+", " ", s.lower()).strip()`
pub fn collapse_ws_lower(s: &str) -> String {
    use once_cell::sync::Lazy;
    static RE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"[_\s]+").unwrap());
    RE.replace_all(&s.to_lowercase(), " ").trim().to_string()
}