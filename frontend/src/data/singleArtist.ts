import { tagKey } from "./hashKey";
import type { Album, Artwork } from "./types";

export const SINGLE_ARTIST_ALBUM_ID = "single-artist";
export const SINGLE_ARTIST_ALBUM_NAME = "单画师";
export const SINGLE_ARTIST_IMPORT_ERROR = "「单画师」收藏夹只接受含单个画师串的测试图";
export const ARTIST_RE =
  /(\d+(?:\.\d+)?::)?\s*(?:\[artist:\s*([^\]]+?)\]|artist:\s*([^,\]\n]+?))(?:\s*::|(?=\s*,)|\s*$)/gi;

export type ArtistColumn = { key: string; name: string; items: Artwork[] };
export type ArtistSections = { shared: Artwork[]; extras: ArtistColumn[] };
export type ArtistSpan = { name: string; start: number; end: number };
export type ArtistToken = { type: "text" | "artist"; value: string; name?: string };

export function isSingleArtistAlbum(album?: Pick<Album, "id" | "name" | "kind"> | null) {
  if (!album) return false;
  return album.kind === "singleArtist" || album.id === SINGLE_ARTIST_ALBUM_ID || album.name === SINGLE_ARTIST_ALBUM_NAME;
}

export function uniqueArtistKeys(artists: unknown) {
  const keys: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(artists)) return keys;
  for (const raw of artists) {
    const key = tagKey(String(raw || ""));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function singleArtistImportError(artists: unknown) {
  return uniqueArtistKeys(artists).length === 1 ? null : SINGLE_ARTIST_IMPORT_ERROR;
}

export function splitSingleArtistSections(items: Artwork[]): ArtistSections {
  const byKey = new Map<string, Artwork[]>();
  const names = new Map<string, string>();
  for (const item of items) {
    const name = String((item.artists || [])[0] || "").trim();
    const key = tagKey(name) || "_unknown";
    names.set(key, name || "未识别画师");
    const list = byKey.get(key) || [];
    list.push(item);
    byKey.set(key, list);
  }
  const extraKeys = new Set<string>();
  for (const [key, list] of byKey) {
    if (list.length >= 2) extraKeys.add(key);
  }
  const shared = items.filter((item) => {
    const name = String((item.artists || [])[0] || "").trim();
    const key = tagKey(name) || "_unknown";
    return !extraKeys.has(key);
  });
  const extras: ArtistColumn[] = [...extraKeys].map((key) => ({
    key,
    name: names.get(key) || key,
    items: byKey.get(key) || [],
  }));
  extras.sort((a, b) => (b.items[0]?.addedAt || 0) - (a.items[0]?.addedAt || 0) || a.key.localeCompare(b.key));
  return { shared, extras };
}

export function indexArtistPreviews(items: Artwork[]) {
  const map = new Map<string, Artwork[]>();
  for (const item of items) {
    const name = String((item.artists || [])[0] || "");
    const key = tagKey(name);
    if (!key) continue;
    const list = map.get(key) || [];
    list.push(item);
    map.set(key, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => b.addedAt - a.addedAt || b.id.localeCompare(a.id));
  }
  return map;
}

export function findArtistSpans(text: string): ArtistSpan[] {
  const spans: ArtistSpan[] = [];
  const src = String(text || "");
  const re = new RegExp(ARTIST_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const raw = m[2] || m[3] || "";
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name) continue;
    const full = m[0];
    const prefixRe = m[2] != null ? /\[artist:\s*/i : /artist:\s*/i;
    const prefix = prefixRe.exec(full);
    if (!prefix || prefix.index == null) continue;
    const start = m.index + prefix.index;
    let end = start + prefix[0].length + raw.length;
    if (m[2] != null && full[prefix.index + prefix[0].length + raw.length] === "]") end += 1;
    if (spans.some((s) => start < s.end && end > s.start)) continue;
    spans.push({ name, start, end });
  }
  return spans;
}

export function findArtistAt(text: string, index: number) {
  if (index < 0) return null;
  return findArtistSpans(text).find((s) => index >= s.start && index < s.end) || null;
}

export function splitArtistTokens(text: string): ArtistToken[] {
  const src = String(text || "");
  const spans = findArtistSpans(src);
  if (!spans.length) return src ? [{ type: "text", value: src }] : [];
  const parts: ArtistToken[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) parts.push({ type: "text", value: src.slice(cursor, span.start) });
    parts.push({ type: "artist", value: src.slice(span.start, span.end), name: span.name });
    cursor = span.end;
  }
  if (cursor < src.length) parts.push({ type: "text", value: src.slice(cursor) });
  return parts;
}
