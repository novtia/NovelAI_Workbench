import { useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { generationApi } from "@/api";
import { artistQuickPayload, isSingleArtistAlbum, jobIsActive, queryKeys, quickJobTarget, resolveArtistTestForm, stripArtist, tagKey } from "@/data";
import type { ParamSet } from "@/data/types";
import { useAlbumsQuery, useJobsQuery, useParamSetsQuery } from "./queries";
import { getSettings } from "./settingsStore";
import { pushToast } from "./toast";

/** 已点了「生成」、任务还没出现在任务列表里的画师（防止连点、也让按钮立刻变成「生成中」）。 */
const useSubmittingStore = create<{ keys: string[]; add: (k: string) => void; remove: (k: string) => void }>((set) => ({
  keys: [],
  add: (k) => set((s) => (s.keys.includes(k) ? s : { keys: [...s.keys, k] })),
  remove: (k) => set((s) => ({ keys: s.keys.filter((x) => x !== k) })),
}));

/**
 * 单画师图库里没有这位画师时，悬停预览给一个「添加并生成」入口：
 * 用设置里「画师测试」的参数生成 1 张，完成后后端直接把图存进「单画师」收藏夹。
 */
export function useArtistQuickGen() {
  const qc = useQueryClient();
  const albums = useAlbumsQuery().data;
  const jobs = useJobsQuery().data;
  const presets = useParamSetsQuery().data;
  const presetsRef = useRef<ParamSet[]>([]);
  presetsRef.current = presets || [];
  const submitting = useSubmittingStore((s) => s.keys);
  const albumId = useMemo(() => (albums || []).find(isSingleArtistAlbum)?.id || "", [albums]);

  /** 正在生成的画师 key（任务排队/运行中 + 刚点下还没入列的）。 */
  const pending = useMemo(() => {
    const set = new Set<string>(submitting);
    for (const job of jobs || []) {
      if (!jobIsActive(job)) continue;
      const target = quickJobTarget(job.client);
      if (target) set.add(tagKey(target.name));
    }
    return set;
  }, [jobs, submitting]);

  async function generate(rawName: string) {
    const name = stripArtist(rawName);
    const key = tagKey(name);
    if (!albumId || !key) return;
    const store = useSubmittingStore.getState();
    if (store.keys.includes(key) || pending.has(key)) return;
    store.add(key);
    try {
      const { form } = resolveArtistTestForm(getSettings().artistTest, presetsRef.current);
      if (!form.prompt && !form.characters.length && form.quality === "off") {
        pushToast("请先在「设置 → 画师测试」里填提示词，或打开质量词", "warn");
        return;
      }
      await generationApi.submitJob(artistQuickPayload(form, albumId, name, `artist:${name}`));
      await qc.invalidateQueries({ queryKey: queryKeys.jobs });
      pushToast(`已加入队列：生成「${name}」的测试图，完成后自动存进单画师`, "ok");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "排队失败", "error");
    } finally {
      useSubmittingStore.getState().remove(key);
    }
  }

  return { albumId, pending, generate };
}
