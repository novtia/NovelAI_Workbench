import { stripArtist, tagKey } from "./hashKey";
import type { BasketArtist } from "./types";

/** 把一批画师名规范成 {key, name}：去掉 artist: 前缀、去空、按 tagKey 去重，保持顺序。 */
export function normalizeBasketNames(names: unknown): Array<{ key: string; name: string }> {
  const out: Array<{ key: string; name: string }> = [];
  if (!Array.isArray(names)) return out;
  const seen = new Set<string>();
  for (const raw of names) {
    const name = stripArtist(String(raw ?? ""));
    const key = tagKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name });
  }
  return out;
}

export type BasketFormat = {
  separator?: "comma" | "newline" | "space";
  underscoreToSpace?: boolean;
  escapeParens?: boolean;
};

const SEPARATORS = { comma: ", ", newline: "\n", space: " " } as const;

/** 单个画师复制成 `artist:名字`，按设置处理下划线与括号。 */
export function basketName(name: string, fmt: BasketFormat = {}) {
  let n = stripArtist(name);
  if (fmt.underscoreToSpace) n = n.replace(/_/g, " ");
  if (fmt.escapeParens) n = n.replace(/\\?([()])/g, "\\$1");
  return `artist:${n}`;
}

/** 复制用的画师串：默认 `artist:a, artist:b`，按加入顺序，没有权重。 */
export function basketText(list: Array<Pick<BasketArtist, "name">>, fmt: BasketFormat = {}) {
  return list.map((a) => basketName(a.name, fmt)).join(SEPARATORS[fmt.separator || "comma"]);
}

/** 乐观更新：把 names 里还没有的画师追加到末尾。 */
export function basketAdd(list: BasketArtist[], names: unknown, addedAt = Date.now()): BasketArtist[] {
  const have = new Set(list.map((a) => a.key));
  const fresh = normalizeBasketNames(names)
    .filter((n) => !have.has(n.key))
    .map((n) => ({ ...n, addedAt }));
  return fresh.length ? [...list, ...fresh] : list;
}

/** 乐观更新：按 key 移除。 */
export function basketRemove(list: BasketArtist[], keys: string[]): BasketArtist[] {
  const drop = new Set(keys);
  const next = list.filter((a) => !drop.has(a.key));
  return next.length === list.length ? list : next;
}

/** names 里的画师是否都已在面板里（names 为空算没有）。 */
export function basketHasAll(list: Array<Pick<BasketArtist, "key">>, names: unknown) {
  const wanted = normalizeBasketNames(names);
  if (!wanted.length) return false;
  const have = new Set(list.map((a) => a.key));
  return wanted.every((w) => have.has(w.key));
}
