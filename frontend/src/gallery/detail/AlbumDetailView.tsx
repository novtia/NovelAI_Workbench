import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { galleryApi } from "@/api";
import { queryKeys } from "@/data";
import type { Artwork } from "@/data/types";
import { confirmDialog, pushToast, useAlbumsQuery, useCommands, useItemsQuery, useSession, useSettings, useTabs } from "@/state";
import { AlbumCanvas } from "./AlbumCanvas";
import { AlbumParams } from "./AlbumParams";
import { AlbumRail } from "./AlbumRail";

export function AlbumDetailView() {
  const albumId = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.albumId || "");
  const view = useSession((s) => s.view);
  const openId = useSession((s) => s.openId);
  const setOpenId = useSession((s) => s.setOpenId);
  const albumsQ = useAlbumsQuery();
  const itemsQ = useItemsQuery(albumId);
  const sort = useSettings((s) => s.gallery.sort);
  const album = (albumsQ.data || []).find((a) => a.id === albumId) || null;
  const { generateFrom } = useCommands();
  const qc = useQueryClient();

  const ordered = useMemo(() => {
    const list = itemsQ.data || [];
    return [...list].sort((a, b) => (sort === "added_asc" ? a.addedAt - b.addedAt : b.addedAt - a.addedAt));
  }, [itemsQ.data, sort]);

  useEffect(() => {
    if (!albumId || !itemsQ.isSuccess) return;
    const cur = useSession.getState().openId;
    if (cur && ordered.some((it) => it.id === cur)) return;
    setOpenId(ordered[0]?.id ?? null);
  }, [albumId, itemsQ.isSuccess, ordered, setOpenId]);

  const selected = ordered.find((it) => it.id === openId) || null;
  const missing = Boolean(albumId) && albumsQ.isSuccess && !album;
  const loading = !itemsQ.isSuccess && !itemsQ.data;
  const emptyText = loading ? "正在读取…" : "这个收藏夹还没有图片";

  function select(id: string) {
    if (useSession.getState().openId !== id) setOpenId(id);
  }

  function openInStudio(item: Artwork) {
    useTabs.getState().openTab("studio");
    generateFrom(item);
  }

  async function remove(item: Artwork) {
    if (!(await confirmDialog("删除这张图片？会同时删除本地文件，无法恢复。", { title: "删除图片", confirmText: "删除" }))) return;
    const idx = ordered.findIndex((it) => it.id === item.id);
    const next = ordered[idx + 1] || ordered[idx - 1] || null;
    try {
      await galleryApi.deleteItem(item.id);
      setOpenId(next?.id ?? null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.items(albumId) }),
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
      ]);
      pushToast("已删除");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "删除失败", "error");
    }
  }

  if (missing) {
    return (
      <section className={`view${view === "album" ? " active" : ""}`} id="view-album">
        <div className="album-missing">
          <p>这个收藏夹已经不在了。关掉这个标签即可。</p>
        </div>
      </section>
    );
  }

  return (
    <section className={`view${view === "album" ? " active" : ""}`} id="view-album">
      <div className="album-detail">
        <AlbumRail name={album?.name || "收藏夹"} items={ordered} currentId={selected?.id ?? null} onSelect={select} empty={ordered.length || loading ? null : emptyText} />
        <div className="stage">
          <AlbumCanvas item={selected} empty={ordered.length ? null : emptyText} />
        </div>
        <AlbumParams item={selected} onGenerate={() => selected && openInStudio(selected)} onDelete={() => selected && void remove(selected)} />
      </div>
    </section>
  );
}
