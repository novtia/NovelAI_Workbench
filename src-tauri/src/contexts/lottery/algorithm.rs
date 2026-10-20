//! 抽奖算法：和 Python 版逐行对应，随机数用 CPython 的 MT19937，保证同一个种子抽出同样的结果。

use crate::kernel::hashes::sha256_text;
use crate::pyjson::canonical_json;
use crate::pyrandom::PyRandom;
use crate::util::{get, num_f, round_half_even, to_float, truthy};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

pub const SCALE: i64 = 100;

static ARTIST_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^artist\s*:\s*").unwrap());
static WS_UNDERSCORE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[_\s]+").unwrap());
static TRAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"[:：\s]+$").unwrap());
static LEAD: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[:：\s]+").unwrap());
static BLOCK: Lazy<Regex> = Lazy::new(|| Regex::new(r"(-?\d*\.?\d+)\s*::\s*([\s\S]*?)\s*::").unwrap());
static SPLIT: Lazy<Regex> = Lazy::new(|| Regex::new(r"[,，\n\r]+").unwrap());
static OPEN_BLOCK: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(-?\d*\.?\d+)\s*::\s*(.+)$").unwrap());
static ENDS_DIGIT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\d$").unwrap());

pub fn fmt2(cents: i64) -> String {
    format!("{:.2}", cents as f64 / SCALE as f64)
}

pub fn clean_tag(raw: &str) -> String {
    let a = TRAIL.replace(raw, "");
    LEAD.replace(&a, "").trim().to_string()
}

pub fn strip_artist(tag: &str) -> String {
    let mut t = tag.to_string();
    while let Some(m) = ARTIST_PREFIX.find(&t) {
        t = t[m.end()..].to_string();
    }
    t.trim().to_string()
}

pub fn tag_key(tag: &str) -> String {
    WS_UNDERSCORE.replace_all(&strip_artist(tag).to_lowercase(), " ").trim().to_string()
}

pub fn format_tags(tags: &[String]) -> String {
    let prefixed = tags.iter().any(|t| ARTIST_PREFIX.is_match(t));
    let bare: Vec<String> = tags.iter().map(|t| strip_artist(t)).filter(|t| !t.is_empty()).collect();
    if bare.is_empty() {
        return String::new();
    }
    format!("{}{}", if prefixed { "artist:" } else { "" }, bare.join(", "))
}

pub fn pad_numeric_closers(text: &str) -> String {
    BLOCK
        .replace_all(text, |caps: &regex::Captures| {
            let mut body = caps[2].trim_end().to_string();
            if ENDS_DIGIT.is_match(&body) {
                body.push(' ');
            }
            format!("{}::{}::", &caps[1], body)
        })
        .to_string()
}

fn split_tags(chunk: &str) -> Vec<String> {
    SPLIT.split(chunk).map(clean_tag).filter(|s| !s.is_empty()).collect()
}

pub struct Entry {
    pub weight: f64,
    pub tags: Vec<String>,
}

pub fn parse_entries(text: &str) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();

    fn push_loose(chunk: &str, entries: &mut Vec<Entry>) {
        for piece in SPLIT.split(chunk) {
            if let Some(m) = OPEN_BLOCK.captures(piece.trim()) {
                let tag = clean_tag(&m[2]);
                if !tag.is_empty() {
                    entries.push(Entry { weight: m[1].parse().unwrap_or(1.0), tags: vec![tag] });
                }
                continue;
            }
            let tag = clean_tag(piece);
            if !tag.is_empty() {
                entries.push(Entry { weight: 1.0, tags: vec![tag] });
            }
        }
    }

    let mut cursor = 0usize;
    for m in BLOCK.captures_iter(text) {
        let whole = m.get(0).unwrap();
        push_loose(&text[cursor..whole.start()], &mut entries);
        let tags = split_tags(&m[2]);
        if !tags.is_empty() {
            entries.push(Entry { weight: m[1].parse().unwrap_or(1.0), tags });
        }
        cursor = whole.end();
    }
    push_loose(&text[cursor..], &mut entries);
    entries
}

pub fn effective_of(weight: f64, boost: f64) -> f64 {
    if weight > 1.0 {
        weight * (1.0 + boost)
    } else {
        weight
    }
}

fn personal_cap(per_max: &[Option<i64>], i: usize) -> Option<i64> {
    if per_max.is_empty() {
        return None;
    }
    per_max[i]
}

pub struct Allocation {
    pub cents: Vec<i64>,
    pub ideal: Vec<f64>,
}

pub fn allocate(
    effectives: &[f64],
    units: &[i64],
    target: f64,
    min_cents: Option<i64>,
    max_cents: Option<i64>,
    per_max: &[Option<i64>],
) -> Allocation {
    let n = effectives.len();
    let target_cents = round_half_even(target * SCALE as f64) as i64;
    let active: Vec<bool> = effectives.iter().map(|w| *w > 0.0).collect();
    let mut billed_units: i64 = 0;
    for (i, u) in units.iter().enumerate() {
        if !active[i] || personal_cap(per_max, i) == Some(0) {
            continue;
        }
        billed_units += u;
    }
    let mut floor = match min_cents {
        None => 1,
        Some(m) => 1.max(m),
    };
    let mut cap = match max_cents {
        None => target_cents,
        Some(m) => floor.max(m),
    };
    if billed_units > 0 && floor * billed_units > target_cents {
        floor = 1.max(target_cents.div_euclid(billed_units));
    }
    if billed_units > 0 && cap * billed_units < target_cents {
        cap = floor.max(-((-target_cents).div_euclid(billed_units)));
    }
    if n == 0 {
        return Allocation { cents: vec![], ideal: vec![] };
    }

    let mut caps: Vec<i64> = Vec::with_capacity(n);
    for i in 0..n {
        if !active[i] {
            caps.push(0);
            continue;
        }
        match personal_cap(per_max, i) {
            None => caps.push(cap),
            Some(hard) => caps.push(0.max(hard.min(cap))),
        }
    }
    let floors: Vec<i64> = (0..n).map(|i| if active[i] { floor.min(caps[i]) } else { 0 }).collect();

    let max_possible: i64 = (0..n).map(|i| caps[i] * units[i]).sum();
    if max_possible < target_cents {
        let free: Vec<usize> = (0..n).filter(|&i| active[i] && personal_cap(per_max, i).is_none()).collect();
        let mut need = target_cents - max_possible;
        let mut guard_raise = 0;
        while need > 0 && !free.is_empty() && guard_raise < 100000 {
            guard_raise += 1;
            let mut progressed = false;
            for &i in &free {
                if need <= 0 {
                    break;
                }
                if units[i] > need {
                    continue;
                }
                caps[i] += 1;
                need -= units[i];
                progressed = true;
            }
            if !progressed {
                break;
            }
        }
    }

    let total: f64 = effectives.iter().enumerate().map(|(i, w)| w * units[i] as f64).sum();
    if total <= 0.0 {
        return Allocation { cents: vec![0; n], ideal: vec![0.0; n] };
    }

    let ideal: Vec<f64> = effectives.iter().map(|w| (target_cents as f64 * w) / total).collect();
    let mut cents: Vec<i64> = (0..n)
        .map(|i| if active[i] { caps[i].min(floors[i].max((ideal[i] + 1e-9) as i64)) } else { 0 })
        .collect();

    let used = |cents: &Vec<i64>| -> i64 { (0..n).map(|i| cents[i] * units[i]).sum() };
    let mut leftover = target_cents - used(&cents);
    let mut guard = 0;
    while leftover > 0 && guard < 100000 {
        guard += 1;
        let mut pick: Option<usize> = None;
        let mut best_frac = f64::NEG_INFINITY;
        for i in 0..n {
            if units[i] > leftover || !active[i] || cents[i] >= caps[i] {
                continue;
            }
            let frac = ideal[i] - cents[i] as f64;
            if frac > best_frac {
                best_frac = frac;
                pick = Some(i);
            }
        }
        let Some(p) = pick else { break };
        cents[p] += 1;
        leftover -= units[p];
    }

    while leftover < 0 && guard < 100000 {
        guard += 1;
        let mut pick: Option<usize> = None;
        let mut best_frac = f64::INFINITY;
        for i in 0..n {
            if units[i] > -leftover {
                continue;
            }
            if cents[i] <= floors[i] {
                continue;
            }
            let frac = ideal[i] - cents[i] as f64;
            if frac < best_frac {
                best_frac = frac;
                pick = Some(i);
            }
        }
        let Some(p) = pick else { break };
        cents[p] -= 1;
        leftover += units[p];
    }

    Allocation { cents, ideal }
}

struct DrawEntry {
    tags: Vec<String>,
    weight: f64,
}

fn assemble(
    entries: &[DrawEntry],
    effectives: &[f64],
    units: &[i64],
    target: f64,
    min_cents: Option<i64>,
    max_cents: Option<i64>,
    per_max: &[Option<i64>],
) -> Value {
    let allocated = allocate(effectives, units, target, min_cents, max_cents, per_max);
    let cents = &allocated.cents;
    let rows: Vec<Value> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| {
            json!({
                "tags": e.tags,
                "count": e.tags.len(),
                "unit": units[i],
                "weight": num_f(e.weight),
                "cents": cents[i],
            })
        })
        .collect();
    let new_cents: i64 = entries.iter().enumerate().map(|(i, _)| cents[i] * units[i]).sum();
    let target_cents = round_half_even(target * SCALE as f64) as i64;
    let artist_count: usize = entries.iter().map(|e| e.tags.len()).sum();
    let joined = entries
        .iter()
        .enumerate()
        .map(|(i, e)| format!("{}::{}::", fmt2(cents[i]), format_tags(&e.tags)))
        .collect::<Vec<_>>()
        .join(", ");
    json!({
        "rows": rows,
        "outputText": pad_numeric_closers(&joined),
        "newCents": new_cents,
        "targetCents": target_cents,
        "diffCents": target_cents - new_cents,
        "artistCount": artist_count,
    })
}

pub fn shuffle<T: Clone>(rng: &mut PyRandom, arr: &[T]) -> Vec<T> {
    let mut a = arr.to_vec();
    let len = a.len();
    for i in (1..len).rev() {
        let j = rng.randrange(i as i64 + 1) as usize;
        a.swap(i, j);
    }
    a
}

pub fn fit_weight_bounds(n: usize, target: f64, min_weight: Option<f64>, max_weight: Option<f64>) -> (f64, f64) {
    let t = target;
    let mut lo = min_weight.unwrap_or(0.01);
    let mut hi = max_weight.unwrap_or(t);
    if lo.is_nan() || lo < 0.01 {
        lo = 0.01;
    }
    if hi.is_nan() || hi < 0.01 {
        hi = t;
    }
    if lo > hi {
        std::mem::swap(&mut lo, &mut hi);
    }
    let size = n.max(1) as f64;
    if size * lo > t {
        lo = t / size;
    }
    if size * hi < t {
        hi = t / size;
    }
    if lo > hi {
        hi = lo;
    }
    (lo, hi)
}

fn tag_or_name(p: &Value) -> String {
    let v = if truthy(get(p, "tag")) { get(p, "tag") } else { get(p, "name") };
    if truthy(v) {
        crate::util::py_str(v)
    } else {
        String::new()
    }
}

fn key_of(p: &Value) -> String {
    let v = if truthy(get(p, "tag")) {
        get(p, "tag")
    } else if truthy(get(p, "name")) {
        get(p, "name")
    } else {
        get(p, "key")
    };
    tag_key(&if truthy(v) { crate::util::py_str(v) } else { String::new() })
}

pub struct DrawParams {
    pub fixed: Vec<Value>,
    pub n: Option<f64>,
    pub count: Option<f64>,
    pub jitter: f64,
    pub boost: f64,
    pub target: Option<f64>,
    pub min_weight: Option<f64>,
    pub max_weight: Option<f64>,
}

pub fn draw_from_pool(pool: &[Value], params: &DrawParams, rng: &mut PyRandom) -> Vec<Value> {
    let mut seen: Vec<String> = Vec::new();
    let mut locked: Vec<Value> = Vec::new();
    for p in &params.fixed {
        let k = key_of(p);
        if k.is_empty() || seen.contains(&k) {
            continue;
        }
        seen.push(k);
        locked.push(p.clone());
    }
    let rest: Vec<Value> = pool
        .iter()
        .filter(|p| {
            let k = key_of(p);
            !k.is_empty() && !seen.contains(&k)
        })
        .cloned()
        .collect();
    if locked.is_empty() && rest.is_empty() {
        return vec![];
    }
    let n_raw = params.n.filter(|v| *v != 0.0).unwrap_or(1.0);
    let want_rounded = round_half_even(n_raw) as i64;
    let want = (if want_rounded == 0 { 1 } else { want_rounded }).max(1);
    let size = (want.max(locked.len() as i64)).min((locked.len() + rest.len()) as i64);
    if size <= 0 {
        return vec![];
    }
    let extra = (size - locked.len() as i64).max(0) as usize;
    let c_raw = params.count.filter(|v| *v != 0.0).unwrap_or(1.0);
    let c_rounded = round_half_even(c_raw) as i64;
    let draws = (if c_rounded == 0 { 1 } else { c_rounded }).max(1).min(50);
    let jit = params.jitter.max(0.0).min(1.0);
    let b = params.boost.max(0.0);
    let Some(t) = params.target else { return vec![] };
    if t.is_nan() || t <= 0.0 {
        return vec![];
    }
    let (lo, hi) = fit_weight_bounds(size as usize, t, params.min_weight, params.max_weight);
    let min_cents = 1.max(round_half_even(lo * SCALE as f64) as i64);
    let max_cents = min_cents.max(round_half_even(hi * SCALE as f64) as i64);

    let mut out = Vec::new();
    for _ in 0..draws {
        let picked: Vec<Value> = if extra > 0 {
            let mut v = locked.clone();
            v.extend(shuffle(rng, &rest).into_iter().take(extra));
            v
        } else {
            locked.clone()
        };
        let entries: Vec<DrawEntry> = picked
            .iter()
            .map(|p| {
                let w = to_float(get(p, "weight")).filter(|w| *w > 0.0).unwrap_or(0.0);
                DrawEntry {
                    weight: if w > 0.0 { w } else { 1.0 },
                    tags: vec![format!("artist:{}", strip_artist(&tag_or_name(p)))],
                }
            })
            .collect();
        let units: Vec<i64> = vec![1; entries.len()];
        let mut rolled: Vec<f64> = Vec::with_capacity(entries.len());
        for e in &entries {
            let w = effective_of(e.weight, b);
            let factor = 1.0 - jit + rng.random() * jit * 2.0;
            rolled.push((w * factor).max(0.01));
        }
        let per_max: Vec<Option<i64>> = picked
            .iter()
            .map(|p| {
                let mw = get(p, "maxWeight");
                if mw.is_null() {
                    return None;
                }
                let cap = to_float(mw)?;
                if cap.is_nan() || cap < 0.0 {
                    None
                } else {
                    Some(0.max(round_half_even(cap * SCALE as f64) as i64))
                }
            })
            .collect();
        let mut assembled = assemble(&entries, &rolled, &units, t, Some(min_cents), Some(max_cents), &per_max);
        assembled["artists"] = json!(picked.iter().map(|p| strip_artist(&tag_or_name(p))).collect::<Vec<_>>());
        out.push(assembled);
    }
    out
}

pub fn pool_hash(pool: &[Value]) -> String {
    let mut keys: Vec<String> = pool
        .iter()
        .filter(|p| truthy(p))
        .map(|p| tag_key(&tag_or_name(p)))
        .collect();
    keys.sort();
    keys.dedup();
    sha256_text(&canonical_json(&json!(keys)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_weighted_blocks() {
        let e = parse_entries("1.2::a, b::, c, 0.5::d");
        assert_eq!(e.len(), 3);
        assert_eq!(e[0].tags, vec!["a", "b"]);
        assert_eq!(e[0].weight, 1.2);
        assert_eq!(e[1].tags, vec!["c"]);
        assert_eq!(e[2].tags, vec!["d"]);
    }

    #[test]
    fn allocation_hits_target() {
        let a = allocate(&[1.0, 1.0, 1.0], &[1, 1, 1], 1.0, Some(5), Some(60), &[]);
        assert_eq!(a.cents.iter().sum::<i64>(), 100);
    }

    #[test]
    fn pad_closers_adds_space_after_digit() {
        assert_eq!(pad_numeric_closers("0.50::artist:x1::"), "0.50::artist:x1 ::");
    }
}
