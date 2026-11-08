/**
 * 画师串插入位置标签（所有用到画师串的界面通用）：
 *   <插入位置:抽奖,图库>   在「抽奖」和「图库测试集」里，画师串替换到这里
 *   <插入位置:抽奖>        只在抽奖里生效
 *   <插入位置>             所有界面都生效
 * 冒号和逗号必须是英文字符。没有生效的标签会被去掉；没写标签时画师串加在最前。
 */
export type InsertScope = "抽奖" | "图库";

const INSERT_TAG = /<插入位置(?::([^<>]*))?>/g;

function scopesOf(raw: string | undefined): string[] | null {
  if (raw == null) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

function applies(raw: string | undefined, scope: InsertScope) {
  const list = scopesOf(raw);
  return !list || list.includes(scope);
}

/** 文本里有没有对这个界面生效的插入标签。 */
export function hasInsertTag(text: string, scope: InsertScope) {
  for (const m of String(text || "").matchAll(INSERT_TAG)) if (applies(m[1], scope)) return true;
  return false;
}

function tidy(text: string) {
  return text
    .replace(/\s*,(\s*,)+/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .replace(/\s{2,}/g, " ");
}

/** 去掉所有插入标签（给不带画师串的场景，比如生图室直接生图）。 */
export function stripInsertTags(text: string) {
  const src = String(text || "");
  return src.includes("<插入位置") ? tidy(src.replace(INSERT_TAG, "")) : src;
}

/**
 * 把画师串放进 prompt：有生效的标签就替换到标签处，其余标签去掉；没有标签则加在最前。
 */
export function placeChain(chain: string, prompt: string, scope: InsertScope) {
  const a = String(chain || "").trim();
  const b = String(prompt || "").trim();
  if (hasInsertTag(b, scope)) {
    const out = b.replace(INSERT_TAG, (_, raw: string | undefined) => (applies(raw, scope) ? a : ""));
    return tidy(out);
  }
  const rest = stripInsertTags(b);
  if (a && rest) return `${a}, ${rest}`;
  return a || rest;
}
