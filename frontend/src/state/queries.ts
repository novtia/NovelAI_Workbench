import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { galleryApi, generationApi, lotteryApi } from "@/api";
import { queryKeys } from "@/data/queryKeys";
import { isTestSetAlbum } from "@/data/singleArtist";
import type { Album } from "@/data/types";
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
