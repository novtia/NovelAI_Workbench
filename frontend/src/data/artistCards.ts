import { stripArtist, tagKey } from "./hashKey";

export const WEIGHT_STEP = 0.1;

/** 一张画师卡片在原文里对应的片段。逗号、多余空格都不属于卡片。 */
export type ArtistCard = {
  start: number;
  end: number;
  raw: string;
  /** 第一个画师名（兼容单画师场景）。 */
  name: string;
  /** 卡片里的全部画师名；`1.1::artist:a, b::` 这种共用权重的写法会有多个。 */
  names: string[];
  /** 不含权重和闭合 `::` 的内容，如 `artist:a, b`；改权重时原样保留。 */
  inner: string;
  weight: number | null;
  bracket: boolean;
  /** 卡片被屏蔽：还留在编辑器里，但发给模型之前会整段拿掉。 */
  muted: boolean;
};

export type PromptSegment = { type: "text"; value: string } | { type: "card"; card: ArtistCard };

/** 屏蔽前缀，紧贴在三种卡片原文前面。正则里的 `#!` 要和这里保持一致。 */
export const MUTE_PREFIX = "#!";

/**
 * 只认三种写法，每种都可以用 `#!` 前缀标成屏蔽：
 *   1) 0.92::artist:name ::   （带权重，必须闭合 ::；里面可以是用逗号隔开的多个画师共用权重）
 *   2) [artist:name]
 *   3) artist:name            （后面是逗号或结尾）
 */
// 加权组的内容：不能跨越 `::`，也不能吞掉下一个「数字::」权重起点。
const GROUP_INNER = String.raw`(?:(?!::)(?!(?<![A-Za-z0-9_.])-?\d+(?:\.\d+)?::)[^\]\n])+?`;
const CARD_SOURCE =
  String.raw`(?<![A-Za-z0-9_.])(?<wmute>${MUTE_PREFIX})?(?<weight>-?\d+(?:\.\d+)?)::[ \t]*(?<wbody>artist:[ \t]*${GROUP_INNER})[ \t]*::` +
  String.raw`|(?<bmute>${MUTE_PREFIX})?\[[ \t]*artist:[ \t]*(?<bbody>[^\]\n]+?)[ \t]*\]` +
  String.raw`|(?<![A-Za-z0-9_])(?<pmute>${MUTE_PREFIX})?artist:[ \t]*(?<pbody>[^,\]\n:]+?)(?=[ \t]*(?:,|$))`;

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
    const g = m.groups ?? {};
    const weighted = g.weight != null;
    const bracket = g.bbody != null;
    const body = (g.wbody ?? g.bbody ?? g.pbody ?? "").trim();
    const names = (weighted ? body.split(/[,，]/) : [body]).map(stripArtist).filter(Boolean);
    if (!names.length) continue;
    cards.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      name: names[0],
      names,
      inner: weighted ? body : `artist:${names[0]}`,
      weight: weighted ? Number(g.weight) : null,
      bracket,
      muted: Boolean(g.wmute || g.bmute || g.pmute),
    });
  }
  return cards;
}

/**
 * 卡片原文规范化：闭合 `::` 紧贴数字（`0.8::artist:bm1991::`）时，模型会把 `1991::` 当成权重，
 * 所以数字和闭合 `::` 之间必须补一个空格。
 */
export function fixCardRaw(raw: string) {
  return raw.replace(/(\d)::$/, "$1 ::");
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

/** 给卡片原文加上或去掉屏蔽前缀。已经带前缀时再屏蔽一次不会叠两层。 */
export function applyMute(raw: string, muted: boolean) {
  const body = raw.startsWith(MUTE_PREFIX) ? raw.slice(MUTE_PREFIX.length) : raw;
  return muted ? `${MUTE_PREFIX}${body}` : body;
}

/**
 * 拿掉屏蔽卡片，并收掉因此多出来的逗号。
 * 没有屏蔽卡片时原样返回，空格和逗号都不动。
 */
export function stripMutedArtists(text: string) {
  const src = String(text ?? "");
  const parts = splitPromptSegments(src);
  if (!parts.some((p) => p.type === "card" && p.card.muted)) return src;

  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === "card" && part.card.muted) {
      const next = parts[i + 1];
      if (next?.type === "text" && /^[ \t]*[,，]/.test(next.value)) {
        parts[i + 1] = { type: "text", value: next.value.replace(/^[ \t]*[,，][ \t]*/, "") };
        if (out.every((s) => /^[ \t]*$/.test(s))) out.length = 0;
        continue;
      }
      const prev = out[out.length - 1];
      if (prev != null && /[ \t]*[,，][ \t]*$/.test(prev)) out[out.length - 1] = prev.replace(/[ \t]*[,，][ \t]*$/, "");
      continue;
    }
    out.push(part.type === "text" ? part.value : part.card.raw);
  }
  return out.join("");
}

/** 多画师共用权重的卡片写回原文：保留原内容，只换权重；无权重时直接是原内容。 */
export function formatArtistGroup(inner: string, weight: number | null) {
  const s = String(inner ?? "").trim();
  if (weight == null || !Number.isFinite(weight)) return s;
  return `${formatWeight(weight)}::${s}${/\d$/.test(s) ? " " : ""}::`;
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
