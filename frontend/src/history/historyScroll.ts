import { historyShots } from "@/data/history";
import type { Job } from "@/data/types";

type HistoryCache = { pages: { jobs: Job[]; nextBefore: number | null }[] };

function read(data: HistoryCache | undefined) {
  const pages = data?.pages ?? [];
  const jobs = pages.flatMap((page) => page.jobs);
  const last = pages[pages.length - 1];
  return {
    count: historyShots(jobs).length,
    raw: jobs.length,
    hasNext: Boolean(last && last.nextBefore != null),
  };
}

/**
 * 一直向后翻页，直到已加载的图不少于 target，或没有下一页。
 * 直接读 query 缓存，不依赖这一轮渲染是否已经跟上。
 * isCancelled 用来停掉过期的那一轮（页面已经卸掉，或严格模式重跑了效果）。
 */
export async function ensureHistoryLoaded(
  readCache: () => HistoryCache | undefined,
  target: number,
  fetchNext: () => Promise<unknown>,
  isCancelled: () => boolean = () => false,
) {
  for (let guard = 0; guard < 50; guard += 1) {
    if (isCancelled()) return;
    const { count, raw, hasNext } = read(readCache());
    if (count >= target || !hasNext) return;
    const before = raw;
    await fetchNext();
    if (isCancelled()) return;
    if (read(readCache()).raw <= before) return;
  }
}
