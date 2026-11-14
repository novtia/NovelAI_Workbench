import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { galleryApi, generationApi, lotteryApi, mediaApi } from "@/api";
import { queryKeys } from "@/data/queryKeys";
import { isTestSetAlbum } from "@/data/singleArtist";
import type { Album } from "@/data/types";
import { useMediaStore } from "./mediaStore";
import { useSession } from "./session";
import { useSettings } from "./settingsStore";
const regularAlbums = (albums: Album[]) => albums.filter((a) => !isTestSetAlbum(a));
const testSetAlbums = (albums: Album[]) => albums.filter((a) => isTestSetAlbum(a));

/** 收藏夹列表（不含测试集）。 */
export function useAlbumsQuery() {
  return useQuery({ queryKey: queryKeys.albums, queryFn: galleryApi.listAlbums, select: regularAlbums });
}

/** 单画师测试集列表，只在图库顶部下拉里出现。 */
export function useTestSetsQuery() {
  return useQuery({ queryKey: queryKeys.albums, queryFn: galleryApi.listAlbums, select: testSetAlbums });
}

/** keepPrevious：换了 id 后新数据到手前继续给上一份（测试集切换时网格原地换图，不闪回默认图）。 */
export function useItemsQuery(albumId?: string, keepPrevious = false) {
  const current = useSession((s) => s.albumId);
  const id = albumId ?? current;
  return useQuery({
    queryKey: queryKeys.items(id),
    queryFn: () => galleryApi.listItems(id),
    enabled: Boolean(id),
    placeholderData: keepPrevious ? (prev) => prev : undefined,
  });
}

export function useJobsQuery() {
  return useQuery({ queryKey: queryKeys.jobs, queryFn: generationApi.listJobs, staleTime: Infinity });
}

/** 历史页专用：生图室全部完成记录，滚到底再取下一页。 */
export function useHistoryQuery() {
  return useInfiniteQuery({
    queryKey: queryKeys.history,
    queryFn: ({ pageParam }) => generationApi.listHistory(pageParam),
    initialPageParam: undefined as { before: number; beforeId?: string | null } | undefined,
    getNextPageParam: (last) =>
      last.nextBefore != null ? { before: last.nextBefore, beforeId: last.nextBeforeId } : undefined,
  });
}

export function useNaiStatusQuery() {
  // 账号/额度是全局信息：应用一加载就自动获取，并按设置的间隔在所有页面后台刷新（不再依赖当前页面或点击电池）。
  const refreshSec = useSettings((s) => s.account.quotaRefreshSec);
  return useQuery({
    queryKey: queryKeys.naiStatus,
    queryFn: generationApi.tokenStatus,
    refetchInterval: refreshSec * 1000,
  });
}

/** 账号设置页：全部账号 + 各自额度，按额度刷新间隔自动更新。 */
export function useNaiAccountsQuery() {
  const refreshSec = useSettings((s) => s.account.quotaRefreshSec);
  return useQuery({
    queryKey: queryKeys.naiAccounts,
    queryFn: generationApi.listAccounts,
    refetchInterval: refreshSec * 1000,
  });
}

/** 画布工具栏的 Anlas 估算；参数变了才重新请求，估算本身几乎不变。 */
export function useEstimateQuery(body: Record<string, unknown>) {
  return useQuery({
    queryKey: ["nai-estimate", body] as const,
    queryFn: () => generationApi.estimateCost(body),
    staleTime: 5 * 60 * 1000,
    placeholderData: (prev) => prev,
  });
}

export function useParamSetsQuery() {
  return useQuery({ queryKey: queryKeys.paramSets, queryFn: generationApi.listParamSets });
}

export function useLotteryBatchesQuery() {
  return useQuery({ queryKey: queryKeys.lotteryBatches, queryFn: lotteryApi.listBatches });
}

export function useLotteryBoardQuery() {
  return useQuery({ queryKey: queryKeys.lotteryBoard, queryFn: lotteryApi.getBoard });
}

export function useMediaSitesQuery() {
  return useQuery({
    queryKey: queryKeys.mediaSites,
    queryFn: mediaApi.listSites,
    staleTime: 60_000,
  });
}

export function useMediaFeedQuery(enabled = true) {
  const siteId = useMediaStore((s) => s.siteId);
  const query = useMediaStore((s) => s.query);
  const promptQuery = useMediaStore((s) => s.promptQuery);
  const page = useMediaStore((s) => s.page);
  const sort = useMediaStore((s) => s.sort);
  const rating = useMediaStore((s) => s.rating);
  const aiTypeFilter = useMediaStore((s) => s.aiTypeFilter);
  const showR18 = useMediaStore((s) => s.showR18);
  const mode = useMediaStore((s) => s.mode);
  return useQuery({
    queryKey: queryKeys.mediaFeed(siteId, query, promptQuery, page, sort, rating, aiTypeFilter, showR18),
    queryFn: () =>
      mediaApi.searchPosts({
        siteId,
        query,
        promptQuery,
        page,
        limit: 40,
        sort,
        rating,
        aiType: aiTypeFilter,
        showR18,
      }),
    enabled: enabled && mode === "feed" && Boolean(siteId),
    retry: false,
  });
}

export function useMediaTagSuggestQuery(siteId: string, tokenQuery: string, category: "all" | "artist" = "all") {
  const clean = tokenQuery.trim();
  return useQuery({
    queryKey: queryKeys.mediaSuggest(siteId, clean, category),
    queryFn: () => mediaApi.suggestTags({ siteId, query: clean, category }),
    enabled: Boolean(siteId && clean.length >= 2),
    staleTime: 60_000,
    retry: false,
  });
}

export function useMediaPostDetailQuery(siteId: string, postId: string | null) {
  return useQuery({
    queryKey: queryKeys.mediaPost(siteId, postId || ""),
    queryFn: () => mediaApi.getPost(siteId, postId!),
    enabled: Boolean(siteId && postId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function useMediaArtistsQuery(enabled = true) {
  const siteId = useMediaStore((s) => s.siteId);
  const name = useMediaStore((s) => s.artistQuery);
  const url = useMediaStore((s) => s.artistUrlQuery);
  const order = useMediaStore((s) => s.artistOrder);
  const hasTag = useMediaStore((s) => s.artistHasTag);
  const isDeleted = useMediaStore((s) => s.artistDeleted);
  const page = useMediaStore((s) => s.artistPage);
  const mode = useMediaStore((s) => s.mode);
  return useQuery({
    queryKey: queryKeys.mediaArtists(siteId, name, url, order, hasTag, isDeleted, page),
    queryFn: () =>
      mediaApi.searchArtists({
        siteId,
        name,
        url,
        order,
        hasTag,
        isDeleted,
        page,
        limit: 24,
      }),
    enabled: enabled && mode === "artists" && Boolean(siteId),
    retry: false,
  });
}

export function useMediaArtistPreviewQuery(artistName: string, enabled = true) {
  const clean = artistName.trim();
  return useQuery({
    queryKey: queryKeys.mediaArtistPreview("danbooru", clean),
    queryFn: () => mediaApi.getArtistPreview(clean, "danbooru"),
    enabled: enabled && Boolean(clean),
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}

export function useMediaArtistPostsQuery(artistName: string, page: number, enabled = true) {
  const clean = artistName.trim().replace(/\s+/g, "_");
  return useQuery({
    queryKey: queryKeys.mediaFeed("danbooru", clean, "", page, "new", "all", "all", true),
    queryFn: () =>
      mediaApi.searchPosts({
        siteId: "danbooru",
        query: clean,
        page,
        limit: 40,
        sort: "new",
        rating: "all",
      }),
    enabled: enabled && Boolean(clean),
    retry: false,
  });
}
