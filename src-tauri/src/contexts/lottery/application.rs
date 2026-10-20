use super::algorithm::{draw_from_pool, parse_entries, pool_hash, tag_key, DrawParams};
use super::domain::{
    attach_job_previews, default_controls, stamp_draw_ids, DrawBatch, LotteryBoard, BOARD_ID,
};
use crate::contexts::gallery::application::GalleryService;
use crate::kernel::bus::Kernel;
use crate::kernel::clock::{new_id, now_ms};
use crate::kernel::{DomainError, Res};
use crate::pyjson::dumps;
use crate::pyrandom::PyRandom;
use crate::util::{get, has_value, num_f, py_str, to_float, to_int, truthy};
use rusqlite::{params, Row};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::sync::{Arc, RwLock};

pub type ControlsProvider = Arc<dyn Fn() -> Value + Send + Sync>;

pub struct LotteryService {
    k: Arc<Kernel>,
    gallery: Arc<GalleryService>,
    /// 「设置 → 抽奖」里的默认参数，只影响还没保存过的抽奖台和缺失的字段。
    default_controls_provider: RwLock<Option<ControlsProvider>>,
}

fn text_or(raw: Option<String>, fallback: &str) -> Value {
    let text = raw.filter(|s| !s.is_empty()).unwrap_or_else(|| fallback.to_string());
    serde_json::from_str(&text).unwrap_or_else(|_| serde_json::from_str(fallback).unwrap())
}

impl LotteryService {
    pub fn new(k: Arc<Kernel>, gallery: Arc<GalleryService>) -> Self {
        LotteryService { k, gallery, default_controls_provider: RwLock::new(None) }
    }

    pub fn set_default_controls(&self, provider: ControlsProvider) {
        *self.default_controls_provider.write().unwrap_or_else(|e| e.into_inner()) = Some(provider);
    }

    fn defaults(&self) -> Map<String, Value> {
        let mut out = default_controls();
        if let Some(p) = self.default_controls_provider.read().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let preferred = p();
            if let Some(o) = preferred.as_object() {
                for (k, v) in o {
                    if out.contains_key(k) {
                        out.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        out
    }

    pub fn board(&self) -> Res<Value> {
        let conn = self.k.store.connect()?;
        let row: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, i64)> = conn
            .query_row("SELECT * FROM projections_lottery_board WHERE id=?1", params![BOARD_ID], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })
            .ok();
        let Some((id, album_id, excluded, pinned, caps, controls, version)) = row else {
            return Ok(json!({
                "id": BOARD_ID,
                "albumId": Value::Null,
                "excluded": [],
                "pinned": [],
                "weightCaps": {},
                "controls": Value::Object(self.defaults()),
                "version": 0,
            }));
        };
        let mut merged = self.defaults();
        if let Some(o) = text_or(controls, "{}").as_object() {
            for (k, v) in o {
                merged.insert(k.clone(), v.clone());
            }
        }
        Ok(json!({
            "id": id,
            "albumId": album_id,
            "excluded": text_or(excluded, "[]"),
            "pinned": text_or(pinned, "[]"),
            "weightCaps": text_or(caps, "{}"),
            "controls": Value::Object(merged),
            "version": version,
        }))
    }

    pub fn configure(&self, data: &Value) -> Res<Value> {
        let mut board: LotteryBoard = self.k.load(BOARD_ID)?;
        board.configure(data);
        self.k.commit(&mut board, None)?;
        self.board()
    }

    pub fn list_batches(&self) -> Res<Vec<Value>> {
        let conn = self.k.store.connect()?;
        let mut batches = {
            let mut stmt =
                conn.prepare("SELECT * FROM projections_lottery_batches WHERE deleted=0 ORDER BY created_at DESC")?;
            let rows = stmt.query_map([], |r| self.batch_row(r))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            out
        };
        drop(conn);
        self.hydrate_draw_previews(&mut batches);
        Ok(batches)
    }

    pub fn get_batch(&self, batch_id: &str, include_deleted: bool) -> Res<Option<Value>> {
        let conn = self.k.store.connect()?;
        let found = {
            let mut stmt = conn.prepare("SELECT * FROM projections_lottery_batches WHERE id=?1")?;
            let mut rows = stmt.query_map(params![batch_id], |r| self.batch_row(r))?;
            match rows.next() {
                Some(r) => Some(r?),
                None => None,
            }
        };
        drop(conn);
        let Some(rec) = found else { return Ok(None) };
        if rec["deleted"].as_bool().unwrap_or(false) && !include_deleted {
            return Ok(None);
        }
        let mut one = vec![rec];
        self.hydrate_draw_previews(&mut one);
        Ok(one.pop())
    }

    pub fn artist_pool(&self, album_id: &str, weighted: bool) -> Res<Vec<Value>> {
        if !weighted {
            return self.gallery.pool_for_album(album_id);
        }
        let items = self.gallery.list_items(album_id, false, None, 0, "added_desc")?;
        let mut order: Vec<String> = Vec::new();
        let mut seen: std::collections::HashMap<String, (String, f64)> = std::collections::HashMap::new();
        for item in &items {
            let params_v = get(item, "params");
            let part = |v: &Value| if truthy(v) { py_str(v) } else { String::new() };
            let text = [
                part(get(params_v, "artistChain")),
                part(get(item, "artistLine")),
                part(get(params_v, "prompt")),
            ]
            .into_iter()
            .filter(|x| !x.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
            let mut weights: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
            for entry in parse_entries(&text) {
                for tag in &entry.tags {
                    let key = tag_key(tag);
                    if !key.is_empty() {
                        let cur = weights.get(&key).copied().unwrap_or(0.0);
                        weights.insert(key, if entry.weight > cur { entry.weight } else { cur });
                    }
                }
            }
            let mut local: BTreeSet<String> = BTreeSet::new();
            if let Some(names) = get(item, "artists").as_array() {
                for name in names {
                    let name = py_str(name);
                    let key = tag_key(&name);
                    if key.is_empty() || local.contains(&key) {
                        continue;
                    }
                    local.insert(key.clone());
                    let w = weights.get(&key).copied().filter(|w| *w != 0.0).unwrap_or(1.0);
                    match seen.get_mut(&key) {
                        None => {
                            order.push(key.clone());
                            seen.insert(key, (name, w));
                        }
                        Some(rec) => {
                            let cur = if rec.1 != 0.0 { rec.1 } else { 1.0 };
                            rec.1 = if w > cur { w } else { cur };
                        }
                    }
                }
            }
        }
        let mut pool: Vec<Value> = order
            .iter()
            .map(|key| {
                let (name, w) = &seen[key];
                json!({"tag": name, "name": name, "key": key, "weight": num_f(*w)})
            })
            .collect();
        pool.sort_by_key(|p| py_str(get(p, "name")).to_lowercase());
        Ok(pool)
    }

    fn cap_item(&self, src: &Value, caps: Option<&Value>, key: &str) -> Value {
        let mut item = src.clone();
        let Some(caps) = caps.filter(|c| c.is_object()) else { return item };
        let mut cap = get(caps, key);
        if cap.is_null() {
            let tag = get(src, "tag");
            if let Some(t) = tag.as_str() {
                cap = get(caps, t);
            }
        }
        if cap.is_null() {
            return item;
        }
        if let Some(f) = to_float(cap) {
            item["maxWeight"] = num_f(f);
        }
        item
    }

    fn prepare_pool(&self, album_id: &str, body: &Value, weighted: bool) -> Res<Prepared> {
        let pool = self.artist_pool(album_id, weighted)?;
        let board = self.board()?;
        let pick = |key: &str| -> Vec<Value> {
            let b = get(body, key);
            let src = if truthy(b) { b } else { get(&board, key) };
            src.as_array().cloned().unwrap_or_default()
        };
        let excluded: BTreeSet<String> = pick("excluded").iter().map(|x| tag_key(&py_str(x))).collect();
        let caps_src = if truthy(get(body, "weightCaps")) { get(body, "weightCaps").clone() } else { get(&board, "weightCaps").clone() };
        let caps = if caps_src.is_object() { caps_src } else { json!({}) };
        let pinned_keys: Vec<String> = pick("pinned").iter().map(|x| tag_key(&py_str(x))).collect();
        let mut active = Vec::new();
        let mut by_key: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
        for p in &pool {
            let k = tag_key(&py_str(get(p, "tag")));
            by_key.insert(k.clone(), p.clone());
            let item = self.cap_item(p, Some(&caps), &k);
            if !excluded.contains(&k) {
                active.push(item);
            }
        }
        let mut fixed = Vec::new();
        for k in &pinned_keys {
            if let Some(src) = by_key.get(k) {
                fixed.push(self.cap_item(src, Some(&caps), k));
            }
        }
        Ok(Prepared { active, excluded, fixed, board, caps })
    }

    pub fn draw(&self, album_id: &str, body: &Value) -> Res<Value> {
        let Prepared { active, excluded, fixed, board, caps } = self.prepare_pool(album_id, body, true)?;
        let mut controls = get(&board, "controls").as_object().cloned().unwrap_or_default();
        if let Some(o) = get(body, "controls").as_object() {
            for (k, v) in o {
                controls.insert(k.clone(), v.clone());
            }
        }
        let ctl = |key: &str| controls.get(key).cloned().unwrap_or(Value::Null);
        let int_or = |key: &str, fallback: i64| -> i64 {
            let v = ctl(key);
            if truthy(&v) { to_int(&v).unwrap_or(fallback) } else { fallback }
        };
        let float_or = |key: &str, fallback: f64| -> f64 {
            let v = ctl(key);
            if truthy(&v) { to_float(&v).unwrap_or(fallback) } else { fallback }
        };
        let locked_n = fixed.len() as i64;
        let rest_n = (active.len() as i64 - locked_n).max(0);
        let cap = locked_n + rest_n;
        let mut n_min = 1.max(int_or("min", 1)).max(locked_n);
        let mut n_max = n_min.max(int_or("max", n_min)).max(locked_n);
        if cap != 0 {
            n_min = n_min.min(cap);
            n_max = n_max.max(n_min).min(cap);
        }
        if active.is_empty() || n_min < 1 || n_max < 1 {
            return Err(DomainError::bad("画师池为空，无法抽奖"));
        }
        let seed = if has_value(body, "seed") {
            to_int(get(body, "seed")).ok_or_else(|| DomainError::bad("seed 格式错误"))?
        } else {
            now_ms()
        };
        let mut rng = PyRandom::new(seed);
        let count = int_or("draws", 1).max(1).min(50);
        let boost_v = ctl("boost");
        let boost = if boost_v.is_null() { 0.4 } else { to_float(&boost_v).unwrap_or(0.4) };
        let target = float_or("target", 1.0);
        let jitter = float_or("jitter", 0.0);
        let min_weight = float_or("wmin", 0.01);
        let max_weight = float_or("wmax", 1.0);

        let mut ns: Vec<i64> = Vec::new();
        let mut draws: Vec<Value> = Vec::new();
        for _ in 0..count {
            let n = rng.randint(n_min, n_max);
            ns.push(n);
            let dp = DrawParams {
                fixed: fixed.clone(),
                n: Some(n as f64),
                count: Some(1.0),
                jitter,
                boost,
                target: Some(target),
                min_weight: Some(min_weight),
                max_weight: Some(max_weight),
            };
            draws.extend(draw_from_pool(&active, &dp, &mut rng));
        }
        if draws.is_empty() {
            return Err(DomainError::bad("抽奖没有结果"));
        }
        let digest = pool_hash(&active);
        let batch_id = new_id();
        let created = now_ms();
        for d in draws.iter_mut() {
            d["id"] = json!(new_id());
        }
        let params_v = json!({
            "target": num_f(target),
            "boost": num_f(boost),
            "jitter": num_f(jitter),
            "minWeight": num_f(min_weight),
            "maxWeight": num_f(max_weight),
            "fixed": fixed.iter().map(|p| tag_key(&if truthy(get(p, "tag")) { py_str(get(p, "tag")) } else { String::new() })).collect::<Vec<_>>(),
            "n": ns.first().copied().unwrap_or(n_min),
            "count": count,
            "ns": ns,
            "weighted": true,
            "excluded": excluded.iter().collect::<Vec<_>>(),
            "weightCaps": caps,
            "nMin": n_min,
            "nMax": n_max,
        });
        let payload = json!({
            "albumId": album_id,
            "seed": seed,
            "poolRevision": active.len(),
            "poolHash": digest,
            "params": params_v,
            "draws": draws,
            "createdAt": created,
        });
        let mut batch: DrawBatch = self.k.load(&batch_id)?;
        batch.create_batch(payload)?;
        self.k.commit(&mut batch, Some(&format!("lottery.draw:{seed}:{digest}:{created}")))?;
        self.get_batch(&batch_id, false)?.ok_or_else(|| DomainError::internal("抽奖失败"))
    }

    pub fn verify(&self, batch_id: &str) -> Res<Value> {
        let found = self.get_batch(batch_id, true)?.ok_or_else(|| DomainError::not_found("批次不存在"))?;
        let stored = get(&found, "params").clone();
        let weighted = truthy(get(&stored, "weighted"));
        let album_id = py_str(get(&found, "albumId"));
        let pool = self.artist_pool(&album_id, weighted)?;
        let excluded: BTreeSet<String> = get(&stored, "excluded")
            .as_array()
            .map(|a| a.iter().map(py_str).collect())
            .unwrap_or_default();
        let caps = if get(&stored, "weightCaps").is_object() { get(&stored, "weightCaps").clone() } else { json!({}) };
        let mut active = Vec::new();
        let mut by_key: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
        for p in &pool {
            let k = tag_key(&py_str(get(p, "tag")));
            let item = self.cap_item(p, Some(&caps), &k);
            by_key.insert(k.clone(), item.clone());
            if !excluded.contains(&k) {
                active.push(item);
            }
        }
        let expected_hash = pool_hash(&active);
        let stored_hash = py_str(get(&found, "poolHash"));
        let hash_ok = expected_hash == stored_hash;
        let seed = to_int(get(&found, "seed")).unwrap_or(0);
        let mut rng = PyRandom::new(seed);
        let truthy_int = |v: &Value| -> Option<i64> { if truthy(v) { to_int(v) } else { None } };
        let n_min = truthy_int(get(&stored, "nMin")).or_else(|| truthy_int(get(&stored, "n"))).unwrap_or(1);
        let n_max = truthy_int(get(&stored, "nMax")).unwrap_or(n_min);
        let fixed: Vec<Value> = get(&stored, "fixed")
            .as_array()
            .map(|a| a.iter().filter_map(|k| by_key.get(&py_str(k)).cloned()).collect())
            .unwrap_or_default();
        let opt_f = |key: &str| -> Option<f64> {
            let v = get(&stored, key);
            if v.is_null() { None } else { to_float(v) }
        };
        let or0 = |key: &str| -> f64 {
            let v = get(&stored, key);
            if truthy(v) { to_float(v).unwrap_or(0.0) } else { 0.0 }
        };
        let make = |n: i64, count: f64| DrawParams {
            fixed: fixed.clone(),
            n: Some(n as f64),
            count: Some(count),
            jitter: or0("jitter"),
            boost: or0("boost"),
            target: opt_f("target"),
            min_weight: opt_f("minWeight"),
            max_weight: opt_f("maxWeight"),
        };
        let mut replayed: Vec<Value> = Vec::new();
        match get(&stored, "ns").as_array().filter(|a| !a.is_empty()) {
            Some(ns) => {
                for n in ns {
                    // 抽奖时每一条之前都先 randint 选一次串长，重放也要同样消耗一次随机数，否则从第二条起就错位了。
                    // （Python 版漏了这一步，所以它对串长有区间的批次永远校验失败。）
                    rng.randint(n_min, n_max);
                    replayed.extend(draw_from_pool(&active, &make(to_int(n).unwrap_or(1), 1.0), &mut rng));
                }
            }
            None => {
                let n = rng.randint(n_min, n_max);
                let count = if truthy(get(&stored, "count")) { to_float(get(&stored, "count")).unwrap_or(1.0) } else { 1.0 };
                replayed = draw_from_pool(&active, &make(n, count), &mut rng);
            }
        }
        let texts: Vec<Value> = get(&found, "draws")
            .as_array()
            .map(|a| a.iter().map(|d| get(d, "outputText").clone()).collect())
            .unwrap_or_default();
        let replay_texts: Vec<Value> = replayed.iter().map(|d| get(d, "outputText").clone()).collect();
        let draws_match = texts == replay_texts;
        Ok(json!({
            "ok": hash_ok && draws_match,
            "poolHashMatch": hash_ok,
            "expectedPoolHash": expected_hash,
            "storedPoolHash": stored_hash,
            "drawsMatch": draws_match,
        }))
    }

    pub fn remove_draw(&self, batch_id: &str, draw_ref: &str) -> Res<Value> {
        let found = self.get_batch(batch_id, false)?.ok_or_else(|| DomainError::not_found("批次不存在"))?;
        let draws = get(&found, "draws").as_array().cloned().unwrap_or_default();
        let id_of = |d: &Value| -> String {
            let v = get(d, "id");
            if truthy(v) { py_str(v) } else { String::new() }
        };
        let mut index: Option<usize> = None;
        let mut draw_id = String::new();
        for (i, d) in draws.iter().enumerate() {
            if id_of(d) == draw_ref {
                index = Some(i);
                draw_id = id_of(d);
                break;
            }
        }
        let index = match index {
            Some(i) => i,
            None => {
                let parsed: i64 = draw_ref.trim().parse().map_err(|_| DomainError::not_found("条目不存在"))?;
                if parsed < 0 || parsed as usize >= draws.len() {
                    return Err(DomainError::not_found("条目不存在"));
                }
                draw_id = id_of(&draws[parsed as usize]);
                parsed as usize
            }
        };
        let mut batch: DrawBatch = self.k.load(batch_id)?;
        if batch.draws.len() == draws.len() {
            for (agg, proj) in batch.draws.iter_mut().zip(draws.iter()) {
                if !truthy(get(agg, "id")) && truthy(get(proj, "id")) {
                    agg["id"] = get(proj, "id").clone();
                }
            }
        }
        batch.remove_draw(index as i64, if draw_id.is_empty() { None } else { Some(&draw_id) })?;
        self.k.commit(&mut batch, None)?;
        self.get_batch(batch_id, false)?.ok_or_else(|| DomainError::not_found("批次不存在"))
    }

    pub fn delete_batch(&self, batch_id: &str) -> Res<()> {
        let mut batch: DrawBatch = self.k.load(batch_id)?;
        batch.delete()?;
        self.k.commit(&mut batch, None)?;
        Ok(())
    }

    pub fn restore_batch(&self, batch_id: &str) -> Res<Value> {
        let mut batch: DrawBatch = self.k.load(batch_id)?;
        batch.restore()?;
        self.k.commit(&mut batch, None)?;
        self.get_batch(batch_id, true)?.ok_or_else(|| DomainError::not_found("批次不存在"))
    }

    /// 抽奖出图任务完成时，把预览补挂到还没有预览的画师串上；失败就算了。
    fn hydrate_draw_previews(&self, batches: &mut [Value]) {
        let missing = batches.iter().any(|b| {
            get(b, "draws")
                .as_array()
                .map(|ds| ds.iter().any(|d| !get(d, "previews").as_array().map(|a| !a.is_empty()).unwrap_or(false)))
                .unwrap_or(false)
        });
        if !missing {
            return;
        }
        let _ = (|| -> Res<()> {
            let conn = self.k.store.connect()?;
            let mut stmt = conn.prepare(
                "SELECT id, client_json, items_json FROM projections_jobs WHERE source='lottery' AND status='done'",
            )?;
            let jobs: Vec<(String, Option<String>, Option<String>)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .filter_map(|r| r.ok())
                .collect();
            let mut changed: BTreeSet<usize> = BTreeSet::new();
            for (job_id, client_json, items_json) in jobs {
                let client = text_or(client_json, "{}");
                if !client.is_object() {
                    continue;
                }
                let batch_id = if truthy(get(&client, "batchId")) { py_str(get(&client, "batchId")).trim().to_string() } else { String::new() };
                let Some(pos) = batches.iter().position(|b| get(b, "id").as_str() == Some(batch_id.as_str())) else {
                    continue;
                };
                let items = text_or(items_json, "[]");
                let items = if items.is_array() { items } else { json!([]) };
                let mut draws = get(&batches[pos], "draws").as_array().cloned().unwrap_or_default();
                if attach_job_previews(&mut draws, &batch_id, &job_id, &client, &items, true) {
                    batches[pos]["draws"] = Value::Array(draws);
                    changed.insert(pos);
                }
            }
            for pos in changed {
                let id = py_str(get(&batches[pos], "id"));
                conn.execute(
                    "UPDATE projections_lottery_batches SET draws_json=?1 WHERE id=?2",
                    params![dumps(get(&batches[pos], "draws")), id],
                )?;
            }
            Ok(())
        })();
    }

    fn batch_row(&self, row: &Row) -> rusqlite::Result<Value> {
        let id: String = row.get("id")?;
        let mut draws: Vec<Value> = text_or(row.get("draws_json")?, "[]").as_array().cloned().unwrap_or_default();
        if stamp_draw_ids(&mut draws, &id) {
            if let Ok(conn) = self.k.store.connect() {
                let _ = conn.execute(
                    "UPDATE projections_lottery_batches SET draws_json=?1 WHERE id=?2",
                    params![dumps(&Value::Array(draws.clone())), id],
                );
            }
        }
        Ok(json!({
            "id": id,
            "albumId": row.get::<_, String>("album_id")?,
            "seed": row.get::<_, i64>("seed")?,
            "poolRevision": row.get::<_, i64>("pool_revision")?,
            "poolHash": row.get::<_, String>("pool_hash")?,
            "params": text_or(row.get("params_json")?, "{}"),
            "draws": draws,
            "createdAt": row.get::<_, i64>("created_at")?,
            "deleted": row.get::<_, i64>("deleted")? != 0,
            "version": row.get::<_, i64>("version")?,
        }))
    }
}

struct Prepared {
    active: Vec<Value>,
    excluded: BTreeSet<String>,
    fixed: Vec<Value>,
    board: Value,
    caps: Value,
}
