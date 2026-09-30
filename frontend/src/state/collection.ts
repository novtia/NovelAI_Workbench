import { useEffect, useMemo } from "react";
import { activeTestSetId } from "@/data";
import type { Artwork } from "@/data/types";
import { useAlbumsQuery, useItemsQuery, useTestSetsQuery } from "./queries";
import { useSession } from "./session";

const NO_ITEMS: Artwork[] = [];

export function artworkMatches(it: Artwork, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${it.artistLine} ${(it.artists || []).join(" ")} ${it.name} ${String(it.params?.prompt || "")}`.toLowerCase();
  return hay.includes(q);
}

export function useCollection() {
  const albumId = useSession((s) => s.albumId);
  const testSetId = useSession((s) => s.testSetId);
  const setAlbumId = useSession((s) => s.setAlbumId);
  const setTestSetId = useSession((s) => s.setTestSetId);
  const selectionReady = useSession((s) => s.selectionReady);
  const openId = useSession((s) => s.openId);
  const query = useSession((s) => s.query);
  const albumsQ = useAlbumsQuery();
  const testSetsQ = useTestSetsQuery();
  const albums = albumsQ.data || [];
  const testSets = testSetsQ.data || [];
  const album = albums.find((a) => a.id === albumId);
  const rawTestSet = testSets.find((t) => t.id === testSetId) || null;
  // 测试集只在「单画师」收藏夹里生效，切到别的收藏夹就显示那个收藏夹自己的图。
  const testSet = activeTestSetId(album, testSetId) ? rawTestSet : null;
  // items 恒为当前收藏夹（默认集）的图，决定画师的顺序、位置、数量；
  // 选了测试集时，测试集里的图放在 skinItems，只作为「皮肤」按画师覆盖，不改变布局。
  const baseQ = useItemsQuery(albumId);
  const skinQ = useItemsQuery(testSet ? testSet.id : "");
  const items = baseQ.data || NO_ITEMS;
  const skinItems = testSet ? skinQ.data || NO_ITEMS : NO_ITEMS;
  const baseItems = items;

  useEffect(() => {
    if (!selectionReady || !albums.length) return;
    if (!albumId || !albums.some((a) => a.id === albumId)) setAlbumId(albums[0].id);
  }, [selectionReady, albums, albumId, setAlbumId]);

  useEffect(() => {
    if (selectionReady && testSetId && testSetsQ.isSuccess && !rawTestSet) setTestSetId("");
  }, [selectionReady, testSetId, testSetsQ.isSuccess, rawTestSet, setTestSetId]);

  const filtered = useMemo(() => items.filter((it) => artworkMatches(it, query)), [items, query]);
  const baseFiltered = filtered;
  const openItem = items.find((it) => it.id === openId) || skinItems.find((it) => it.id === openId);
  const totalCount = albums.reduce((sum, a) => sum + (a.count ?? 0), 0);

  return {
    albums,
    album,
    albumId,
    testSets,
    testSet,
    testSetId: testSet ? testSet.id : "",
    baseItems,
    baseFiltered,
    skinItems,
    items,
    filtered,
    openItem,
    openId,
    query,
    totalCount,
  };
}
