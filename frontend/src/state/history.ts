import type { QueryClient } from "@tanstack/react-query";
import { generationApi } from "@/api";
import { ApiError } from "@/api/client";
import { copyText, defaultForm, formFromMeta, mergeStudioForm, queryKeys } from "@/data";
import type { HistoryShot } from "@/data/history";
import { emit } from "./bus";
import { confirmDialog } from "./confirm";
import { getSettings } from "./settingsStore";
import { pushToast } from "./toast";

export type SaveReport = { saved: number; duplicate: number; failed: number; message: string };

/** 把一批历史图逐张存进收藏夹（收藏夹里是独立的新记录，不引用历史）。 */
export async function saveShotsToAlbum(
  qc: QueryClient,
  shots: HistoryShot[],
  albumId: string,
  albumName = "",
): Promise<SaveReport> {
  let saved = 0;
  let duplicate = 0;
  let failed = 0;
  let firstError = "";
  for (const shot of shots) {
    if (!shot.blobHash) {
      failed += 1;
      continue;
    }
    try {
      await generationApi.promoteItems(albumId, [shot.blobHash], { ...shot.meta, name: "nai.png" });
      saved += 1;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) duplicate += 1;
      else {
        failed += 1;
        if (!firstError && err instanceof Error) firstError = err.message;
      }
    }
  }
  if (saved) {
    await Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.albums }),
      qc.invalidateQueries({ queryKey: queryKeys.items(albumId) }),
    ]);
  }
  const where = albumName ? `「${albumName}」` : "收藏夹";
  let message: string;
  if (shots.length === 1) {
    message = saved
      ? `已保存到${where}`
      : duplicate
        ? "这张已经在这个收藏夹里"
        : firstError || "保存失败";
  } else {
    const parts = [`已保存 ${saved} 张`];
    if (duplicate) parts.push(`重复 ${duplicate} 张`);
    if (failed) parts.push(`失败 ${failed} 张`);
    message = `${parts.join("，")}（${where}）`;
  }
  pushToast(message, saved ? "ok" : "warn");
  return { saved, duplicate, failed, message };
}

/** 把这张图的生成参数整套载回生图室。 */
export function loadShotParams(shot: HistoryShot) {
  emit("generation.openForm", mergeStudioForm(defaultForm(), formFromMeta(shot.meta), { replace: true }));
}

export async function copyShotPrompt(shot: HistoryShot) {
  const prompt = shot.prompt || "";
  pushToast((await copyText(prompt)) ? "已复制提示词" : "没有提示词", prompt ? "ok" : "warn");
}

/** 从历史里删掉一批图。只删历史记录，收藏夹里已保存的图不受影响。返回是否真的删了。 */
export async function deleteHistoryShots(qc: QueryClient, shots: HistoryShot[]): Promise<boolean> {
  if (!shots.length) return false;
  if (getSettings().gallery.confirmDelete) {
    const ok = await confirmDialog(`从历史中删除 ${shots.length} 张图片？已保存到收藏夹的图片不受影响。`, {
      title: "删除历史图片",
      confirmText: "删除",
    });
    if (!ok) return false;
  }
  try {
    const { removed } = await generationApi.deleteHistory(shots.map((s) => ({ jobId: s.jobId, itemId: s.itemId })));
    await Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.history }),
      qc.invalidateQueries({ queryKey: queryKeys.jobs }),
    ]);
    pushToast(removed ? `已删除 ${removed} 张历史图片` : "没有可删除的图片", removed ? "ok" : "warn");
    return removed > 0;
  } catch (err) {
    pushToast(err instanceof Error ? err.message : "删除失败", "error");
    return false;
  }
}
