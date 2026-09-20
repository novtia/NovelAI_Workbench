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
  const caps = asMeta(item.params).v4Prompt?.caption?.char_captions;
  return Array.isArray(caps) ? caps : [];
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
