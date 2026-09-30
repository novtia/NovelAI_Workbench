import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { galleryApi } from "@/api";
import { ApiError } from "@/api/client";
import { activeTestSetId, artistText, copyText, fileFromShotRef, importImageFiles, isSingleArtistAlbum, isTestSetAlbum, promptText, queryKeys, SINGLE_ARTIST_ALBUM_NAME, singleArtistImportError } from "@/data";
import type { Album, Artwork } from "@/data/types";
import type { StudioShotDrag } from "@/data/files";
import { emit } from "./bus";
import { useSession } from "./session";
import { pushToast } from "./toast";
import { saveLotteryPreview } from "./lottery";
import { useLotteryStore } from "./lotteryStore";
import { saveStudioCurrent } from "./studio";
import { useStudioStore } from "./studioStore";

export function useCommands() {
  const qc = useQueryClient();
  return useMemo(() => {
  const read = () => {
    const session = useSession.getState();
    const albums = ((qc.getQueryData(queryKeys.albums) as Album[] | undefined) || []).filter((a) => !isTestSetAlbum(a));
    const albumId = session.albumId;
    const album = albums.find((a) => a.id === albumId) || null;
    // 测试集里的图是「皮肤」，默认集的图始终在；当前打开的图可能是其中任意一处的。
    const skinId = activeTestSetId(album, session.testSetId);
    const items = (qc.getQueryData(queryKeys.items(albumId)) as Artwork[] | undefined) || [];
    const skins = skinId ? (qc.getQueryData(queryKeys.items(skinId)) as Artwork[] | undefined) || [] : [];
    const openItem = items.find((it) => it.id === session.openId) || skins.find((it) => it.id === session.openId) || null;
    return { session, albums, album, albumId, items, openItem };
  };

  async function refresh(...ids: string[]) {
    const targets = [...new Set(ids.filter(Boolean))];
    if (!targets.length) {
      const { albumId: current, testSetId } = useSession.getState();
      if (current) targets.push(current);
      if (testSetId) targets.push(testSetId);
    }
    await qc.invalidateQueries({ queryKey: queryKeys.albums });
    await Promise.all(targets.map((id) => qc.invalidateQueries({ queryKey: queryKeys.items(id) })));
  }

  async function importFiles(fileList: Iterable<File>) {
    const { session, album, albumId } = read();
    if (!albumId) return;
    const list = [...fileList];
    if (!list.length) {
      pushToast("没有可导入的图片", "warn");
      return;
    }
    session.setProgress(true, 0, list.length);
    const result = await importImageFiles(list, albumId, (done, total) => session.setProgress(true, done, total), {
      singleArtist: isSingleArtistAlbum(album),
    });
    session.setProgress(false);
    await refresh();
    const bits = [`导入 ${result.added} 张`];
    if (result.dup) bits.push(`跳过 ${result.dup} 张重复`);
    if (result.rejected) bits.push(`跳过 ${result.rejected} 张（需单个画师串）`);
    if (result.noMeta) bits.push(`${result.noMeta} 张无参数`);
    pushToast(bits.join("，"), result.added ? "ok" : "warn");
  }

  async function ingestDropped(files: File[], shot?: StudioShotDrag | null) {
    if (shot) {
      if (useSession.getState().view === "studio") {
        emit("generation.dropShot", shot);
        return;
      }
      const file = await fileFromShotRef(shot);
      if (!file) {
        pushToast("无法读取这张图", "warn");
        return;
      }
      await importFiles([file]);
      return;
    }
    if (useSession.getState().view === "studio") {
      emit("generation.drop", files);
      return;
    }
    await importFiles(files);
  }

  async function copyArtists(item?: Artwork | null) {
    const target = item || read().openItem;
    const text = target ? artistText(target) : "";
    pushToast((await copyText(text)) ? "已复制画师串" : "没有可复制的画师", text ? "ok" : "warn");
  }

  async function copyPrompt(item?: Artwork | null) {
    const target = item || read().openItem;
    const text = target ? promptText(target) : "";
    pushToast((await copyText(text)) ? "已复制 Prompt" : "没有 Prompt", text ? "ok" : "warn");
  }

  function generateFrom(item: Artwork) {
    emit("generation.open", item);
    useSession.getState().setView("studio");
  }

  async function moveOpenItem(targetAlbumId: string) {
    const { session, albums, openItem } = read();
    if (!openItem || !targetAlbumId || targetAlbumId === openItem.albumId) return;
    const target = albums.find((a) => a.id === targetAlbumId);
    const blocked = isSingleArtistAlbum(target) ? singleArtistImportError(openItem.artists) : null;
    if (blocked) {
      pushToast(blocked, "warn");
      return;
    }
    try {
      if (await galleryApi.hashExists(targetAlbumId, openItem.hash)) {
        pushToast("目标收藏夹已有这张图", "warn");
        return;
      }
      await galleryApi.moveItem(openItem.id, targetAlbumId);
      session.setOpenId(null);
      await refresh(openItem.albumId, targetAlbumId);
      const name = albums.find((a) => a.id === targetAlbumId)?.name || "";
      pushToast(`已移到「${name}」`, "ok");
    } catch (err) {
      pushToast(err instanceof ApiError && err.status === 409 ? "目标收藏夹已有这张图" : err instanceof Error ? err.message : "移动失败", "warn");
    }
  }

  async function deleteOpenItem() {
    const { session, openItem } = read();
    if (!openItem) return;
    await galleryApi.deleteItem(openItem.id);
    session.setOpenId(null);
    await refresh(openItem.albumId);
    pushToast("已删除");
  }

  async function clearCurrentAlbum() {
    const { session, album, albumId, items } = read();
    if (!albumId || !items.length) return;
    const name = album?.name || "当前收藏夹";
    if (!confirm(`清空「${name}」中的 ${items.length} 张图片？`)) return;
    await galleryApi.clearAlbum(albumId);
    session.setOpenId(null);
    await refresh();
    pushToast("已清空当前收藏夹");
  }

  async function deleteAlbumById(id: string) {
    const { albums } = read();
    if (albums.length <= 1) {
      pushToast("至少保留一个收藏夹", "warn");
      return;
    }
    const target = albums.find((a) => a.id === id);
    if (!target) return;
    if (isSingleArtistAlbum(target)) {
      pushToast("系统收藏夹不可删除", "warn");
      return;
    }
    const n = target.count ?? 0;
    const msg = n ? `删除「${target.name}」以及其中 ${n} 张图片？` : `删除收藏夹「${target.name}」？`;
    if (!confirm(msg)) return;
    try {
      await galleryApi.deleteAlbum(id);
      await refresh();
      pushToast("已删除收藏夹");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "删除失败", "error");
    }
  }

  async function submitDialog() {
    const dialog = useSession.getState().dialog;
    const trimmed = dialog?.name.trim() || "";
    if (!dialog || !trimmed) return;
    if (trimmed === SINGLE_ARTIST_ALBUM_NAME) {
      pushToast("「单画师」为系统收藏夹名称", "warn");
      return;
    }
    const { session, albums } = read();
    if (dialog.mode === "rename" && dialog.albumId && isSingleArtistAlbum(albums.find((a) => a.id === dialog.albumId))) {
      pushToast("系统收藏夹不可重命名", "warn");
      return;
    }
    try {
      if (dialog.mode === "rename" && dialog.albumId) {
        await galleryApi.renameAlbum(dialog.albumId, trimmed);
        pushToast("已重命名", "ok");
      } else {
        const created = await galleryApi.createAlbum(trimmed);
        pushToast("已创建收藏夹", "ok");
        session.closeDialog();
        await refresh();
        const pending = useLotteryStore.getState().pendingSave;
        if (pending) {
          useLotteryStore.getState().setPendingSave(null);
          await saveLotteryPreview(qc, created.id, pending, albums);
        } else if (useStudioStore.getState().pendingSave) {
          useStudioStore.getState().setPendingSave(false);
          await saveStudioCurrent(qc, created.id, albums);
        } else {
          session.setAlbumId(created.id);
        }
        return;
      }
      session.closeDialog();
      await refresh();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "失败", "error");
    }
  }

  return {
    importFiles,
    ingestDropped,
    copyArtists,
    copyPrompt,
    generateFrom,
    moveOpenItem,
    deleteOpenItem,
    clearCurrentAlbum,
    deleteAlbumById,
    submitDialog,
    selectAlbum: (id: string) => useSession.getState().setAlbumId(id),
    openItemById: (id: string | null) => useSession.getState().setOpenId(id),
    closeInspector: () => useSession.getState().setOpenId(null),
    pickFiles: () => document.getElementById("wb-file-input")?.click(),
  };
  }, [qc]);
}
