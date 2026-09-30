import type { Artwork } from "./types";
import type { CharCaption, ImageMeta } from "./png";

export type { CharCaption, ImageMeta };

export function asMeta(params: Record<string, unknown> | undefined): Partial<ImageMeta> {
  return (params || {}) as Partial<ImageMeta>;
}

export function artistText(item: Artwork) {
  const p = asMeta(item.params);
  return p.artistChain || item.artistLine || (item.artists || []).map((n) => `artist:${n}`).join(", ");
}

export function promptText(item: Artwork) {
  const p = asMeta(item.params);
  return String(p.prompt || p.v4Prompt?.caption?.base_caption || "");
}

export function negativeText(item: Artwork) {
  const p = asMeta(item.params);
  return String(p.uc || p.v4Negative?.caption?.base_caption || "");
}

export function sourceLabel(source: unknown) {
  if (source === "nai-v5") return "V5 生图";
  if (source === "stealth") return "stealth LSB";
  if (source === "png-text") return "PNG 元数据";
  return "未找到";
}

export function charCaptions(item: Artwork): CharCaption[] {
  const p = asMeta(item.params);
  const caps = p.v4Prompt?.caption?.char_captions;
  if (Array.isArray(caps) && caps.length) return caps;
  // 没有 v4Prompt 的图（比如早期的测试图）：退回到参数里记的角色列表。
  const raw = (item.params || {}).characters;
  if (!Array.isArray(raw)) return [];
  const out: CharCaption[] = [];
  for (const c of raw as Array<{ prompt?: unknown; center?: { x?: number; y?: number }; x?: number; y?: number }>) {
    const text = String(c?.prompt || "").trim();
    if (!text) continue;
    const x = c.center?.x ?? c.x;
    const y = c.center?.y ?? c.y;
    out.push({
      char_caption: text,
      centers: x != null && y != null ? [{ x: Number(x), y: Number(y) }] : undefined,
    });
  }
  return out;
}

export async function copyText(text: string) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
