import { artistText } from "./artwork";
import { tagKey } from "./hashKey";
import { splitSingleArtistSections } from "./singleArtist";
import type { Artwork, Job } from "./types";

/** 测试集生图里的一位画师：按默认集显示顺序编号，从 0 开始。 */
export type TestTarget = { index: number; key: string; name: string; artistLine: string };

export type TestCardState = "done" | "running" | "queued" | "error" | "cancelled";

/** 测试集里还没出最终图的位置：排队 / 流式预览 / 失败。 */
export type TestCard = {
  key: string;
  target: TestTarget | null;
  item: Artwork | null;
  job: Job | null;
  state: TestCardState;
};

function firstArtist(item: Pick<Artwork, "artists">) {
  return String((item.artists || [])[0] || "").trim();
}

/** 默认集当前显示顺序（先单张、后多图分组）里，按画师去重后的每位画师，从第一位开始。 */
export function buildTestTargets(items: Artwork[]): TestTarget[] {
  const sections = splitSingleArtistSections(items);
  const ordered = [...sections.shared, ...sections.extras.flatMap((group) => group.items)];
  const seen = new Set<string>();
  const out: TestTarget[] = [];
  for (const item of ordered) {
    const name = firstArtist(item);
    const key = tagKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ index: out.length, key, name, artistLine: artistText(item) });
  }
  return out;
}

/** 任务对应的画师 key：测试图任务的 client.artists[0]。按画师而不是序号匹配，默认集增删画师后也不会错位。 */
export function testJobKey(job?: Job | null) {
  const client = job?.client || {};
  const artists = Array.isArray(client.artists) ? client.artists : [];
  return tagKey(String(artists[0] || client.artist || ""));
}

/** 该测试集里某位画师最近的任务：进行中的优先，否则取最后一个。 */
function pickJob(jobs: Job[], testSetId: string, key: string): Job | null {
  const hits = jobs.filter(
    (j) => j.source === "gallery" && String(j.client?.testSetId || "") === testSetId && testJobKey(j) === key,
  );
  if (!hits.length) return null;
  return hits.find((j) => j.status === "queued" || j.status === "running") || hits[hits.length - 1];
}

/** 测试集里每位画师最多一张皮肤图：同一画师有多张时取最新的。 */
export function indexSkins(skinItems: Artwork[]) {
  const map = new Map<string, Artwork>();
  for (const item of skinItems) {
    const key = tagKey(firstArtist(item));
    if (!key) continue;
    const cur = map.get(key);
    if (!cur || item.addedAt > cur.addedAt || (item.addedAt === cur.addedAt && item.id > cur.id)) map.set(key, item);
  }
  return map;
}

/** 默认集里还没有皮肤的画师，按默认集顺序，供「继续」使用。 */
export function missingTargets(baseItems: Artwork[], skinItems: Artwork[]): TestTarget[] {
  const skins = indexSkins(skinItems);
  return buildTestTargets(baseItems)
    .filter((t) => !skins.has(t.key))
    .map((t, index) => ({ ...t, index }));
}

/** 网格里的一格：默认图始终在，皮肤图有就盖上去，生成中就换成占位。 */
export type SkinSlot = {
  key: string;
  base: Artwork;
  skin: Artwork | null;
  /** 这位画师在默认集里的代表位置才有 target（皮肤只落在这里）。 */
  target: TestTarget | null;
  /** 排队 / 流式 / 失败时不为空，网格用它渲染占位卡。 */
  pending: TestCard | null;
};

export type SkinGroup = { key: string; name: string; slots: SkinSlot[] };
export type SkinLayout = { shared: SkinSlot[]; extras: SkinGroup[]; progress: SkinProgress };
export type SkinProgress = { total: number; done: number; failed: number; pending: number; missing: number; finished: boolean };

function pendingState(job: Job | null, submitting: boolean): TestCardState | null {
  if (!job) return submitting ? "queued" : null;
  if (job.status === "running" || job.status === "done") return "running";
  if (job.status === "queued") return "queued";
  // 正在（重新）排队时，上一轮的失败 / 取消记录已经作废，等新任务。
  if (submitting) return "queued";
  if (job.status === "error") return "error";
  // 已取消：位置回退到默认图
  return null;
}

/**
 * 皮肤布局：网格结构（单张在前、多图画师分组在后）完全取自默认集，测试集只按画师覆盖图片。
 * 没有皮肤、也没在生成的画师继续显示默认图；多图分组里皮肤只替换该分组的第一张。
 */
export function buildSkinLayout(
  baseItems: Artwork[],
  skinItems: Artwork[],
  jobs: Job[],
  testSetId: string,
  submitting = false,
): SkinLayout {
  const sections = splitSingleArtistSections(baseItems);
  const targets = new Map(buildTestTargets(baseItems).map((t) => [t.key, t]));
  const skins = indexSkins(skinItems);
  const stats = { total: 0, done: 0, failed: 0, pending: 0 };
  const used = new Set<string>();

  function slot(item: Artwork, isFirstOfArtist: boolean): SkinSlot {
    const key = tagKey(firstArtist(item));
    const target = key && isFirstOfArtist && !used.has(key) ? targets.get(key) || null : null;
    if (!target) return { key: item.id, base: item, skin: null, target: null, pending: null };
    used.add(key);
    stats.total += 1;
    const skin = skins.get(key) || null;
    if (skin) {
      stats.done += 1;
      return { key: item.id, base: item, skin, target, pending: null };
    }
    if (!testSetId) return { key: item.id, base: item, skin: null, target, pending: null };
    const job = pickJob(jobs, testSetId, key);
    const state = pendingState(job, submitting);
    if (!state) return { key: item.id, base: item, skin: null, target, pending: null };
    if (state === "error") stats.failed += 1;
    else stats.pending += 1;
    return { key: item.id, base: item, skin: null, target, pending: { key: `t${target.index}-${key}`, target, item: null, job, state } };
  }

  const shared = sections.shared.map((item) => slot(item, true));
  const extras = sections.extras.map((group) => ({
    key: group.key,
    name: group.name,
    slots: group.items.map((item, i) => slot(item, i === 0)),
  }));
  const missing = stats.total - stats.done;
  return {
    shared,
    extras,
    progress: { ...stats, missing, finished: stats.total > 0 && stats.pending === 0 },
  };
}
