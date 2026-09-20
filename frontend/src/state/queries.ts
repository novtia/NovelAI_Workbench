import { useQuery } from "@tanstack/react-query";
import { galleryApi, generationApi, lotteryApi } from "@/api";
import { queryKeys } from "@/data/queryKeys";
import { useSession } from "./session";

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
  return useQuery({ queryKey: queryKeys.jobs, queryFn: generationApi.listJobs });
}

export function useNaiStatusQuery() {
  return useQuery({
    queryKey: queryKeys.naiStatus,
    queryFn: generationApi.tokenStatus,
    refetchInterval: 60000,
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
