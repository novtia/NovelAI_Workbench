import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, galleryApi, generationApi } from "@/api";
import {
  buildSkinLayout,
  buildTestTargets,
  formToPayload,
  isSingleArtistAlbum,
  jobIsActive,
  missingTargets,
  queryKeys,
} from "@/data";
import type { Job, ParamSet, StudioForm } from "@/data/types";
import type { TestTarget } from "@/data/testRun";
import { useCollection } from "./collection";
import { useJobsQuery, useParamSetsQuery } from "./queries";
import { useSession } from "./session";
import { confirmDialog } from "./confirm";
import { pushToast } from "./toast";
import { useTestRunStore } from "./testRunStore";

/** 用户点了取消的测试集：排队循环下一轮就会停。 */
const stopped = new Set<string>();

const pad = (n: number) => String(n).padStart(2, "0");

function stamp(withSeconds: boolean) {
  const d = new Date();
  const base = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

/** 和抽奖 buildPayload 一致：预设表单 + 画师串放最前，每位画师 1 张。 */
function buildPayload(preset: ParamSet, target: TestTarget, testSetId: string) {
  const form: StudioForm = {
    ...preset.form,
    nSamples: 1,
    characters: (preset.form.characters || []).map((c) => ({ ...c })),
  };
  const hasChar = (form.characters || []).some((c) => String(c.prompt || "").trim());
  if (!hasChar) form.characters = [{ prompt: "girl, solo", uc: "", x: 0.5, y: 0.5 }];
  return {
    ...formToPayload(form, { artists: target.artistLine, source: "gallery" }),
    source: "gallery",
    client: {
      testSetId,
      testIndex: target.index,
      artist: target.name,
      artists: [target.name],
      artistLine: target.artistLine,
      form,
    },
  };
}

export function useTestRun() {
  const qc = useQueryClient();
  const { album, testSets, testSet, testSetId, baseItems, baseFiltered, skinItems, query } = useCollection();
  const setsQ = useParamSetsQuery();
  const jobsQ = useJobsQuery();
  const runs = useTestRunStore((s) => s.runs);
  const storedPresetId = useSession((s) => s.testPresetId);
  const submitting = useTestRunStore((s) => s.submitting);
  const sets = setsQ.data || [];
  const jobs = jobsQ.data || [];
  const presetId = sets.some((s) => s.id === storedPresetId) ? storedPresetId : sets[0]?.id || "";
  const preset = sets.find((s) => s.id === presetId) || null;
  const run = testSetId ? runs[testSetId] || null : null;
  const isSubmitting = Boolean(testSetId) && submitting === testSetId;
  // 继续生成沿用这个测试集当初用的预设；记录丢了就用当前选中的预设。
  const runPreset = (run && sets.find((s) => s.id === run.presetId)) || preset;

  // 进度按整个默认集算；网格显示按搜索过滤后的默认集算。两者无搜索时是同一份。
  const fullLayout = useMemo(
    () => buildSkinLayout(baseItems, skinItems, jobs, testSetId, isSubmitting),
    [baseItems, skinItems, jobs, testSetId, isSubmitting],
  );
  const layout = useMemo(
    () => (query.trim() ? buildSkinLayout(baseFiltered, skinItems, jobs, testSetId, isSubmitting) : fullLayout),
    [query, baseFiltered, skinItems, jobs, testSetId, isSubmitting, fullLayout],
  );
  const progress = testSet ? fullLayout.progress : null;
  const running = Boolean(progress && progress.pending > 0) || isSubmitting;
  const canResume = Boolean(testSet) && !running && Boolean(progress && progress.missing > 0);

  async function cancelActive(id: string, list: Job[]) {
    const pending = list.filter((j) => j.source === "gallery" && String(j.client?.testSetId || "") === id && jobIsActive(j));
    await Promise.allSettled(pending.map((j) => generationApi.cancelJob(j.id)));
  }

  async function createRunSet(preset: ParamSet) {
    const base = `${preset.name} · `;
    try {
      return await galleryApi.createTestSet(`${base}${stamp(false)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return galleryApi.createTestSet(`${base}${stamp(true)}`);
      throw err;
    }
  }

  function presetReady(p: ParamSet | null): p is ParamSet {
    if (!p) {
      pushToast("请先选择生图预设", "warn");
      return false;
    }
    if (!String(p.form.prompt || "").trim() && p.form.quality === "off") {
      pushToast("先填主体 Prompt，或打开质量词", "warn");
      return false;
    }
    return true;
  }

  /** 按顺序把这些画师逐个排进队；图生成完成后由后端自动存进测试集。 */
  async function submitAll(p: ParamSet, targets: TestTarget[], id: string) {
    let n = 0;
    try {
      for (const target of targets) {
        if (stopped.has(id)) break;
        try {
          await generationApi.submitJob(buildPayload(p, target, id));
          n += 1;
        } catch (err) {
          pushToast(err instanceof Error ? err.message : "排队失败", "error");
          break;
        }
      }
    } finally {
      useTestRunStore.getState().setSubmitting("");
      await qc.invalidateQueries({ queryKey: queryKeys.jobs });
    }
    if (n) pushToast(`已在后台排队 ${n} 张，切换页面不会中断`, "ok");
  }

  /** 新建以预设命名的测试集，从默认集排序第一位开始给每位画师生成皮肤。 */
  async function start() {
    const store = useTestRunStore.getState();
    if (store.submitting) {
      pushToast("上一轮还在排队，请稍候", "warn");
      return;
    }
    if (!isSingleArtistAlbum(album)) return;
    if (!presetReady(preset)) return;
    const targets = buildTestTargets(baseItems);
    if (!targets.length) {
      pushToast("「单画师」图库里没有可生图的画师", "warn");
      return;
    }
    const ok = await confirmDialog(
      `将新建测试集，按图库顺序为 ${targets.length} 位画师各生成 1 张皮肤图（会消耗点数）。未生成完的画师继续显示默认图。继续？`,
      { title: "生成测试集", confirmText: "开始生成" },
    );
    if (!ok) return;

    store.setSubmitting("_creating");
    let set;
    try {
      set = await createRunSet(preset);
    } catch (err) {
      store.setSubmitting("");
      pushToast(err instanceof Error ? err.message : "创建测试集失败", "error");
      return;
    }
    const id = set.id;
    stopped.delete(id);
    store.addRun({ testSetId: id, presetId: preset.id, createdAt: Date.now() });
    store.setSubmitting(id);
    await qc.invalidateQueries({ queryKey: queryKeys.albums });
    const session = useSession.getState();
    session.setQuery("");
    session.setTestSetId(id);
    await submitAll(preset, targets, id);
  }

  /** 停止后继续：只给当前测试集里还没有皮肤的画师生成，不新建测试集。 */
  async function resume() {
    const store = useTestRunStore.getState();
    if (store.submitting) {
      pushToast("上一轮还在排队，请稍候", "warn");
      return;
    }
    if (!testSet || !presetReady(runPreset)) return;
    const targets = missingTargets(baseItems, skinItems);
    if (!targets.length) {
      pushToast("这个测试集已经全部生成完了", "ok");
      return;
    }
    const ok = await confirmDialog(`继续为剩下 ${targets.length} 位画师生成皮肤图（会消耗点数），用预设「${runPreset.name}」。继续？`, {
      title: "继续生成",
      confirmText: "继续",
    });
    if (!ok) return;
    const id = testSet.id;
    stopped.delete(id);
    if (!run) store.addRun({ testSetId: id, presetId: runPreset.id, createdAt: Date.now() });
    store.setSubmitting(id);
    await submitAll(runPreset, targets, id);
  }

  async function cancel() {
    if (!testSetId) return;
    stopped.add(testSetId);
    await cancelActive(testSetId, jobs);
    await qc.invalidateQueries({ queryKey: queryKeys.jobs });
    pushToast("已停止，可以随时点「继续」补齐剩下的画师", "ok");
  }

  function selectTestSet(id: string) {
    useSession.getState().setTestSetId(id);
  }

  function renameTestSet() {
    if (!testSet) return;
    useSession.getState().openRenameDialog(testSet.id, testSet.name);
  }

  async function deleteTestSet() {
    if (!testSet) return;
    const n = testSet.count ?? 0;
    const msg = n ? `删除测试集「${testSet.name}」以及其中 ${n} 张图片？` : `删除测试集「${testSet.name}」？`;
    if (!(await confirmDialog(msg, { title: "删除测试集", confirmText: "删除" }))) return;
    const id = testSet.id;
    try {
      stopped.add(id);
      await cancelActive(id, jobs);
      await galleryApi.deleteAlbum(id);
      useTestRunStore.getState().removeRun(id);
      useSession.getState().setTestSetId("");
      await qc.invalidateQueries({ queryKey: queryKeys.albums });
      pushToast("已删除测试集", "ok");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "删除失败", "error");
    }
  }

  return {
    testSets,
    testSet,
    testSetId,
    sets,
    presetId,
    preset,
    setPresetId: useSession.getState().setTestPresetId,
    run,
    layout,
    progress,
    running,
    canResume,
    submitting: isSubmitting,
    start,
    resume,
    cancel,
    selectTestSet,
    renameTestSet,
    deleteTestSet,
  };
}

