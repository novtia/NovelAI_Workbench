import { formatArtistCard } from "./artistCards";

/**
 * 提示词标签公式。
 *   <画师>        画师库按 a-z 顺序取，每点一次生图前进一位
 *   <画师:随机>   每次随机取一个
 *   <画师:3>      每次取连续 3 个，每次前进 3 位
 *   <a|b|c>       行内自定义列表，后缀规则相同
 */

export type TagFormula = {
  raw: string;
  /** 池名或行内列表原文，也是计数器 key 的来源。 */
  body: string;
  key: string;
  kind: "pool" | "list";
  mode: "seq" | "rand";
  step: number;
  /** 行内列表的项。 */
  list: string[];
};

const POOL_NAMES = new Set(["画师", "artist", "artists"]);
const RAND_WORDS = new Set(["随机", "rand", "random"]);
const MAX_STEP = 50;

function parseOne(raw: string, inner: string): TagFormula | null {
  let body = inner.trim();
  let mode: "seq" | "rand" = "seq";
  let step = 1;
  const at = Math.max(body.lastIndexOf(":"), body.lastIndexOf("："));
  if (at > 0) {
    const mod = body.slice(at + 1).trim().toLowerCase();
    if (RAND_WORDS.has(mod)) {
      mode = "rand";
      body = body.slice(0, at).trim();
    } else if (/^\d+$/.test(mod)) {
      step = Math.min(Math.max(parseInt(mod, 10), 1), MAX_STEP);
      body = body.slice(0, at).trim();
    }
  }
  if (!body) return null;
  if (body.includes("|")) {
    const list = body.split("|").map((s) => s.trim()).filter(Boolean);
    if (!list.length) return null;
    return { raw, body, key: `list:${list.join("|")}`, kind: "list", mode, step, list };
  }
  if (POOL_NAMES.has(body.toLowerCase())) return { raw, body, key: "pool:artist", kind: "pool", mode, step, list: [] };
  return null;
}

/** 解析文本里的所有公式（按出现顺序，未识别的尖括号原样忽略）。 */
export function findFormulas(text: string): TagFormula[] {
  const out: TagFormula[] = [];
  const re = /<([^<>\n]+)>/g;
  let m: RegExpExecArray | null;
  const src = String(text || "");
  while ((m = re.exec(src)) !== null) {
    const f = parseOne(m[0], m[1]);
    if (f) out.push(f);
  }
  return out;
}

/** 去重后的公式（同一个 raw 只留一份），卡片用。 */
export function uniqueFormulas(list: TagFormula[]): TagFormula[] {
  const seen = new Set<string>();
  return list.filter((f) => (seen.has(f.raw) ? false : (seen.add(f.raw), true)));
}

/** 画师库名字按 a-z 排序。 */
export function sortedPool(names: string[]) {
  return [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

export function formulaItems(f: TagFormula, library: string[]): string[] {
  return f.kind === "list" ? f.list : sortedPool(library);
}

function render(f: TagFormula, item: string) {
  return f.kind === "pool" ? formatArtistCard(item, null) : item;
}

function cycleIndex(raw: number, total: number) {
  return ((raw % total) + total) % total;
}

function pick(items: string[], index: number, step: number, noWrap: boolean) {
  const n = items.length;
  const start = cycleIndex(index, n);
  const count = Math.min(step, noWrap ? n - start : n);
  return Array.from({ length: count }, (_, i) => items[(start + i) % n]);
}

/** 从当前位置到序列末尾还要生几次（含本次）。随机或空池为 0。 */
export function stepsUntilEnd(f: TagFormula, library: string[], counters: Record<string, number>): number {
  if (f.mode !== "seq") return 0;
  const total = formulaItems(f, library).length;
  if (!total) return 0;
  return Math.ceil((total - cycleIndex(counters[f.key] || 0, total)) / f.step);
}

export type ExpandResult = {
  text: string;
  /** 需要推进的计数器：key -> 前进位数。 */
  advance: Record<string, number>;
  /** 池为空、没能展开的公式原文。 */
  missing: string[];
};

export function expandFormulas(
  text: string,
  library: string[],
  counters: Record<string, number>,
  rand: () => number = Math.random,
  noWrap = false,
): ExpandResult {
  const advance: Record<string, number> = {};
  const missing: string[] = [];
  const out = String(text || "").replace(/<([^<>\n]+)>/g, (raw, inner: string) => {
    const f = parseOne(raw, inner);
    if (!f) return raw;
    const items = formulaItems(f, library);
    if (!items.length) {
      missing.push(raw);
      return raw;
    }
    if (f.mode === "rand") return render(f, items[Math.floor(rand() * items.length) % items.length]);
    const taken = pick(items, counters[f.key] || 0, f.step, noWrap);
    advance[f.key] = Math.max(advance[f.key] || 0, noWrap ? taken.length : f.step);
    return taken.map((it) => render(f, it)).join(", ");
  });
  return { text: out, advance, missing };
}

export type FormulaPreview = {
  total: number;
  /** 当前位置，从 0 开始。 */
  index: number;
  current: string[];
  next: string[];
};

export function previewFormula(f: TagFormula, library: string[], counters: Record<string, number>): FormulaPreview {
  const items = formulaItems(f, library);
  const total = items.length;
  if (!total) return { total: 0, index: 0, current: [], next: [] };
  const index = cycleIndex(counters[f.key] || 0, total);
  return { total, index, current: pick(items, index, f.step, false), next: pick(items, index + f.step, f.step, false) };
}
