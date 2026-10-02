import { useQuery } from "@tanstack/react-query";
import { galleryApi, generationApi, lotteryApi } from "@/api";
import { queryKeys } from "@/data/queryKeys";
import { isTestSetAlbum } from "@/data/singleArtist";
import type { Album } from "@/data/types";
import { useSession } from "./session";
import { useSettings } from "./settingsStore";
import { useStudioStore } from "./studioStore";

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

export function useItemsQuery(albumId?: string) {
  const current = useSession((s) => s.albumId);
  const id = albumId ?? current;
  return useQuery({
    queryKey: queryKeys.items(id),
    queryFn: () => galleryApi.listItems(id),
    enabled: Boolean(id),
  });
}

export function useJobsQuery() {
  return useQuery({ queryKey: queryKeys.jobs, queryFn: generationApi.listJobs, staleTime: Infinity });
}

export function useNaiStatusQuery() {
  const view = useSession((s) => s.view);
  const quotaOpen = useStudioStore((s) => s.quotaOpen);
  const enabled = view === "studio" || view === "settings" || quotaOpen;
  const refreshSec = useSettings((s) => s.account.quotaRefreshSec);
  return useQuery({
    queryKey: queryKeys.naiStatus,
    queryFn: generationApi.tokenStatus,
    enabled,
    refetchInterval: enabled ? refreshSec * 1000 : false,
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
