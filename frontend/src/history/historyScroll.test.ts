import { describe, expect, it, vi } from "vitest";
import type { Job } from "@/data/types";
import { ensureHistoryLoaded } from "./historyScroll";

function job(id: string): Job {
  return {
    id,
    source: "studio",
    status: "done",
    progress: {},
    items: [{ id: `${id}-0`, blobHash: "h", url: "/h", thumbUrl: "/t", width: 832, height: 1216 }],
    meta: {},
    createdAt: 1,
  };
}

function cache(pages: { jobs: Job[]; nextBefore: number | null }[]) {
  const data = { pages };
  return {
    data,
    getQueryData: () => data,
  };
}

describe("ensureHistoryLoaded", () => {
  it("已经够数时不再翻页", async () => {
    const qc = cache([{ jobs: [job("a")], nextBefore: 1 }]);
    const fetchNext = vi.fn();
    await ensureHistoryLoaded(() => qc.data, 1, fetchNext);
    expect(fetchNext).not.toHaveBeenCalled();
  });

  it("翻到上次的张数就停", async () => {
    const qc = cache([{ jobs: [job("a")], nextBefore: 2 }]);
    const fetchNext = vi.fn(async () => {
      qc.data.pages.push({ jobs: [job(`p${qc.data.pages.length}`)], nextBefore: qc.data.pages.length < 3 ? 1 : null });
    });
    await ensureHistoryLoaded(() => qc.data, 3, fetchNext);
    expect(fetchNext).toHaveBeenCalledTimes(2);
    expect(qc.data.pages).toHaveLength(3);
  });

  it("没有下一页时停，即使还没到目标张数", async () => {
    const qc = cache([{ jobs: [job("a")], nextBefore: null }]);
    const fetchNext = vi.fn();
    await ensureHistoryLoaded(() => qc.data, 10, fetchNext);
    expect(fetchNext).not.toHaveBeenCalled();
  });

  it("取消后不再继续翻页", async () => {
    const qc = cache([{ jobs: [job("a")], nextBefore: 1 }]);
    let stop = false;
    const fetchNext = vi.fn(async () => {
      qc.data.pages.push({ jobs: [job(`p${qc.data.pages.length}`)], nextBefore: 1 });
      stop = true;
    });
    await ensureHistoryLoaded(() => qc.data, 5, fetchNext, () => stop);
    expect(fetchNext).toHaveBeenCalledTimes(1);
  });

  it("翻页没有带来新图时停，避免空转", async () => {
    const qc = cache([{ jobs: [job("a")], nextBefore: 1 }]);
    const fetchNext = vi.fn(async () => {});
    await ensureHistoryLoaded(() => qc.data, 5, fetchNext);
    expect(fetchNext).toHaveBeenCalledTimes(1);
  });
});
