import type { Job } from "./types";

/** 历史页里的一张图。一个任务出多张时，每张各占一条。 */
export type HistoryShot = {
  key: string;
  jobId: string;
  /** 图在任务里的 id（后端按它定位要删的图）。 */
  itemId: string;
  index: number;
  total: number;
  createdAt: number;
  url: string;
  thumbUrl: string;
  width: number | null;
  height: number | null;
  blobHash: string;
  meta: Record<string, unknown>;
  prompt: string;
};

export type HistoryDay = {
  key: string;
  label: string;
  shots: HistoryShot[];
};

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 只留生图室里已经出图的结果，并按时间倒序排好。 */
export function historyShots(jobs: Job[]): HistoryShot[] {
  const shots: HistoryShot[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    if (job.source !== "studio" || job.status !== "done") continue;
    const items = job.items || [];
    items.forEach((item, index) => {
      const blobHash = String(item.blobHash || "");
      const url = item.url || (blobHash ? `/api/blobs/${blobHash}` : "");
      const thumbUrl = item.thumbUrl || url;
      if (!url && !thumbUrl) return;
      const key = `${job.id}:${index}`;
      if (seen.has(key)) return;
      seen.add(key);
      const meta = job.meta || {};
      shots.push({
        key,
        jobId: job.id,
        itemId: String(item.id || blobHash.slice(0, 32)),
        index,
        total: items.length,
        createdAt: job.createdAt,
        url: url || thumbUrl,
        thumbUrl,
        width: num(item.width) ?? num(meta.width),
        height: num(item.height) ?? num(meta.height),
        blobHash,
        meta,
        prompt: String(meta.prompt || ""),
      });
    });
  }
  shots.sort((a, b) => b.createdAt - a.createdAt || b.jobId.localeCompare(a.jobId) || a.index - b.index);
  return shots;
}

function ymd(ts: number) {
  const d = new Date(ts);
  return [d.getFullYear(), d.getMonth(), d.getDate()] as const;
}

function dayKey(ts: number) {
  const [y, m, d] = ymd(ts);
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 本地日历上相差的整天数（不受夏令时影响）。 */
function dayDiff(ts: number, now: number) {
  const [y1, m1, d1] = ymd(ts);
  const [y2, m2, d2] = ymd(now);
  return Math.round((Date.UTC(y2, m2, d2) - Date.UTC(y1, m1, d1)) / 86_400_000);
}

export function dayLabel(ts: number, now = Date.now()) {
  const diff = dayDiff(ts, now);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  const d = new Date(ts);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 要求 shots 已经按时间倒序。同一天合成一段，标题用今天 / 昨天 / 月日。 */
export function groupByDay(shots: HistoryShot[], now = Date.now()): HistoryDay[] {
  const groups: HistoryDay[] = [];
  for (const shot of shots) {
    const key = dayKey(shot.createdAt);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.shots.push(shot);
    else groups.push({ key, label: dayLabel(shot.createdAt, now), shots: [shot] });
  }
  return groups;
}
