import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, generationApi } from "@/api";
import {
  applySizeToForm,
  cloneForm,
  defaultChar,
  defaultForm,
  formFromItem,
  formFromMeta,
  formToPayload,
  GENDER_PROMPT,
  GENDER_X,
  cleanPromptText,
  hasImportableMeta,
  jobIsActive,
  jobProgressText,
  loadImportOpts,
  MAX_CHARS,
  mergeStudioForm,
  PANEL,
  persistDraft,
  persistImportOpts,
  persistSelectedSet,
  placePop,
  queryKeys,
  reencodePngClean,
  shotFromJobItem,
  singleArtistImportError,
  isSingleArtistAlbum,
  isTestSetAlbum,
  studioDownloadName,
  triggerBlobDownload,
  fileFromShotRef,
  extractArtists,
  defaultI2iBase,
  enhanceJobPayload,
  formForShot,
  i2iJobPayload,
  upscaleJobPayload,
  variationJobPayload,
} from "@/data";
import type {
  Album,
  Artwork,
  EditorMode,
  EnhanceOpts,
  GenderId,
  I2iBase,
  Job,
  ParamSet,
  StudioDownloadKind,
  StudioForm,
  StudioPop,
  StudioShot,
} from "@/data/types";
import type { StudioShotDrag } from "@/data/files";
import { isImageFile, parseImageMeta } from "@/data/png";
import { on } from "./bus";
import { useEstimateQuery, useJobsQuery, useNaiStatusQuery } from "./queries";
import { useSession } from "./session";
import { getSettings } from "./settingsStore";
import { useStudioStore, type StudioState } from "./studioStore";
import { activeTab, currentTabId, runInTab } from "./scoped";
import { assignJobsToTabs, setJobTab } from "./jobTabs";
import { useTabs } from "./tabs";
import { confirmDialog } from "./confirm";
import { pushToast } from "./toast";

const notified = new Set<string>();
let draftTimer = 0;
/** 最近一次拖进来的图片文件；元数据弹窗里点「图生图」时拿它当底图。 */
let lastDropped: File | null = null;

/** 设置里可以关掉草稿自动保存。 */
function saveDraft() {
  if (getSettings().generation.draftSave) persistDraft(useStudioStore.getState().form, currentTabId());
}
let aiSettle: (() => void) | null = null;

function currentShot(): StudioShot | null {
  const s = useStudioStore.getState();
  return s.session.find((x) => x.id === s.currentId) || null;
}

function showShot(item: StudioShot | null) {
  const s = useStudioStore.getState();
  s.setCurrentId(item?.id || null);
  s.setLiveUrl(item && !item.pending ? item.url || item.thumbUrl : "");
}

function pendingId(jobId: string, sample: number) {
  return `pending:${jobId}:${sample}`;
}

function makePending(jobId: string, sample: number, width: number, height: number, meta: Record<string, unknown> = {}): StudioShot {
  return {
    id: pendingId(jobId, sample),
    url: "",
    thumbUrl: "",
    width,
    height,
    name: "生成中",
    meta,
    pending: true,
    jobId,
    sample,
  };
}

function ensurePending(job: Job) {
  const s = useStudioStore.getState();
  const n = Math.max(1, Math.min(4, Number(job.progress?.nSamples || s.form.nSamples || 1)));
  const existing = s.session.filter((shot) => shot.pending && shot.jobId === job.id);
  if (existing.length === n && Array.from({ length: n }, (_, i) => i).every((i) => existing.some((shot) => shot.sample === i))) return;
  // 增强 / 放大 / 图生图的目标尺寸由后端算好放在 progress 里，普通生图沿用表单尺寸。
  const w = Number(job.progress?.width) || s.form.width;
  const h = Number(job.progress?.height) || s.form.height;
  // 变体任务的占位要带上任务类型和原图，画布据此排成「原图 + 变体」网格。
  const kind = job.progress?.kind;
  const pendingMeta = kind && kind !== "generate" ? { requestType: kind, sourceHash: job.progress?.sourceHash || "" } : {};
  const slots = Array.from({ length: n }, (_, i) => {
    return existing.find((shot) => shot.sample === i) || makePending(job.id, i, w, h, pendingMeta);
  });
  const rest = s.session.filter((shot) => !(shot.pending && shot.jobId === job.id));
  s.setSession([...slots, ...rest]);
}

function paintPending(job: Job) {
  const url = job.previewUrl || "";
  if (!url || url.startsWith("data:")) return;
  const sample = Number(job.progress?.sample ?? 0);
  const s = useStudioStore.getState();
  const watching = s.session.some((shot) => shot.pending && shot.jobId === job.id && shot.sample === sample && shot.id === s.currentId);
  if (watching && s.liveUrl !== url) s.setLiveUrl(url);
}

function dropPending(jobId: string) {
  if (!jobId) return;
  const s = useStudioStore.getState();
  const pending = s.session.filter((shot) => shot.pending && shot.jobId === jobId);
  if (!pending.length) return;
  const watching = pending.some((shot) => shot.id === s.currentId);
  const rest = s.session.filter((shot) => !(shot.pending && shot.jobId === jobId));
  s.setSession(rest);
  if (watching) showShot(rest.find((shot) => !shot.pending) || null);
}

export function closeStudioMenus(keep?: StudioPop | "quota" | "jobs") {
  const s = useStudioStore.getState();
  if (keep === "quota" || keep === "jobs") s.closePops(keep);
  else s.closePops(keep);
  if (!keep) s.setOpenDd("");
}

export function placeStudioPop(trig: HTMLElement, preferUp = false) {
  const pop = document.querySelector("#view-studio .pop-panel.open") as HTMLElement | null;
  const s = useStudioStore.getState();
  const r = trig.getBoundingClientRect();
  const w = pop?.offsetWidth || 228;
  const h = pop?.offsetHeight || 120;
  s.setPopPos(placePop(r, w, h, preferUp, window.innerWidth, window.innerHeight));
}

/** 打开 Token 管理弹层。原先锚定在左侧面板顶部的账号按钮上，那个按钮已移除，改为在左栏底部就近弹出。 */
export function openTokenPop() {
  const dock = document.querySelector("#view-studio .gen-dock") as HTMLElement | null;
  if (dock) openStudioPop("token", dock, true);
}

export function openStudioPop(pop: NonNullable<StudioPop>, trig: HTMLElement, preferUp = false) {
  const s = useStudioStore.getState();
  const same = s.pop === pop;
  closeStudioMenus(pop);
  if (same) {
    s.openPop(null);
    return;
  }
  const r = trig.getBoundingClientRect();
  s.openPop(pop, { left: Math.round(r.left), top: Math.round(r.bottom + 6) }, preferUp);
  requestAnimationFrame(() => placeStudioPop(trig, preferUp));
}

function startBusy(job?: Job | null) {
  const s = useStudioStore.getState();
  const text = job?.progress?.text || (job?.status === "queued" ? "排队中" : "生成中");
  s.setBusy(true, job?.id || s.studioJobId, text);
}

function endBusy() {
  const s = useStudioStore.getState();
  s.setBusy(false, "", "");
}

function pushSessionItems(job: Job) {
  const s = useStudioStore.getState();
  const pending = s.session.filter((shot) => shot.pending && shot.jobId === job.id);
  const watch = pending.find((shot) => shot.id === s.currentId);
  const rest = s.session.filter((shot) => !(shot.pending && shot.jobId === job.id));
  const added: StudioShot[] = [];
  for (const item of job.items || []) {
    const rec = shotFromJobItem(item, job.meta || {});
    if (!rec || rest.some((shot) => shot.id === rec.id) || added.some((shot) => shot.id === rec.id)) continue;
    added.push({ ...rec, jobId: job.id, sample: added.length });
  }
  s.setSession([...added, ...rest]);
  if (!watch) return;
  const index = Math.min(watch.sample ?? 0, Math.max(0, added.length - 1));
  showShot(added[index] || added[0] || rest.find((shot) => !shot.pending) || null);
}

function applyStudioJob(job: Job) {
  if (job.source !== "studio") return;
  const s = useStudioStore.getState();
  if (jobIsActive(job)) {
    startBusy(job);
    return;
  }
  if (s.studioJobId && job.id !== s.studioJobId) return;
  if (!s.studioJobId && !notified.has(job.id)) return;
  if (notified.has(job.id)) return;
  notified.add(job.id);
  if (job.status === "done") {
    pushSessionItems(job);
    pushToast(`已生成 ${(job.items || []).length} 张`, "ok");
  } else if (job.status === "error") {
    dropPending(job.id);
    pushToast(job.error || "生图失败", "warn");
    if (/Token|401|未配置/.test(job.error || "")) openTokenPop();
  } else if (job.status === "cancelled") {
    dropPending(job.id);
    pushToast("已取消后台生图");
  }
}

export async function saveStudioCurrent(qc: ReturnType<typeof useQueryClient>, albumId: string, albums: Array<{ id: string; name: string }>) {
  const cur = currentShot();
  if (!cur) {
    pushToast("没有可保存的预览图", "warn");
    return;
  }
  if (cur.savedId) {
    pushToast("这张已经在图库里", "ok");
    closeStudioMenus();
    return;
  }
  const hash = cur.blobHash || cur.id;
  if (!hash) {
    pushToast("没有可保存的预览图", "warn");
    return;
  }
  const blocked = isSingleArtistAlbum(albums.find((a) => a.id === albumId))
    ? singleArtistImportError(
        (() => {
          const m = cur.meta as { artists?: unknown; prompt?: unknown };
          return Array.isArray(m.artists) && m.artists.length ? m.artists : extractArtists(String(m.prompt || "")).names;
        })(),
      )
    : null;
  if (blocked) {
    pushToast(blocked, "warn");
    return;
  }
  const tabId = currentTabId();
  closeStudioMenus();
  try {
    const saved = (await generationApi.promoteItems(albumId, [hash], {
      ...cur.meta,
      name: cur.name || "nai.png",
      source: "nai-v5",
    })) as Array<{ id?: string; albumId?: string }>;
    const rec = saved[0];
    if (rec?.id) {
      runInTab(tabId, () => {
        const s = useStudioStore.getState();
        s.setSession(s.session.map((x) => (x.id === cur.id ? { ...x, savedId: rec.id } : x)));
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
        qc.invalidateQueries({ queryKey: queryKeys.items(albumId) }),
      ]);
      const name = albums.find((a) => a.id === albumId)?.name;
      pushToast(name ? `已保存到「${name}」` : "已保存到收藏夹", "ok");
    }
  } catch (err) {
    pushToast(err instanceof ApiError && err.status === 409 ? "这张已经在图库里" : err instanceof Error ? err.message : "保存失败", "warn");
  }
}

export function useStudioSync() {
  const jobsQ = useJobsQuery();
  useEffect(() => {
    useStudioStore.getState().setImportOpts(loadImportOpts());
    const unsub = useStudioStore.subscribe((s, prev) => {
      if (s.form !== prev.form) {
        const text =
          s.form.prompt !== prev.form.prompt || s.form.uc !== prev.form.uc || s.form.characters !== prev.form.characters;
        window.clearTimeout(draftTimer);
        const save = () => saveDraft();
        const wait = getSettings().generation.draftDebounceMs;
        draftTimer = text ? window.setTimeout(save, Math.min(240, wait)) : window.setTimeout(save, wait);
      }
      if (s.currentSetId !== prev.currentSetId) persistSelectedSet(s.currentSetId);
    });
    return () => {
      unsub();
      window.clearTimeout(draftTimer);
    };
  }, []);

  useEffect(() => {
    const offOpen = on("generation.open", (payload) => {
      const item = payload as Artwork;
      const s = useStudioStore.getState();
      s.setForm(mergeStudioForm(s.form, formFromItem(item)));
      s.setDirecting(false);
      useSession.getState().setView("studio");
      saveDraft();
    });
    const offForm = on("generation.openForm", (payload) => {
      const form = payload as StudioForm;
      const s = useStudioStore.getState();
      s.setForm(mergeStudioForm(defaultForm(), form, { replace: true }));
      s.setDirecting(false);
      useSession.getState().setView("studio");
      saveDraft();
    });
    const offApply = on("generation.applyForm", (payload) => {
      const form = payload as StudioForm;
      const s = useStudioStore.getState();
      s.setForm(mergeStudioForm(defaultForm(), form, { replace: true }));
      saveDraft();
    });
    const offDrop = on("generation.drop", (payload) => {
      void openDroppedImages(payload as File[]);
    });
    const offDropShot = on("generation.dropShot", (payload) => {
      void openDroppedShot(payload as StudioShotDrag);
    });
    const offToken = on("generation.openToken", () => {
      useSession.getState().setView("studio");
      requestAnimationFrame(openTokenPop);
    });
    return () => {
      offOpen();
      offForm();
      offApply();
      offDrop();
      offDropShot();
      offToken();
    };
  }, []);

  useEffect(() => {
    const jobs = (jobsQ.data || []) as Job[];
    const studio = jobs.filter((j) => j.source === "studio");
    // 每个标签只处理自己提交的任务；没有归属的旧任务归第一个生图标签。
    const order = useTabs.getState().tabs.map((t) => t.id);
    const alive = new Set(useStudioStore.tabIds());
    alive.add(activeTab());
    const owners = order.filter((id) => alive.has(id));
    const assigned = assignJobsToTabs(studio, owners, owners[0] ?? activeTab());
    for (const [tabId, mine] of assigned) runInTab(tabId, () => syncTabJobs(mine));
  }, [jobsQ.data]);
}

/** 同步「当前标签」的生图任务（外面用 runInTab 指定标签）。 */
function syncTabJobs(studio: Job[]) {
  const active = studio.filter((j) => jobIsActive(j));
  const s = useStudioStore.getState();
  const current = (s.studioJobId && studio.find((j) => j.id === s.studioJobId)) || active[0];
  if (current && jobIsActive(current)) {
    startBusy(current);
    const hadSelection = Boolean(useStudioStore.getState().currentId);
    ensurePending(current);
    paintPending(current);
    if (!hadSelection) {
      const slot = useStudioStore.getState().session.find((shot) => shot.pending && shot.jobId === current.id && shot.sample === 0);
      if (slot) showShot(slot);
    }
  }
  for (const job of studio) {
    if (jobIsActive(job)) continue;
    applyStudioJob(job);
  }
  if (!active.length && s.busy && s.studioJobId) endBusy();
}

/** 工具栏和生图按钮共用的 Anlas 估算（后端按官方公式估算，以余额实际变化为准）。 */
export function useStudioEstimate() {
  const curW = useStudioStore((s) => s.session.find((x) => x.id === s.currentId)?.width || 0);
  const curH = useStudioStore((s) => s.session.find((x) => x.id === s.currentId)?.height || 0);
  const width = useStudioStore((s) => s.form.width);
  const height = useStudioStore((s) => s.form.height);
  const steps = useStudioStore((s) => s.form.steps);
  const model = useStudioStore((s) => s.form.model);
  const effort = useStudioStore((s) => s.form.effort);
  const nSamples = useStudioStore((s) => s.form.nSamples);
  const i2iStrength = useStudioStore((s) => (s.i2i ? (s.i2i.maskHash ? s.i2i.inpaintStrength : s.i2i.strength) : null));
  const enhance = useStudioStore((s) => s.enhance);
  const opus = Boolean(useNaiStatusQuery().data?.subscription?.opus);
  return useEstimateQuery({
    width: curW || width,
    height: curH || height,
    steps,
    model,
    effort,
    upscaleAmount: enhance.upscaleAmount,
    magnitude: enhance.magnitude,
    strength: enhance.advanced ? enhance.strength : null,
    noise: enhance.advanced ? enhance.noise : null,
    genWidth: width,
    genHeight: height,
    genSamples: nSamples,
    genStrength: i2iStrength,
    opus,
  }).data;
}

/** 动作不订阅 store：调用时再读最新状态和 query 缓存，引用在 qc 不变时保持稳定。 */
export function useStudioActions() {
  const qc = useQueryClient();
  return useMemo(() => {
    const store = new Proxy({} as StudioState, {
      get(_target, key: string) {
        return (useStudioStore.getState() as unknown as Record<string, unknown>)[key];
      },
    });
    const setsNow = () => (qc.getQueryData(queryKeys.paramSets) as ParamSet[] | undefined) || [];
    const albumsNow = () => ((qc.getQueryData(queryKeys.albums) as Album[] | undefined) || []).filter((a) => !isTestSetAlbum(a));

    function setSize(preset?: StudioForm["preset"], aspect?: StudioForm["aspect"], custom?: [number, number]) {
      const form = store.form;
    store.setForm(applySizeToForm(form, preset, aspect, custom));
  }

  function patch(patch: Partial<StudioForm>) {
    store.patchForm(patch);
  }

  function apply(data: Partial<StudioForm> & { artists?: string }, opts?: { replace?: boolean; mergeArtists?: boolean; mergeChars?: boolean }) {
    store.setForm(mergeStudioForm(store.form, data, opts));
  }

  function setCustom(on: boolean, edit = false) {
    store.patchForm({ useCoords: on });
    store.setDirecting(on && edit);
  }

  function addCharacter(g: GenderId) {
    const form = store.form;
    if (form.characters.length >= MAX_CHARS) {
      pushToast(`最多 ${MAX_CHARS} 个角色框`, "warn");
      return;
    }
    const next = [
      ...form.characters,
      defaultChar({
        gender: g,
        prompt: GENDER_PROMPT[g] || GENDER_PROMPT.f,
        x: GENDER_X[g] ?? 0.5,
        y: 0.48,
      }),
    ];
    store.patchForm({ characters: next });
    store.setActiveChar(next.length - 1);
  }

  function mutateChar(i: number, fn: (c: StudioForm["characters"][0]) => StudioForm["characters"][0] | null) {
    const form = store.form;
    const next = form.characters.map((c, idx) => (idx === i ? fn(c) : c)).filter((c): c is NonNullable<typeof c> => c != null);
    store.patchForm({ characters: next });
  }

  async function generate() {
    const form = store.form;
    if (store.busy) return;
    if (!form.prompt.trim() && form.quality === "off") {
      pushToast("先填主体 Prompt，或打开质量词", "warn");
      return;
    }
    saveDraft();
    // 有底图就走图生图；底图带蒙版就走局部重绘。
    const i2i = store.i2i;
    await submitStudioJob(i2i ? i2iJobPayload(form, i2i) : formToPayload(form));
  }

  /** 提交一个生图类任务（生图 / 图生图 / 局部重绘 / 增强 / 放大），结果落回提交它的标签。 */
  async function submitStudioJob(body: Record<string, unknown>) {
    // 提交是异步的，期间用户可能切到别的标签：结果要落回提交它的这个标签。
    const tabId = currentTabId();
    store.setBusy(true, "", "排队中");
    try {
      const job = await generationApi.submitJob({ ...body, source: "studio" });
      setJobTab(job.id, tabId);
      runInTab(tabId, () => {
        notified.delete(job.id);
        startBusy(job);
        ensurePending(job);
        const slot = useStudioStore.getState().session.find((shot) => shot.pending && shot.jobId === job.id && shot.sample === 0);
        if (slot) showShot(slot);
      });
      await qc.invalidateQueries({ queryKey: queryKeys.jobs });
    } catch (err) {
      runInTab(tabId, endBusy);
      const msg = err instanceof Error ? err.message : "生图失败";
      pushToast(msg, "warn");
      if (/Token|401|未配置/.test(msg) && tabId === activeTab()) openTokenPop();
    }
  }

  async function saveTo(id: string) {
    await saveStudioCurrent(qc, id, albumsNow());
  }

  async function downloadCurrent(kind: StudioDownloadKind = "original") {
    const current = currentShot();
    const src = current && !current.pending ? current.url || current.thumbUrl : "";
    if (!src) {
      pushToast("没有可下载的预览图", "warn");
      return;
    }
    closeStudioMenus();
    const seedRaw = current?.meta?.seed;
    const seed = typeof seedRaw === "number" ? seedRaw : Number(seedRaw);
    const filename = studioDownloadName(current?.name, current?.id || current?.blobHash, kind, Number.isFinite(seed) ? seed : null);
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error("无法读取图片");
      const raw = await res.blob();
      const blob = kind === "clean" ? await reencodePngClean(raw) : raw;
      triggerBlobDownload(blob, filename);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "下载失败", "warn");
    }
  }

  function deleteCurrent() {
    const current = currentShot();
    if (!current) {
      pushToast("没有可删除的预览", "warn");
      return;
    }
    const next = store.session.filter((x) => x.id !== current.id);
    store.setSession(next);
    showShot(next[0] || null);
  }

  function clearSession() {
    store.setSession([]);
    showShot(null);
  }

  function confirmPositions() {
    store.patchForm({ useCoords: true });
    store.setDirecting(false);
    pushToast("已固定角色位置", "ok");
  }

  function selectParamSet(id: string) {
    const sets = setsNow();
    const item = sets.find((x) => x.id === id);
    if (!item) return;
    store.setCurrentSetId(item.id);
    store.setForm(mergeStudioForm(defaultForm(), item.form, { replace: true }));
    closeStudioMenus();
  }

  async function updateParamSet() {
    const form = store.form;
    const currentSet = setsNow().find((x) => x.id === store.currentSetId) || null;
    if (!currentSet) {
      pushToast("请先选择预设", "warn");
      return;
    }
    await generationApi.updateParamSet(currentSet.id, cloneForm(form));
    await qc.invalidateQueries({ queryKey: queryKeys.paramSets });
    closeStudioMenus();
    pushToast("已更新预设", "ok");
  }

  async function saveParamSet(name: string) {
    const form = store.form;
    const sets = setsNow();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (sets.some((item) => item.name === trimmed)) {
      pushToast("已有同名预设", "warn");
      return;
    }
    const saved = await generationApi.saveParamSet(trimmed, cloneForm(form));
    store.setCurrentSetId(saved.id);
    store.setParamDialog(false);
    await qc.invalidateQueries({ queryKey: queryKeys.paramSets });
    pushToast("已保存预设", "ok");
  }

  async function deleteParamSet(id: string) {
    const sets = setsNow();
    const item = sets.find((x) => x.id === id);
    if (!item) return;
    if (!(await confirmDialog(`删除预设「${item.name}」？`, { title: "删除预设", confirmText: "删除" }))) return;
    await generationApi.deleteParamSet(id);
    if (store.currentSetId === id) store.setCurrentSetId("");
    await qc.invalidateQueries({ queryKey: queryKeys.paramSets });
    pushToast("已删除预设", "ok");
  }

  async function saveToken() {
    const token = store.tokenInput.trim();
    if (!token) {
      pushToast("请先粘贴 Token", "warn");
      return;
    }
    try {
      await generationApi.saveToken(token);
      store.setTokenInput("");
      closeStudioMenus();
      await qc.invalidateQueries({ queryKey: queryKeys.naiStatus });
      pushToast("Token 已保存", "ok");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Token 无效", "warn");
    }
  }

  async function clearToken() {
    await generationApi.clearToken();
    await qc.invalidateQueries({ queryKey: queryKeys.naiStatus });
    pushToast("已清除 Token");
  }

  function resetParams() {
    store.patchForm({
      steps: 28,
      scale: 5,
      seed: -1,
      cfgRescale: 0,
      noiseSchedule: "karras",
      sampler: "k_euler_ancestral",
    });
  }

  function setAiOpen(on: boolean) {
    store.setAiOpen(on);
    if (aiSettle) {
      aiSettle();
      aiSettle = null;
    }
    if (!on) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      store.setAiSettled(true);
      return;
    }
    const slot = document.querySelector("#view-studio .ai-panel-slot");
    const onEnd = (e: Event) => {
      const ev = e as TransitionEvent;
      if (ev.target !== slot || ev.propertyName !== "grid-template-rows") return;
      slot?.removeEventListener("transitionend", onEnd);
      aiSettle = null;
      store.setAiSettled(true);
    };
    slot?.addEventListener("transitionend", onEnd);
    const fallback = window.setTimeout(() => {
      slot?.removeEventListener("transitionend", onEnd);
      aiSettle = null;
      store.setAiSettled(true);
    }, 420);
    aiSettle = () => {
      window.clearTimeout(fallback);
      slot?.removeEventListener("transitionend", onEnd);
    };
  }

  function soon(msg = "扩图 / Director 暂未接入") {
    pushToast(msg, "warn");
  }

  /** 画布工具要作用在「当前这张已经生成完的图」上。 */
  function requireShot(): (StudioShot & { blobHash: string }) | null {
    const cur = currentShot();
    if (!cur || cur.pending || !cur.blobHash) {
      pushToast("先在画布里选一张已生成的图", "warn");
      return null;
    }
    return cur as StudioShot & { blobHash: string };
  }

  async function enhanceCurrent(opts?: EnhanceOpts) {
    if (store.busy) return;
    const cur = requireShot();
    if (!cur) return;
    closeStudioMenus();
    await submitStudioJob(enhanceJobPayload(formForShot(store.form, cur.meta), cur.blobHash, opts || store.enhance));
  }

  /** 增强细节：不放大，原尺寸再过一遍扩散模型。 */
  async function detailCurrent() {
    await enhanceCurrent({ ...store.enhance, upscaleAmount: "1x" });
  }

  async function upscaleCurrent() {
    if (store.busy) return;
    const cur = requireShot();
    if (!cur) return;
    closeStudioMenus();
    await submitStudioJob(upscaleJobPayload(cur.blobHash, 2, cur.meta || {}));
  }

  /** Generate Variations：当前这张图 img2img 出 3 张，连同原图排成 2x2。 */
  async function variationCurrent() {
    if (store.busy) return;
    const cur = requireShot();
    if (!cur) return;
    closeStudioMenus();
    await submitStudioJob(variationJobPayload(formForShot(store.form, cur.meta), cur.blobHash));
  }

  /** Use as Base Image：把当前图设为图生图底图，并展开左侧参考图区。 */
  function useAsBase() {
    if (store.busy) return;
    closeStudioMenus();
    if (setI2iFromShot()) pushToast("已设为底图，写好提示词后点生成", "ok");
  }

  function setI2iFromShot(shot?: StudioShot | null) {
    const cur = shot || requireShot();
    if (!cur?.blobHash) return false;
    store.setI2i(
      defaultI2iBase({
        hash: cur.blobHash,
        url: cur.url || cur.thumbUrl,
        width: cur.width || store.form.width,
        height: cur.height || store.form.height,
      }),
    );
    store.setI2iOpen(true);
    return true;
  }

  async function setI2iFromFile(file: File) {
    if (!isImageFile(file)) {
      pushToast("只能用图片作底图", "warn");
      return false;
    }
    try {
      const up = await generationApi.uploadBlob(file);
      store.setI2i(defaultI2iBase({ hash: up.blobHash, url: up.url, width: up.width || 0, height: up.height || 0 }));
      store.setI2iOpen(true);
      return true;
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "上传失败", "warn");
      return false;
    }
  }

  async function setI2iFromDropped() {
    const file = lastDropped;
    if (!file) {
      pushToast("没有可用的图片", "warn");
      return;
    }
    if (await setI2iFromFile(file)) {
      closeMetaDialog();
      pushToast("已设为图生图底图", "ok");
    }
  }

  function clearI2i() {
    store.setI2i(null);
  }

  /** 打开编辑器；没有底图时先拿当前预览图当底图。 */
  function openEditor(mode: EditorMode) {
    if (store.busy) return;
    if (!store.i2i && !setI2iFromShot()) return;
    closeStudioMenus();
    store.setEditor(mode);
  }

  /** 编辑器 Save & Close：画笔改过的图成为新底图，蒙版挂在底图上。 */
  async function saveEditor(result: { image?: Blob | null; mask?: Blob | null; clearMask?: boolean }) {
    const base = store.i2i;
    if (!base) return;
    try {
      let next: I2iBase = { ...base };
      if (result.image) {
        const up = await generationApi.uploadBlob(result.image);
        next = { ...next, hash: up.blobHash, url: up.url, width: up.width || next.width, height: up.height || next.height };
      }
      if (result.mask) {
        const up = await generationApi.uploadBlob(result.mask);
        next = { ...next, maskHash: up.blobHash, maskUrl: up.url };
      } else if (result.clearMask) {
        next = { ...next, maskHash: undefined, maskUrl: undefined };
      }
      store.setI2i(next);
      store.setEditor(null);
      pushToast(next.maskHash ? "蒙版已保存，写好提示词后点生成" : "底图已更新", "ok");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "保存失败", "warn");
    }
  }

  return {
    setSize,
    patch,
    apply,
    setCustom,
    addCharacter,
    mutateChar,
    generate,
    saveTo,
    downloadCurrent,
    deleteCurrent,
    clearSession,
    confirmPositions,
    selectParamSet,
    updateParamSet,
    saveParamSet,
    deleteParamSet,
    saveToken,
    clearToken,
    resetParams,
    setAiOpen,
    soon,
    enhanceCurrent,
    detailCurrent,
    upscaleCurrent,
    variationCurrent,
    useAsBase,
    setI2iFromShot,
    setI2iFromFile,
    setI2iFromDropped,
    clearI2i,
    openEditor,
    saveEditor,
    showShot,
    importMeta,
  };
  }, [qc]);
}

async function openDroppedShot(shot: StudioShotDrag) {
  const stored = useStudioStore.getState().session.find((item) => item.id === shot.id);
  const file = await fileFromShotRef({
    ...shot,
    url: shot.url || stored?.url,
    blobHash: shot.blobHash || stored?.blobHash,
    name: shot.name || stored?.name,
  });
  if (file) {
    await openDroppedImages([file], stored?.meta);
    return;
  }
  if (stored && hasImportableMeta(stored.meta)) {
    useSession.getState().setView("studio");
    const s = useStudioStore.getState();
    if (s.metaUrl) URL.revokeObjectURL(s.metaUrl);
    s.setImportOpts(loadImportOpts());
    s.setMeta({
      metaOpen: true,
      metaUrl: stored.url || stored.thumbUrl || "",
      metaForm: formFromMeta(stored.meta),
      metaStatus: "ok",
      metaError: "",
    });
    return;
  }
  pushToast("无法读取这张图", "warn");
}

async function openDroppedImages(files: File[], fallbackMeta?: Record<string, unknown>) {
  const images = [...(files || [])].filter((f) => isImageFile(f));
  if (!images.length) {
    pushToast("没有可读取的图片", "warn");
    return;
  }
  const file = images[0];
  lastDropped = file;
  if (images.length > 1) pushToast("已取第一张图", "ok");
  useSession.getState().setView("studio");
  const s = useStudioStore.getState();
  if (s.metaUrl) URL.revokeObjectURL(s.metaUrl);
  const url = URL.createObjectURL(file);
  s.setImportOpts(loadImportOpts());
  s.setMeta({ metaOpen: true, metaUrl: url, metaForm: null, metaStatus: "loading", metaError: "" });
  try {
    const meta = (await parseImageMeta(file)) as unknown as Record<string, unknown>;
    const parsedOk = hasImportableMeta(meta);
    const fallbackOk = !parsedOk && hasImportableMeta(fallbackMeta);
    const ok = parsedOk || fallbackOk;
    s.setMeta({
      metaForm: parsedOk ? formFromMeta(meta) : fallbackOk ? formFromMeta(fallbackMeta) : null,
      metaStatus: ok ? "ok" : "empty",
      metaError: ok ? "" : "这张图没有可识别的 NAI 参数。",
    });
  } catch (err) {
    if (hasImportableMeta(fallbackMeta)) {
      s.setMeta({
        metaForm: formFromMeta(fallbackMeta),
        metaStatus: "ok",
        metaError: "",
      });
      return;
    }
    s.setMeta({
      metaForm: null,
      metaStatus: "error",
      metaError: err instanceof Error ? err.message : "读取元数据失败",
    });
  }
}

function importMeta() {
  const s = useStudioStore.getState();
  const src = s.metaForm;
  const opts = s.importOpts;
  if (!src) {
    pushToast("没有可导入的参数", "warn");
    return;
  }
  persistImportOpts(opts);
  const pick = {
    prompt: opts.prompt,
    uc: opts.uc,
    chars: opts.chars,
    append: opts.append && opts.chars,
    settings: opts.settings,
    seed: opts.seed,
  };
  if (!pick.prompt && !pick.uc && !pick.chars && !pick.settings && !pick.seed) {
    pushToast("请至少勾选一项", "warn");
    return;
  }
  const data: Partial<StudioForm> = {};
  if (pick.prompt && src.prompt) data.prompt = opts.clean ? cleanPromptText(src.prompt) : src.prompt;
  if (pick.uc && src.uc != null) data.uc = src.uc;
  if (pick.chars) {
    const chars = Array.isArray(src.characters) ? src.characters : [];
    data.characters = opts.clean
      ? chars.map((c) => ({ ...c, prompt: cleanPromptText(c.prompt), uc: c.uc || "" }))
      : chars.map((c) => ({ ...c }));
  }
  if (pick.settings) {
    if (src.model) data.model = src.model;
    if (src.sampler) data.sampler = src.sampler;
    if (src.noiseSchedule) data.noiseSchedule = src.noiseSchedule;
    if (src.steps != null) data.steps = src.steps;
    if (src.scale != null) data.scale = src.scale;
    if (src.cfgRescale != null) data.cfgRescale = src.cfgRescale;
    if (src.width) data.width = src.width;
    if (src.height) data.height = src.height;
    if (src.v5Mode) data.v5Mode = src.v5Mode;
    if (src.useCoords != null) data.useCoords = src.useCoords;
    data.quality = "off";
  }
  if (pick.seed && src.seed != null && Number(src.seed) >= 0) data.seed = src.seed;
  s.setForm(mergeStudioForm(s.form, data, { mergeChars: pick.append }));
  closeMetaDialog();
  pushToast("已导入元数据", "ok");
}

export function closeMetaDialog() {
  const s = useStudioStore.getState();
  if (s.metaUrl) URL.revokeObjectURL(s.metaUrl);
  s.setMeta({ metaOpen: false, metaUrl: "", metaForm: null, metaStatus: "empty", metaError: "" });
}
