import { useEffect, useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, generationApi, lotteryApi } from "@/api";
import {
  boardPayload,
  chainText,
  clampControls,
  collectArtistPool,
  copyText,
  defaultForm,
  drawIdOf,
  formToPayload,
  isListed,
  jobIsActive,
  lotteryPrompt,
  matchDrawJob,
  parseCapInput,
  placeLotPop,
  queryKeys,
  singleArtistImportError,
  isSingleArtistAlbum,
  storedDrawShots,
  triggerRect,
} from "@/data";
import type {
  DrawBatch,
  DrawResult,
  Job,
  LotteryControls,
  LotSave,
  LotShot,
  ParamSet,
  StudioForm,
} from "@/data/types";
import { emit } from "./bus";
import { useCollection } from "./collection";
import { useJobsQuery, useLotteryBatchesQuery, useLotteryBoardQuery, useParamSetsQuery } from "./queries";
import { useLotteryStore } from "./lotteryStore";
import { useSession } from "./session";
import { pushToast } from "./toast";

let persistTimer = 0;
let latestLottery: any = {};

function drawKey(batchId: string, drawId: string) {
  return `${batchId}:${drawId}`;
}

function batchNumber(batches: DrawBatch[], id: string) {
  const ordered = [...batches].sort((a, b) => a.createdAt - b.createdAt);
  const i = ordered.findIndex((b) => b.id === id);
  return i >= 0 ? i + 1 : 0;
}

export function useLotterySync() {
  const boardQ = useLotteryBoardQuery();
  const hydrate = useLotteryStore((s) => s.hydrate);
  const version = useLotteryStore((s) => s.boardVersion);
  const dirty = useLotteryStore((s) => s.dirty);
  useEffect(() => () => window.clearTimeout(persistTimer), []);
  useEffect(() => {
    const board = boardQ.data;
    if (!board || dirty) return;
    if ((board.version ?? 0) === version) return;
    hydrate(board);
  }, [boardQ.data, dirty, hydrate, version]);
}

export async function saveLotteryPreview(qc: QueryClient, targetAlbumId: string, ctx: LotSave, albums: Array<{ id: string; name: string }>, extras?: { draw?: DrawResult; form?: Partial<StudioForm> }) {
  const item = ctx.item;
  const hash = item.blobHash || item.id || "";
  if (!hash) {
    pushToast("没有可保存的预览图", "warn");
    return;
  }
  if (item.savedId || item.albumId || useLotteryStore.getState().savedShots[hash]) {
    pushToast("这张已经在图库里", "ok");
    useLotteryStore.getState().closeLotSave();
    return;
  }
  const batches = (qc.getQueryData(queryKeys.lotteryBatches) as DrawBatch[] | undefined) || [];
  const jobs = (qc.getQueryData(queryKeys.jobs) as Job[] | undefined) || [];
  const draw =
    extras?.draw ||
    batches.find((b) => b.id === ctx.batchId)?.draws.find((d, i) => drawIdOf(ctx.batchId, d, i) === ctx.drawId);
  const job = matchDrawJob(jobs, ctx.batchId, ctx.drawId);
  const form = extras?.form || ((job?.client?.form || {}) as Partial<StudioForm>);
  const prompt = lotteryPrompt(draw?.outputText || "", String(form.prompt || ""));
  const artists = extras?.draw?.artists || draw?.artists || [];
  const blocked = isSingleArtistAlbum(albums.find((a) => a.id === targetAlbumId)) ? singleArtistImportError(artists) : null;
  if (blocked) {
    pushToast(blocked, "warn");
    return;
  }
  useLotteryStore.getState().closeLotSave();
  try {
    const saved = (await generationApi.promoteItems(targetAlbumId, [hash], {
      ...form,
      prompt,
      name: "nai.png",
      artists: extras?.draw?.artists || draw?.artists || [],
      artistLine: chainText(extras?.draw?.outputText || draw?.outputText || ""),
      source: "nai-v5",
    })) as Array<{ id?: string; albumId?: string }>;
    const rec = saved[0];
    if (rec?.id) {
      useLotteryStore.getState().markSaved(hash, { savedId: rec.id, albumId: rec.albumId || targetAlbumId });
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
        qc.invalidateQueries({ queryKey: queryKeys.items(targetAlbumId) }),
      ]);
      const name = albums.find((a) => a.id === targetAlbumId)?.name;
      pushToast(name ? `已保存到「${name}」` : "已保存到收藏夹", "ok");
    }
  } catch (err) {
    pushToast(err instanceof ApiError && err.status === 409 ? "这张已经在图库里" : err instanceof Error ? err.message : "保存失败", "warn");
  }
}

export function useLottery() {
  const qc = useQueryClient();
  const albumId = useSession((s) => s.albumId);
  // 抽奖池永远取当前收藏夹本身，不受图库里选中的测试集影响。
  const { albums, baseItems: items } = useCollection();
  const batchesQ = useLotteryBatchesQuery();
  const setsQ = useParamSetsQuery();
  const jobsQ = useJobsQuery();
  const store = useLotteryStore();

  const pool = useMemo(() => collectArtistPool(items), [items]);
  const excluded = store.excluded;
  const pinned = store.pinned;
  const active = pool.filter((p) => !isListed(excluded, p));
  const locked = active.filter((p) => isListed(pinned, p));
  const pinnedCount = locked.length;
  const query = store.poolQuery.trim().toLowerCase();
  const visible = pool.filter((p) => !query || p.name.toLowerCase().includes(query));
  const batches = batchesQ.data || [];
  const jobs = jobsQ.data || [];
  const sets = setsQ.data || [];
  const preset = sets.find((s) => s.id === store.presetId) || null;
  const lotteryJobs = jobs.filter((j) => j.source === "lottery" && jobIsActive(j));
  const controls = store.controls;

  async function persist(
    next?: Partial<{
      excluded: string[];
      pinned: string[];
      weightCaps: Record<string, number>;
      controls: LotteryControls;
      presetId: string;
    }>,
    immediate = true,
  ) {
    const s = useLotteryStore.getState();
    const excludedNext = next?.excluded ?? s.excluded;
    const pinnedNext = next?.pinned ?? s.pinned;
    const capsNext = next?.weightCaps ?? s.weightCaps;
    const controlsNext = next?.controls ?? s.controls;
    const presetId = next?.presetId ?? s.presetId;
    if (next && "excluded" in next) s.setExcluded(excludedNext);
    if (next && "pinned" in next) s.setPinned(pinnedNext);
    if (next && "weightCaps" in next) s.setWeightCaps(capsNext);
    if (next && "controls" in next) s.setControls(controlsNext);
    if (next && "presetId" in next) s.setPresetId(presetId);
    const run = async () => {
      try {
        const board = await lotteryApi.saveBoard(
          boardPayload({
            albumId,
            excluded: excludedNext,
            pinned: pinnedNext,
            weightCaps: capsNext,
            controls: { ...controlsNext, presetId },
          }),
        );
        qc.setQueryData(queryKeys.lotteryBoard, board);
        useLotteryStore.getState().setBoardVersion(board.version ?? 0);
        useLotteryStore.getState().setDirty(false);
      } catch (err) {
        pushToast(err instanceof Error ? err.message : "抽奖台保存失败", "error");
      }
    };
    window.clearTimeout(persistTimer);
    if (immediate) await run();
    else persistTimer = window.setTimeout(() => void run(), 280);
  }

  function pendingDraws(batch?: DrawBatch) {
    const src = batch ? [batch] : batches;
    const out: Array<{ batch: DrawBatch; i: number; draw: DrawResult }> = [];
    for (const b of src) {
      b.draws.forEach((draw, i) => {
        const id = drawIdOf(b.id, draw, i);
        const key = drawKey(b.id, id);
        const job = matchDrawJob(jobs, b.id, id);
        if (store.enqueuing.includes(key) || jobIsActive(job)) return;
        out.push({ batch: b, i, draw });
      });
    }
    return out;
  }

  function buildPayload(presetSet: ParamSet, text: string, client: Record<string, unknown>) {
    const form: StudioForm = {
      ...presetSet.form,
      characters: (presetSet.form.characters || []).map((c) => ({ ...c })),
    };
    const chain = chainText(text);
    const hasChar = (form.characters || []).some((c) => String(c.prompt || "").trim());
    if (!hasChar) form.characters = [{ prompt: "girl, solo", uc: "", x: 0.5, y: 0.5 }];
    return {
      ...formToPayload(form, { artists: chain, source: "lottery" }),
      source: "lottery",
      client: { ...client, form },
    };
  }

  async function generateDraws(list: Array<{ batch: DrawBatch; i: number; draw: DrawResult }>, force = false) {
    if (!preset) {
      pushToast("请先选择生图预设", "warn");
      return;
    }
    if (!list.length) {
      pushToast("没有待生图的抽奖串", "warn");
      return;
    }
    if (!String(preset.form.prompt || "").trim() && preset.form.quality === "off") {
      pushToast("先填主体 Prompt，或打开质量词", "warn");
      return;
    }
    const queued: Array<{ batch: DrawBatch; i: number; draw: DrawResult; key: string }> = [];
    for (const item of list) {
      const id = drawIdOf(item.batch.id, item.draw, item.i);
      const key = drawKey(item.batch.id, id);
      const job = matchDrawJob(jobs, item.batch.id, id);
      if (store.enqueuing.includes(key) || jobIsActive(job)) continue;
      if (!force && (storedDrawShots(item.draw).length || (job?.status === "done" && job.items?.length))) continue;
      store.addEnqueuing(key);
      queued.push({ ...item, key });
    }
    if (!queued.length) {
      pushToast(force ? "这条正在生图中" : "没有待生图的抽奖串", "warn");
      return;
    }
    let n = 0;
    try {
      for (const item of queued) {
        try {
          await generationApi.submitJob(
            buildPayload(preset, item.draw.outputText, {
              batchId: item.batch.id,
              batchN: batchNumber(batches, item.batch.id),
              drawId: drawIdOf(item.batch.id, item.draw, item.i),
              drawIndex: item.i,
            }),
          );
          n += 1;
        } catch (err) {
          pushToast(err instanceof Error ? err.message : "排队失败", "error");
          break;
        }
      }
    } finally {
      for (const item of queued) store.removeEnqueuing(item.key);
      await qc.invalidateQueries({ queryKey: queryKeys.jobs });
    }
    if (n) {
      pushToast(
        n === 1 ? (force ? "已在后台重绘，切换页面不会中断" : "已在后台执行，切换页面不会中断") : `已在后台排队 ${n} 条，切换页面不会中断`,
        "ok",
      );
    }
  }

  const api = {
    albumId,
    albums,
    pool,
    active,
    locked,
    pinnedCount,
    visible,
    query: store.poolQuery,
    setQuery: store.setPoolQuery,
    excluded,
    pinned,
    weightCaps: store.weightCaps,
    controls,
    presetId: store.presetId,
    preset,
    sets,
    batches,
    jobs,
    lotteryJobs,
    boundMin: Math.max(1, pinnedCount),
    boundMax: Math.max(active.length, 1),
    lotSave: store.lotSave,
    savedShots: store.savedShots,
    enqueuing: store.enqueuing,
    scrollTo: store.scrollTo,
    setScrollTo: store.setScrollTo,
    moveLotSave: store.moveLotSave,
    closeLotSave: store.closeLotSave,
    togglePin: (key: string) => {
      const on = isListed(store.pinned, { key });
      void persist({
        pinned: on ? store.pinned.filter((x) => x !== key) : [...store.pinned, key],
        excluded: on ? store.excluded : store.excluded.filter((x) => x !== key),
      });
    },
    toggleExclude: (key: string) => {
      const off = isListed(store.excluded, { key });
      void persist({
        excluded: off ? store.excluded.filter((x) => x !== key) : [...store.excluded, key],
        pinned: off ? store.pinned : store.pinned.filter((x) => x !== key),
      });
    },
    restoreExcluded: () => void persist({ excluded: [] }),
    applyCap: (key: string, raw: string) => {
      const parsed = parseCapInput(raw);
      if (parsed === false) return String(store.weightCaps[key] ?? "");
      const next = { ...store.weightCaps };
      if (parsed === "") delete next[key];
      else next[key] = parsed;
      void persist({ weightCaps: next });
      return parsed === "" ? "" : String(parsed);
    },
    patchControls: (patch: Partial<LotteryControls>, immediate = false) => {
      const next = { ...store.controls, ...patch };
      store.setControls(next);
      void persist({ controls: next }, immediate);
    },
    setPreset: (id: string) => {
      void persist({ presetId: id });
      const item = sets.find((s) => s.id === id);
      if (item) emit("generation.applyForm", item.form);
    },
    roll: async () => {
      if (!albumId) return pushToast("请先选择收藏夹", "warn");
      if (!active.length) return pushToast("画师池为空，先在左侧恢复一些画师", "warn");
      const next = clampControls(store.controls, active.length, pinnedCount);
      if (!Number.isFinite(next.target) || next.target <= 0) return pushToast("目标和必须大于 0", "warn");
      if (next.min < 1 || next.max < 1) return pushToast("没有可抽的画师", "warn");
      store.setControls(next);
      try {
        await persist({ controls: next }, true);
        const batch = await lotteryApi.rollDraws(albumId, {
          excluded: useLotteryStore.getState().excluded,
          pinned: useLotteryStore.getState().pinned,
          weightCaps: useLotteryStore.getState().weightCaps,
          controls: next,
        });
        await qc.invalidateQueries({ queryKey: queryKeys.lotteryBatches });
        store.setScrollTo(batch.id);
        pushToast(
          pinnedCount
            ? `第 ${batches.length + 1} 批：${batch.draws.length} 条 · 每条 ${next.min}~${next.max} 人（基底 ${pinnedCount}）· 权重 ${next.wmin}~${next.wmax}`
            : `第 ${batches.length + 1} 批：${batch.draws.length} 条 · 每条 ${next.min}~${next.max} 人 · 权重 ${next.wmin}~${next.wmax}`,
          "ok",
        );
      } catch (err) {
        pushToast(err instanceof Error ? err.message : "抽奖失败", "error");
      }
    },
    pendingDraws,
    generateAll: () => generateDraws(pendingDraws(), true),
    generateBatch: (batch: DrawBatch) => generateDraws(pendingDraws(batch), true),
    generateOne: (batch: DrawBatch, draw: DrawResult, i?: number) => {
      const index = i ?? batch.draws.findIndex((d) => drawIdOf(batch.id, d) === drawIdOf(batch.id, draw));
      return generateDraws([{ batch, i: index < 0 ? 0 : index, draw }], true);
    },
    copyAll: async () => {
      const text = batches.flatMap((b) => b.draws.map((d) => chainText(d.outputText))).join("\n");
      pushToast((await copyText(text)) ? "已复制全部抽奖结果" : "还没有抽奖结果", text ? "ok" : "warn");
    },
    copyBatch: async (batch: DrawBatch, n: number) => {
      const text = batch.draws.map((d) => chainText(d.outputText)).join("\n");
      pushToast((await copyText(text)) ? `已复制第 ${n} 批` : "复制失败", text ? "ok" : "warn");
    },
    copyDraw: async (draw: DrawResult) => {
      const text = chainText(draw.outputText);
      pushToast((await copyText(text)) ? "已复制画师串" : "复制失败", text ? "ok" : "warn");
    },
    removeBatch: async (batch: DrawBatch, n: number) => {
      await lotteryApi.deleteBatch(batch.id);
      await qc.invalidateQueries({ queryKey: queryKeys.lotteryBatches });
      pushToast(`已删除第 ${n} 批`, "ok");
    },
    removeDraw: async (batch: DrawBatch, draw: DrawResult, index?: number) => {
      const id = drawIdOf(batch.id, draw, index);
      if (!id) {
        pushToast("找不到这条抽奖串", "warn");
        return;
      }
      await lotteryApi.removeDraw(batch.id, id);
      await qc.invalidateQueries({ queryKey: queryKeys.lotteryBatches });
      pushToast("已删除这条抽奖串", "ok");
    },
    verify: async (batch: DrawBatch) => {
      const r = await lotteryApi.verifyBatch(batch.id);
      pushToast(r.ok ? "校验通过" : "校验失败", r.ok ? "ok" : "error");
    },
    editDraw: (draw: DrawResult, job?: Job | null) => {
      const chain = chainText(draw.outputText);
      const meta = (job?.client?.form || job?.meta || {}) as Partial<StudioForm>;
      const base = preset?.form || defaultForm();
      const merged: StudioForm = {
        ...defaultForm(),
        ...base,
        ...meta,
        characters: (meta.characters || base.characters || []).map((c) => ({ ...c })),
      };
      const prompt = String(merged.prompt || "").trim();
      merged.prompt = prompt ? lotteryPrompt(chain, prompt) : chain;
      emit("generation.openForm", merged);
      useSession.getState().setView("studio");
      pushToast("已载入这张图的参数", "ok");
    },
    openSave: (trigger: HTMLElement, ctx: { batchId: string; drawId: string; shotIndex: number; item: LotShot }) => {
      const hash = ctx.item.blobHash || ctx.item.id || "";
      if (!hash) {
        pushToast("没有可保存的预览图", "warn");
        return;
      }
      if (ctx.item.savedId || ctx.item.albumId || store.savedShots[hash]) {
        pushToast("这张已经在图库里", "ok");
        return;
      }
      const same =
        store.lotSave &&
        store.lotSave.batchId === ctx.batchId &&
        store.lotSave.drawId === ctx.drawId &&
        store.lotSave.shotIndex === ctx.shotIndex;
      if (same) {
        store.closeLotSave();
        return;
      }
      const r = triggerRect(trigger);
      const pos = placeLotPop(228, 280, r);
      store.openLotSave({ ...ctx, left: pos.left, top: pos.top, trigger: r });
    },
    savePreviewTo: (targetAlbumId: string) => {
      const ctx = useLotteryStore.getState().lotSave;
      if (!ctx) return;
      const job = matchDrawJob(jobs, ctx.batchId, ctx.drawId);
      const batch = batches.find((b) => b.id === ctx.batchId);
      return saveLotteryPreview(qc, targetAlbumId, ctx, albums, {
        draw: batch?.draws.find((d, i) => drawIdOf(batch.id, d, i) === ctx.drawId),
        form: (job?.client?.form || preset?.form) as Partial<StudioForm>,
      });
    },
    createAlbumForSave: () => {
      const ctx = store.lotSave;
      store.closeLotSave();
      store.setPendingSave(ctx);
      useSession.getState().openCreateDialog();
    },
    drawJob: (batchId: string, drawId: string) => matchDrawJob(jobs, batchId, drawId),
    batchNumber: (id: string) => batchNumber(batches, id),
  };
  latestLottery = api;
  return api;
}

/** 行组件用：包装函数引用稳定，调用时转到最近一次 useLottery 渲染出的实现。 */
export function useLotteryActions() {
  return useMemo(
    () => ({
      togglePin: (key: string) => latestLottery.togglePin(key),
      toggleExclude: (key: string) => latestLottery.toggleExclude(key),
      applyCap: (key: string, raw: string) => latestLottery.applyCap(key, raw) as string,
      copyDraw: (draw: DrawResult) => latestLottery.copyDraw(draw),
      generateOne: (batch: DrawBatch, draw: DrawResult, i?: number) => latestLottery.generateOne(batch, draw, i),
      removeDraw: (batch: DrawBatch, draw: DrawResult, index?: number) => latestLottery.removeDraw(batch, draw, index),
      editDraw: (draw: DrawResult, job?: Job | null) => latestLottery.editDraw(draw, job),
      openSave: (trigger: HTMLElement, ctx: { batchId: string; drawId: string; shotIndex: number; item: LotShot }) =>
        latestLottery.openSave(trigger, ctx),
      generateBatch: (batch: DrawBatch) => latestLottery.generateBatch(batch),
      copyBatch: (batch: DrawBatch, n: number) => latestLottery.copyBatch(batch, n),
      removeBatch: (batch: DrawBatch, n: number) => latestLottery.removeBatch(batch, n),
      verify: (batch: DrawBatch) => latestLottery.verify(batch),
      batchNumber: (id: string) => latestLottery.batchNumber(id) as number,
    }),
    [],
  );
}
