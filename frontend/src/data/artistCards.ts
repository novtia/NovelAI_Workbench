import { stripArtist, tagKey } from "./hashKey";

export const WEIGHT_STEP = 0.1;

/** 一张画师卡片在原文里对应的片段。逗号、多余空格都不属于卡片。 */
export type ArtistCard = {
  start: number;
  end: number;
  raw: string;
  name: string;
  weight: number | null;
  bracket: boolean;
};

export type PromptSegment = { type: "text"; value: string } | { type: "card"; card: ArtistCard };

/**
 * 只认三种写法：
 *   1) 0.92::artist:name ::   （带权重，必须闭合 ::）
 *   2) [artist:name]
 *   3) artist:name            （后面是逗号或结尾）
 */
const CARD_SOURCE =
  String.raw`(?<![A-Za-z0-9_.])(-?\d+(?:\.\d+)?)::[ \t]*artist:[ \t]*([^,\]\n]+?)[ \t]*::` +
  String.raw`|\[[ \t]*artist:[ \t]*([^\]\n]+?)[ \t]*\]` +
  String.raw`|(?<![A-Za-z0-9_])artist:[ \t]*([^,\]\n:]+?)(?=[ \t]*(?:,|$))`;

const CARD_RE = new RegExp(CARD_SOURCE, "gim");

export function findArtistCards(text: string): ArtistCard[] {
  const src = String(text ?? "");
  const re = CARD_RE;
  re.lastIndex = 0;
  const cards: ArtistCard[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (!m[0]) {
      re.lastIndex += 1;
      continue;
    }
    const weighted = m[1] != null;
    const bracket = m[3] != null;
    const name = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (!name) continue;
    cards.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      name,
      weight: weighted ? Number(m[1]) : null,
      bracket,
    });
  }
  return cards;
}

/** 把整段文字拆成「文字 / 卡片」交替的片段。片段拼回去必须与原文完全相等。 */
export function splitPromptSegments(text: string): PromptSegment[] {
  const src = String(text ?? "");
  const out: PromptSegment[] = [];
  let cursor = 0;
  for (const card of findArtistCards(src)) {
    if (card.start > cursor) out.push({ type: "text", value: src.slice(cursor, card.start) });
    out.push({ type: "card", card });
    cursor = card.end;
  }
  if (cursor < src.length) out.push({ type: "text", value: src.slice(cursor) });
  return out;
}

export function joinPromptSegments(parts: PromptSegment[]) {
  return parts.map((p) => (p.type === "text" ? p.value : p.card.raw)).join("");
}

/** 权重显示：至少两位小数，最多三位（0.9 -> 0.90，0.925 -> 0.925）。 */
export function formatWeight(n: number) {
  const rounded = Math.round(n * 1000) / 1000;
  let s = rounded.toFixed(3);
  if (s.endsWith("0")) s = s.slice(0, -1);
  return s;
}

/** 写回原文的卡片文本。名字以数字结尾时，`::` 前留一个空格。 */
export function formatArtistCard(name: string, weight: number | null) {
  const n = stripArtist(name);
  if (weight == null || !Number.isFinite(weight)) return `artist:${n}`;
  return `${formatWeight(weight)}::artist:${n}${/\d$/.test(n) ? " " : ""}::`;
}

/** 加减权重。没有权重时从 1 起算；下限 0。 */
export function stepWeight(weight: number | null, dir: 1 | -1, step = WEIGHT_STEP) {
  const base = weight == null || !Number.isFinite(weight) ? 1 : weight;
  const next = Math.round((base + dir * step) * 1000) / 1000;
  return Math.max(0, next);
}

/** 手输权重：空串表示清除（null），不是数字返回 false。 */
export function parseWeightInput(raw: string): number | null | false {
  const s = String(raw ?? "").trim().replace(/[，,]/g, ".");
  if (!s) return null;
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return false;
  const n = Number(s);
  return Number.isFinite(n) ? n : false;
}

export type SuggestQuery = { query: string; weight: number | null };

/**
 * 光标前面当前这一段文字（已经截掉逗号 / 换行 / 卡片之前的部分）里，
 * 去掉可选的「权重::」和「artist:」之后剩下的就是联想关键字。
 */
export function suggestQueryFromSegment(segment: string): SuggestQuery | null {
  let s = String(segment ?? "").replace(/^[ \t]+/, "");
  let weight: number | null = null;
  const w = /^(\d+(?:\.\d+)?)::[ \t]*/.exec(s);
  if (w) {
    weight = Number(w[1]);
    s = s.slice(w[0].length);
  }
  s = s.replace(/^\[[ \t]*/, "").replace(/^artist:[ \t]*/i, "");
  if (!s.replace(/\s+/g, "") || /[\]:]/.test(s)) return null;
  return { query: s, weight };
}

type IndexedName = { name: string; key: string };
let indexedFrom: string[] | null = null;
let indexedNames: IndexedName[] = [];

function artistIndex(names: string[]) {
  if (names === indexedFrom) return indexedNames;
  indexedFrom = names;
  indexedNames = names
    .map((raw) => {
      const name = stripArtist(raw);
      return { name, key: tagKey(name) };
    })
    .filter((item) => item.key)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return indexedNames;
}

/** 画师库里名字以关键字开头的画师（忽略大小写，下划线与空格等价），已在输入框里的不再出现。最多 20 条。 */
export function filterArtistNames(names: string[], query: string, exclude?: Set<string>, limit = 20) {
  const q = tagKey(query);
  if (!q) return [];
  const index = artistIndex(names);
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid].key < q) lo = mid + 1;
    else hi = mid;
  }
  const hits: string[] = [];
  for (let i = lo; i < index.length && index[i].key.startsWith(q) && hits.length < limit; i++) {
    if (exclude?.has(index[i].key)) continue;
    hits.push(index[i].name);
  }
  return hits;
}

/** 画师库里去重后的画师名，保留第一次出现时的写法。 */
export function artistLibraryNames(items: Array<{ artists?: string[] }>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const name = stripArtist(String((item.artists || [])[0] || ""));
    const key = tagKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * 选中联想后的文本变更：把光标前 segLen 个字符换成卡片，右侧补英文逗号。
 * 返回新全文和新光标位置。
 */
export function applySuggestionText(
  text: string,
  caret: number,
  segLen: number,
  name: string,
  weight: number | null,
) {
  const raw = formatArtistCard(name, weight);
  const rest = text.slice(caret);
  let suffix = ", ";
  if (/^[ \t]*,/.test(rest)) suffix = "";
  else if (/^[ \t\n]/.test(rest)) suffix = ",";
  const head = text.slice(0, Math.max(0, caret - segLen));
  return {
    text: `${head}${raw}${suffix}${rest}`,
    caret: head.length + raw.length + suffix.length,
  };
}
