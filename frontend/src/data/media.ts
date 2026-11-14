import { ASSET_BASE } from "@/api/assets";
import { tagKey } from "./hashKey";
import { findArtistSpans } from "./singleArtist";
import type { Artwork } from "./types";

export type MediaSiteKind = "danbooru" | "aitag" | "webpage";

export type MediaSite = {
  id: string;
  name: string;
  kind: MediaSiteKind;
  baseUrl: string;
  builtin: boolean;
  defaultQuery: string;
  note: string;
  hasCookie: boolean;
  hasClearance: boolean;
  hasUserAgent: boolean;
};

export type MediaSitePatch = {
  name?: string;
  kind?: MediaSiteKind;
  baseUrl?: string;
  defaultQuery?: string;
  note?: string;
  cookie?: string;
  userAgent?: string;
};

export type MediaTagItem = {
  name: string;
  translated: string;
};

export type MediaPostPage = {
  index: number;
  previewUrl: string;
  fileUrl: string;
  model: string;
  prompt: string;
  negativePrompt: string;
  rawJson: string;
  params?: Record<string, unknown>;
};

export type MediaPost = {
  id: string;
  siteId: string;
  siteKind: MediaSiteKind;
  title: string;
  caption?: string;
  previewUrl: string;
  sampleUrl: string;
  fileUrl: string;
  sourceUrl: string;
  width: number;
  height: number;
  artists: string[];
  tagsGeneral: string[];
  tagsCharacter: string[];
  tagsCopyright: string[];
  tagsMeta: string[];
  tagTranslations?: MediaTagItem[];
  prompt: string;
  negativePrompt: string;
  aiType: string;
  model: string;
  authorName: string;
  authorId: string;
  createdAt: string;
  score: number;
  favCount: number;
  rating: string;
  imageCount: number;
  pages: MediaPostPage[];
  rawParams: Record<string, unknown>;
};

export type MediaSearchResult = {
  site: MediaSite;
  page: number;
  hasMore: boolean;
  total: number | null;
  posts: MediaPost[];
};

export type MediaArtist = {
  id: string;
  name: string;
  otherNames: string[];
  groupName: string;
  postCount: number;
  isDeleted: boolean;
  updatedAt: string;
  urls: string[];
  previewPost?: MediaPost | null;
};

export type MediaArtistsSearchResult = {
  site: MediaSite;
  page: number;
  hasMore: boolean;
  artists: MediaArtist[];
};

export type MediaTagCategory = "artist" | "character" | "copyright" | "general" | "meta";

export type MediaTagSuggestion = {
  name: string;
  label: string;
  category: MediaTagCategory;
  postCount: number;
};

export type CfVerifyStatus = {
  siteId: string;
  verified: boolean;
  windowOpen: boolean;
  hasClearance: boolean;
  site?: MediaSite;
};

export type MediaArtistCandidate = {
  key: string;
  name: string;
  tagString: string;
  posts: MediaPost[];
  inSingleAlbum: boolean;
  inBasket: boolean;
};

export const CF_CHALLENGE_PREFIX = "CF_CHALLENGE:";

export function isCfChallengeError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(CF_CHALLENGE_PREFIX) || msg.includes("Cloudflare 安全验证");
}

export function cleanMediaErrorMessage(err: unknown): string {
  if (!err) return "请求失败";
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(CF_CHALLENGE_PREFIX, "").trim() || "请求失败";
}

export function extractSiteHost(baseUrl: string): string {
  try {
    const normalized = /^https?:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : `https://${baseUrl.trim()}`;
    return new URL(normalized).host;
  } catch {
    return baseUrl.trim().replace(/^https?:\/\//i, "").split("/")[0] || baseUrl;
  }
}

export function normalizeWebUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function splitBuiltinAndCustomSites(sites: MediaSite[]): {
  builtins: MediaSite[];
  customs: MediaSite[];
} {
  const builtins: MediaSite[] = [];
  const customs: MediaSite[] = [];
  for (const s of sites) {
    if (s.builtin || s.kind === "danbooru" || s.kind === "aitag") {
      builtins.push(s);
    } else {
      customs.push(s);
    }
  }
  return { builtins, customs };
}

export function filterMediaSites(sites: MediaSite[], keyword: string): MediaSite[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return sites;
  return sites.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.baseUrl.toLowerCase().includes(q) ||
      (s.note || "").toLowerCase().includes(q),
  );
}

/**
 * 构建走 Tauri `wb` 协议代理的远程媒体图片地址（自动携带站点 Referer、Cookie 与系统代理）。
 */
export function mediaProxyImageUrl(siteId: string, remoteUrl: string): string {
  const clean = (remoteUrl || "").trim();
  if (!clean) return "";
  return `${ASSET_BASE}/media/proxy?site=${encodeURIComponent(siteId || "aitag")}&url=${encodeURIComponent(clean)}`;
}

/**
 * 格式化相对时间（如 Danbooru 画师列表的 Updated 列）。
 */
export function formatRelativeTime(iso: string): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso.replace("T", " ").slice(0, 16);
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "刚刚";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `约 ${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  return `${Math.floor(month / 12)} 年前`;
}

/**
 * 从单个帖子（结合可选详情）提取画师名列表（按 tagKey 去重）。
 */
export function resolvePostArtists(post: MediaPost, detail?: MediaPost | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const clean = raw.replace(/^artist:/i, "").replace(/_/g, " ").trim();
    const key = tagKey(clean);
    if (!clean || !key || seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  for (const a of detail?.artists || []) push(a);
  for (const a of post.artists || []) push(a);

  const promptText = detail?.prompt || post.prompt || "";
  if (promptText) {
    for (const span of findArtistSpans(promptText)) {
      push(span.name);
    }
  }
  return out;
}

export function collectMediaArtistCandidates(
  posts: MediaPost[],
  options?: {
    detailsById?: Record<string, MediaPost | undefined>;
    singleArtistItems?: Artwork[];
    basketKeys?: Set<string>;
  },
): MediaArtistCandidate[] {
  const singleKeys = new Set<string>();
  for (const item of options?.singleArtistItems || []) {
    for (const a of item.artists || []) {
      const k = tagKey(a);
      if (k) singleKeys.add(k);
    }
  }
  const basketKeys = options?.basketKeys || new Set<string>();
  const map = new Map<string, { name: string; posts: MediaPost[] }>();

  for (const post of posts) {
    const detail = options?.detailsById?.[post.id];
    const mergedPost = detail
      ? { ...post, ...detail, artists: resolvePostArtists(post, detail) }
      : { ...post, artists: resolvePostArtists(post) };
    for (const artistName of mergedPost.artists) {
      const key = tagKey(artistName);
      if (!key) continue;
      const existing = map.get(key);
      if (existing) {
        if (!existing.posts.some((p) => p.id === mergedPost.id)) {
          existing.posts.push(mergedPost);
        }
      } else {
        map.set(key, { name: artistName, posts: [mergedPost] });
      }
    }
  }

  const result: MediaArtistCandidate[] = [];
  for (const [key, entry] of map.entries()) {
    result.push({
      key,
      name: entry.name,
      tagString: `artist:${entry.name}`,
      posts: entry.posts,
      inSingleAlbum: singleKeys.has(key),
      inBasket: basketKeys.has(key),
    });
  }
  return result;
}

export function buildArtistGrabMeta(post: MediaPost, artistName: string): Record<string, unknown> {
  const cleanArtist = artistName.replace(/^artist:/i, "").replace(/_/g, " ").trim();
  const artistTag = `artist:${cleanArtist}`;
  const rawPrompt = (post.prompt || "").trim();
  const promptWithArtist = rawPrompt
    ? rawPrompt.toLowerCase().includes(cleanArtist.toLowerCase())
      ? rawPrompt
      : `${artistTag}, ${rawPrompt}`
    : artistTag;

  return {
    name: `${cleanArtist}-${post.siteKind}-${post.id}`,
    artists: [cleanArtist],
    artistLine: artistTag,
    width: post.width || undefined,
    height: post.height || undefined,
    params: {
      prompt: promptWithArtist,
      uc: post.negativePrompt || "",
      source: post.sourceUrl || "",
      model: post.model || post.aiType || "",
      postId: post.id,
      siteId: post.siteId,
    },
  };
}
