import { useEffect, useMemo } from "react";
import { useAlbumsQuery, useItemsQuery } from "./queries";
import { useSession } from "./session";

export function useCollection() {
  const albumId = useSession((s) => s.albumId);
  const setAlbumId = useSession((s) => s.setAlbumId);
  const openId = useSession((s) => s.openId);
  const query = useSession((s) => s.query);
  const albumsQ = useAlbumsQuery();
  const itemsQ = useItemsQuery(albumId);
  const albums = albumsQ.data || [];
  const items = itemsQ.data || [];

  useEffect(() => {
    if (!albums.length) return;
    if (!albumId || !albums.some((a) => a.id === albumId)) setAlbumId(albums[0].id);
  }, [albums, albumId, setAlbumId]);

  const album = albums.find((a) => a.id === albumId);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const hay = `${it.artistLine} ${(it.artists || []).join(" ")} ${it.name} ${String(it.params?.prompt || "")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);
  const openItem = items.find((it) => it.id === openId);
  const totalCount = albums.reduce((sum, a) => sum + (a.count ?? 0), 0);

  return { albums, album, albumId, items, filtered, openItem, openId, query, totalCount };
}
