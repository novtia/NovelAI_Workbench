import { call } from "./client";
import type {
  CfVerifyStatus,
  MediaArtistsSearchResult,
  MediaPost,
  MediaSearchResult,
  MediaSite,
  MediaSitePatch,
  MediaTagSuggestion,
} from "@/data/media";
import type { Artwork } from "@/data/types";

export async function listSites(): Promise<MediaSite[]> {
  const r = await call<{ sites: MediaSite[] }>("media_list_sites");
  return r.sites || [];
}

export async function saveSite(
  id: string | undefined,
  patch: MediaSitePatch,
): Promise<{ site: MediaSite; sites: MediaSite[] }> {
  return call<{ site: MediaSite; sites: MediaSite[] }>("media_save_site", {
    id: id || "",
    patch,
  });
}

export async function deleteSite(id: string): Promise<MediaSite[]> {
  const r = await call<{ sites: MediaSite[] }>("media_delete_site", { id });
  return r.sites || [];
}

export async function reorderSites(ids: string[]): Promise<MediaSite[]> {
  const r = await call<{ sites: MediaSite[] }>("media_reorder_sites", { ids });
  return r.sites || [];
}

export async function searchPosts(params: {
  siteId: string;
  query?: string;
  promptQuery?: string;
  page?: number;
  limit?: number;
  sort?: string;
  rating?: string;
  aiType?: string;
  showR18?: boolean;
}): Promise<MediaSearchResult> {
  return call<MediaSearchResult>("media_search_posts", {
    siteId: params.siteId,
    query: params.query || "",
    promptQuery: params.promptQuery || "",
    page: params.page ?? 1,
    limit: params.limit ?? 40,
    sort: params.sort || "new",
    rating: params.rating || "all",
    aiType: params.aiType || "all",
    showR18: Boolean(params.showR18),
  });
}

export async function searchArtists(params: {
  siteId?: string;
  name?: string;
  url?: string;
  order?: string;
  hasTag?: string;
  isDeleted?: string;
  page?: number;
  limit?: number;
}): Promise<MediaArtistsSearchResult> {
  return call<MediaArtistsSearchResult>("media_search_artists", {
    siteId: params.siteId || "danbooru",
    name: params.name || "",
    url: params.url || "",
    order: params.order || "created_at",
    hasTag: params.hasTag || "",
    isDeleted: params.isDeleted || "",
    page: params.page ?? 1,
    limit: params.limit ?? 24,
  });
}

export async function getArtistPreview(
  artistName: string,
  siteId = "danbooru",
): Promise<{ artistName: string; post: MediaPost | null }> {
  return call<{ artistName: string; post: MediaPost | null }>("media_get_artist_preview", {
    siteId,
    artistName,
  });
}

export async function suggestTags(params: {
  siteId: string;
  query: string;
  category?: "all" | "artist";
}): Promise<MediaTagSuggestion[]> {
  const r = await call<{ suggestions: MediaTagSuggestion[] }>("media_suggest_tags", {
    siteId: params.siteId,
    query: params.query,
    category: params.category || "all",
  });
  return r.suggestions || [];
}

export async function getPost(siteId: string, postId: string): Promise<MediaPost> {
  const r = await call<{ post: MediaPost }>("media_get_post", { siteId, postId });
  return r.post;
}

export async function openCfVerify(
  siteId: string,
): Promise<{ opened: boolean; siteId: string; site: MediaSite }> {
  return call<{ opened: boolean; siteId: string; site: MediaSite }>("media_open_cf_verify", {
    siteId,
  });
}

export async function checkCfStatus(siteId: string): Promise<CfVerifyStatus> {
  return call<CfVerifyStatus>("media_check_cf_status", { siteId });
}

export async function importToAlbum(params: {
  albumId: string;
  siteId: string;
  imageUrl: string;
  meta?: Record<string, unknown>;
}): Promise<Artwork> {
  const r = await call<{ item: Artwork }>("media_import_to_album", {
    albumId: params.albumId,
    siteId: params.siteId,
    imageUrl: params.imageUrl,
    meta: params.meta || {},
  });
  return r.item;
}

export async function openExternalUrl(url: string): Promise<void> {
  await call("open_external_url", { url });
}
