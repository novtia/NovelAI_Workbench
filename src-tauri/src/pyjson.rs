//! 与 CPython `json.dumps` 逐字节一致的序列化。
//!
//! 事件哈希链依赖 `json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`，
//! 任何一个字节不同都会让旧库的校验失败，所以这里不能直接用 serde_json 的输出。

use serde_json::Value;

/// CPython `float.__repr__`：最短往返数字；指数 < -4 或 >= 16 时用科学计数法（`1e-05`、`1e+16`）。
pub fn float_repr(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let sci = format!("{:e}", x.abs());
    let (mant, exp) = sci.split_once('e').expect("LowerExp 一定带 e");
    let exp: i32 = exp.parse().expect("指数是整数");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let n = digits.len() as i32;
    let sign = if x < 0.0 { "-" } else { "" };
    if !(-4..16).contains(&exp) {
        let m = if n == 1 { digits.clone() } else { format!("{}.{}", &digits[..1], &digits[1..]) };
        let es = if exp < 0 { '-' } else { '+' };
        return format!("{sign}{m}e{es}{:02}", exp.abs());
    }
    if exp >= 0 {
        let int_len = exp + 1;
        if n <= int_len {
            let zeros = "0".repeat((int_len - n) as usize);
            format!("{sign}{digits}{zeros}.0")
        } else {
            format!("{sign}{}.{}", &digits[..int_len as usize], &digits[int_len as usize..])
        }
    } else {
        let zeros = "0".repeat((-exp - 1) as usize);
        format!("{sign}0.{zeros}{digits}")
    }
}

fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_value(v: &Value, out: &mut String, sort_keys: bool, item_sep: &str, key_sep: &str) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else {
                out.push_str(&float_repr(n.as_f64().unwrap_or(0.0)));
            }
        }
        Value::String(s) => write_str(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                write_value(item, out, sort_keys, item_sep, key_sep);
            }
            out.push(']');
        }
        Value::Object(m) => {
            out.push('{');
            let mut entries: Vec<(&String, &Value)> = m.iter().collect();
            if sort_keys {
                entries.sort_by(|a, b| a.0.cmp(b.0));
            }
            for (i, (k, val)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                write_str(k, out);
                out.push_str(key_sep);
                write_value(val, out, sort_keys, item_sep, key_sep);
            }
            out.push('}');
        }
    }
}

/// `json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write_value(v, &mut out, true, ",", ":");
    out
}

/// `json.dumps(value, ensure_ascii=False)`：默认分隔符 `, ` / `: `，保持插入顺序。
pub fn dumps(v: &Value) -> String {
    let mut out = String::new();
    write_value(v, &mut out, false, ", ", ": ");
    out
}

/// `json.dumps(value, ensure_ascii=False, sort_keys=True)`
pub fn dumps_sorted(v: &Value) -> String {
    let mut out = String::new();
    write_value(v, &mut out, true, ", ", ": ");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn float_repr_matches_python() {
        let cases: &[(f64, &str)] = &[
            (1.0, "1.0"),
            (0.1, "0.1"),
            (5.0, "5.0"),
            (0.05, "0.05"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (1.5e-7, "1.5e-07"),
            (1e15, "1000000000000000.0"),
            (1e16, "1e+16"),
            (1.2345678901234568e17, "1.2345678901234568e+17"),
            (123456.789, "123456.789"),
            (-2.5, "-2.5"),
            (0.0, "0.0"),
            (1e22, "1e+22"),
            (100.0, "100.0"),
            (0.6394267984578837, "0.6394267984578837"),
        ];
        for (x, want) in cases {
            assert_eq!(float_repr(*x), *want, "x={x}");
        }
    }

    #[test]
    fn canonical_sorts_and_escapes() {
        let v = json!({"b": 1, "a": [1.0, "中\n\u{1}", null, true], "c": {"z": 0.5, "y": 2}});
        assert_eq!(
            canonical_json(&v),
            "{\"a\":[1.0,\"中\\n\\u0001\",null,true],\"b\":1,\"c\":{\"y\":2,\"z\":0.5}}"
        );
    }

    #[test]
    fn dumps_uses_default_separators() {
        let v = json!({"b": [1, 2], "a": {}});
        assert_eq!(dumps(&v), "{\"b\": [1, 2], \"a\": {}}");
        assert_eq!(dumps_sorted(&v), "{\"a\": {}, \"b\": [1, 2]}");
    }
}
