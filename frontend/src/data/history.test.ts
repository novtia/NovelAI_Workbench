import { describe, expect, it } from "vitest";
import { dayLabel, groupByDay, historyShots } from "./history";
import type { Job } from "./types";

const now = new Date(2026, 9, 13, 18, 30).getTime();

function at(year: number, month: number, day: number, hour = 12) {
  return new Date(year, month - 1, day, hour, 5).getTime();
}

function job(id: string, createdAt: number, n = 1, source = "studio", status = "done"): Job {
  return {
    id,
    source,
    status,
    progress: {},
    items: Array.from({ length: n }, (_, i) => ({
      id: `${id}-${i}`,
      blobHash: `h${i}`,
      url: `/api/blobs/h${i}`,
      thumbUrl: `/api/blobs/t${i}`,
      width: 832,
      height: 1216,
    })),
    meta: { prompt: "1girl", width: 832, height: 1216 },
    createdAt,
  };
}

describe("history days", () => {
  it("labels today, yesterday, this year, and other years", () => {
    expect(dayLabel(at(2026, 10, 13, 1), now)).toBe("今天");
    expect(dayLabel(at(2026, 10, 12, 23), now)).toBe("昨天");
    expect(dayLabel(at(2026, 3, 2), now)).toBe("3月2日");
    expect(dayLabel(at(2025, 12, 31), now)).toBe("2025年12月31日");
  });

  it("keeps one card per image and groups by local day, newest first", () => {
    const shots = historyShots([
      job("old", at(2025, 12, 31)),
      job("lot", at(2026, 10, 13), 1, "lottery"),
      job("queued", at(2026, 10, 13), 1, "studio", "queued"),
      job("today", at(2026, 10, 13, 9), 2),
      job("empty", at(2026, 10, 13, 8), 0),
      job("y", at(2026, 10, 12, 20)),
    ]);
    const days = groupByDay(shots, now);
    expect(days.map((d) => d.label)).toEqual(["今天", "昨天", "2025年12月31日"]);
    expect(days[0].shots.map((s) => s.key)).toEqual(["today:0", "today:1"]);
    expect(days[0].shots[0].total).toBe(2);
    expect(days[1].shots).toHaveLength(1);
    expect(days.map((d) => d.shots.length)).toEqual([2, 1, 1]);
    expect(shots.some((s) => s.jobId === "lot" || s.jobId === "queued" || s.jobId === "empty")).toBe(false);
  });
});
