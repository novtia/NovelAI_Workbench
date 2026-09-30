import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { galleryApi } from "@/api";
import { queryKeys } from "@/data/queryKeys";
import { useSession } from "./session";

/** 启动时从后端读出图库全局选择（当前收藏夹 / 测试集 / 测试生图预设），读到之前不写回。 */
export function useGallerySelectionSync() {
  const ready = useSession((s) => s.selectionReady);
  const hydrate = useSession((s) => s.hydrateSelection);
  const q = useQuery({
    queryKey: queryKeys.galleryView,
    queryFn: galleryApi.getView,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (ready) return;
    if (q.data) {
      hydrate({ albumId: q.data.albumId, testSetId: q.data.testSetId, testPresetId: q.data.presetId });
    } else if (q.isError) {
      hydrate({ albumId: "", testSetId: "", testPresetId: "" });
    }
  }, [ready, q.data, q.isError, hydrate]);
}