import { useEffect } from "react";
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
  previewUrl,
  queryKeys,
  reencodePngClean,
  shotFromJobItem,
  studioDownloadName,
  triggerBlobDownload,
  fileFromShotRef,
} from "@/data";
import type { Artwork, GenderId, Job, StudioDownloadKind, StudioForm, StudioPop, StudioShot } from "@/data/types";
import type { StudioShotDrag } from "@/data/files";
import { isImageFile, parseImageMeta } from "@/data/png";
import { on } from "./bus";
import { useCollection } from "./collection";
import { useJobsQuery, useNaiStatusQuery, useParamSetsQuery } from "./queries";
import { useLotteryStore } from "./lotteryStore";
import { useSession } from "./session";
import { useStudioStore } from "./studioStore";
import { pushToast } from "./toast";

const notified = new Set<string>();
let draftTimer = 0;
let aiSettle: (() => void) | null = null;

function currentShot(): StudioShot | null {
  const s = useStudioStore.getState();
  return s.session.find((x) => x.id === s.currentId) || null;
}

function showShot(item: StudioShot | null) {
  const s = useStudioStore.getState();
  s.setCurrentId(item?.id || null);
  s.setLiveUrl(item ? item.url || item.thumbUrl : "");
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
  const live = job?.previewUrl || "";
  if (live) s.setLiveUrl(live);
}

function endBusy() {
  const s = useStudioStore.getState();
  s.setBusy(false, "", "");
}

function pushSessionItems(items: Job["items"], meta: Record<string, unknown>) {
  const s = useStudioStore.getState();
  const added: StudioShot[] = [];
  const next = [...s.session];
  for (const item of items || []) {
    const rec = shotFromJobItem(item, meta);
    if (!rec || next.some((x) => x.id === rec.id)) continue;
    next.unshift(rec);
    added.push(rec);
  }
  if (!added.length) return;
  s.setSession(next);
  showShot(next[0]);
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
    pushSessionItems(job.items, job.meta || {});
    pushToast(`已生成 ${(job.items || []).length} 张`, "ok");
  } else if (job.status === "error") {
    pushToast(job.error || "生图失败", "warn");
    if (/Token|401|未配置/.test(job.error || "")) {
      const trig = document.getElementById("st-account");
      if (trig) openStudioPop("token", trig);
    }
  } else if (job.status === "cancelled") {
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
  closeStudioMenus();
  try {
    const saved = (await generationApi.promoteItems(albumId, [hash], {
      ...cur.meta,
      name: cur.name || "nai.png",
      source: "nai-v5",
    })) as Array<{ id?: string; albumId?: string }>;
    const rec = saved[0];
    if (rec?.id) {
      const s = useStudioStore.getState();
      s.setSession(s.session.map((x) => (x.id === cur.id ? { ...x, savedId: rec.id } : x)));
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
        qc.invalidateQueries({ queryKey: queryKeys.itemsRoot }),
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
        window.clearTimeout(draftTimer);
        draftTimer = window.setTimeout(() => persistDraft(s.form), 240);
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
      persistDraft(useStudioStore.getState().form);
    });
    const offForm = on("generation.openForm", (payload) => {
      const form = payload as StudioForm;
      const s = useStudioStore.getState();
      s.setForm(mergeStudioForm(defaultForm(), form, { replace: true }));
      s.setDirecting(false);
      useSession.getState().setView("studio");
      persistDraft(useStudioStore.getState().form);
    });
    const offApply = on("generation.applyForm", (payload) => {
      const form = payload as StudioForm;
      const s = useStudioStore.getState();
      s.setForm(mergeStudioForm(defaultForm(), form, { replace: true }));
      persistDraft(useStudioStore.getState().form);
    });
    const offDrop = on("generation.drop", (payload) => {
      void openDroppedImages(payload as File[]);
    });
    const offDropShot = on("generation.dropShot", (payload) => {
      void openDroppedShot(payload as StudioShotDrag);
    });
    const offToken = on("generation.openToken", () => {
      useSession.getState().setView("studio");
      requestAnimationFrame(() => {
        const trig = document.getElementById("st-account");
        if (trig) openStudioPop("token", trig);
      });
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
    const active = studio.filter((j) => jobIsActive(j));
    const s = useStudioStore.getState();
    const current = (s.studioJobId && studio.find((j) => j.id === s.studioJobId)) || active[0];
    if (current && jobIsActive(current)) {
      startBusy(current);
      if (current.previewUrl) s.setLiveUrl(current.previewUrl);
    }
    for (const job of studio) {
      if (jobIsActive(job)) continue;
      applyStudioJob(job);
    }
    if (!active.length && s.busy) endBusy();
  }, [jobsQ.data]);
}

export function useStudio() {
  const store = useStudioStore();
  const qc = useQueryClient();
  const statusQ = useNaiStatusQuery();
  const setsQ = useParamSetsQuery();
  const { albums, albumId } = useCollection();
  const form = store.form;
  const current = store.session.find((x) => x.id === store.currentId) || null;
  const sets = setsQ.data || [];
  const currentSet = sets.find((x) => x.id === store.currentSetId) || null;
  const status = statusQ.data || null;

  function setSize(preset?: StudioForm["preset"], aspect?: StudioForm["aspect"], custom?: [number, number]) {
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

  function mutateChar(i: number, fn: (c: (typeof form.characters)[0]) => (typeof form.characters)[0] | null) {
    const next = form.characters.map((c, idx) => (idx === i ? fn(c) : c)).filter((c): c is NonNullable<typeof c> => c != null);
    store.patchForm({ characters: next });
  }

  async function generate() {
    if (store.busy) return;
    if (!form.prompt.trim() && form.quality === "off") {
      pushToast("先填主体 Prompt，或打开质量词", "warn");
      return;
    }
    persistDraft(form);
    store.setBusy(true, "", "排队中");
    try {
      const job = await generationApi.submitJob({ ...formToPayload(form), source: "studio" });
      notified.delete(job.id);
      startBusy(job);
      await qc.invalidateQueries({ queryKey: queryKeys.jobs });
    } catch (err) {
      endBusy();
      const msg = err instanceof Error ? err.message : "生图失败";
      pushToast(msg, "warn");
      if (/Token|401|未配置/.test(msg)) {
        const trig = document.getElementById("st-account");
        if (trig) openStudioPop("token", trig);
      }
    }
  }

  async function saveTo(id: string) {
    await saveStudioCurrent(qc, id, albums);
  }

  async function downloadCurrent(kind: StudioDownloadKind = "original") {
    const src = current ? previewUrl(current) : store.liveUrl;
    if (!src) {
      pushToast("没有可下载的预览图", "warn");
      return;
    }
    closeStudioMenus();
    const filename = studioDownloadName(current?.name, current?.id || undefined, kind);
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
    const item = sets.find((x) => x.id === id);
    if (!item) return;
    store.setCurrentSetId(item.id);
    store.setForm(mergeStudioForm(defaultForm(), item.form, { replace: true }));
    useLotteryStore.getState().setPresetId(item.id);
    closeStudioMenus();
  }

  async function updateParamSet() {
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
    const trimmed = name.trim();
    if (!trimmed) return;
    if (sets.some((item) => item.name === trimmed)) {
      pushToast("已有同名预设", "warn");
      return;
    }
    const saved = await generationApi.saveParamSet(trimmed, cloneForm(form));
    store.setCurrentSetId(saved.id);
    useLotteryStore.getState().setPresetId(saved.id);
    store.setParamDialog(false);
    await qc.invalidateQueries({ queryKey: queryKeys.paramSets });
    pushToast("已保存预设", "ok");
  }

  async function deleteParamSet(id: string) {
    const item = sets.find((x) => x.id === id);
    if (!item) return;
    if (!confirm(`删除预设「${item.name}」？`)) return;
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

  function soon(msg = "第二波接入：增强 / 4x / 重绘 / 扩图 / Director") {
    pushToast(msg, "warn");
  }

  return {
    ...store,
    form,
    current,
    currentSet,
    sets,
    albums,
    albumId,
    status,
    sizeLabel: `${form.width} × ${form.height}`,
    previewUrl: store.liveUrl,
    hasPreview: Boolean(store.liveUrl),
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
    showShot,
    importMeta,
  };
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
