import { useQuery } from "@tanstack/react-query";
import { galleryApi, generationApi, lotteryApi } from "@/api";
import { queryKeys } from "@/data/queryKeys";
import { useSession } from "./session";
import { useStudioStore } from "./studioStore";

export function useAlbumsQuery() {
  return useQuery({ queryKey: queryKeys.albums, queryFn: galleryApi.listAlbums });
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
  const enabled = view === "studio" || quotaOpen;
  return useQuery({
    queryKey: queryKeys.naiStatus,
    queryFn: generationApi.tokenStatus,
    enabled,
    refetchInterval: enabled ? 60000 : false,
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
