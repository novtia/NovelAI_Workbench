import { describe, expect, it } from "vitest";
import type { HistoryShot } from "./history";
import {
  collectHistorySamplers,
  countActiveHistoryFilters,
  describeHistoryFilters,
  EMPTY_HISTORY_FILTER,
  filterHistoryShots,
  hasActiveHistoryFilter,
  type HistoryFilter,
} from "./historyFilter";

const now = new Date(2026, 10, 14, 15, 0, 0).getTime(); // 2026-11-14

function at(year: number, month: number, day: number, hour = 12) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}

function shot(id: string, overrides: Partial<HistoryShot> = {}): HistoryShot {
  return {
    key: `${id}:0`,
    jobId: id,
    itemId: `${id}-0`,
    index: 0,
    total: 1,
    createdAt: now,
    url: `/api/blobs/${id}`,
    thumbUrl: `/api/blobs/t-${id}`,
    width: 832,
    height: 1216,
    blobHash: `hash-${id}`,
    prompt: "1girl, blue eyes",
    meta: {
      prompt: "1girl, blue eyes",
      uc: "lowres",
      model: "nai-diffusion-5-full",
      effort: "high",
      v5Mode: "anime",
      requestType: "generate",
      sampler: "k_euler_ancestral",
      seed: 123456,
    },
    ...overrides,
  };
}

function f(patch: Partial<HistoryFilter>): HistoryFilter {
  return { ...EMPTY_HISTORY_FILTER, ...patch };
}

describe("historyFilter", () => {
  it("matches all shots when filter is empty", () => {
    const shots = [shot("a"), shot("b")];
    expect(hasActiveHistoryFilter(EMPTY_HISTORY_FILTER)).toBe(false);
    expect(countActiveHistoryFilters(EMPTY_HISTORY_FILTER)).toBe(0);
    expect(filterHistoryShots(shots, EMPTY_HISTORY_FILTER, now)).toEqual(shots);
  });

  it("filters by query across prompt, uc, artists, characters, and seed", () => {
    const s1 = shot("s1", {
      prompt: "1girl, silver hair",
      meta: { prompt: "1girl, silver hair", uc: "bad hands", artists: ["wlop"], seed: 998877 },
    });
    const s2 = shot("s2", {
      prompt: "1boy, jacket",
      meta: {
        prompt: "1boy, jacket",
        characters: [{ prompt: "red eyes, sword", uc: "blurry" }],
        seed: 112233,
      },
    });
    expect(filterHistoryShots([s1, s2], f({ query: "silver wlop" }), now).map((s) => s.jobId)).toEqual(["s1"]);
    expect(filterHistoryShots([s1, s2], f({ query: "998877" }), now).map((s) => s.jobId)).toEqual(["s1"]);
    expect(filterHistoryShots([s1, s2], f({ query: "SWORD" }), now).map((s) => s.jobId)).toEqual(["s2"]);
    expect(filterHistoryShots([s1, s2], f({ query: "bad hands" }), now).map((s) => s.jobId)).toEqual(["s1"]);
  });

  it("filters by date presets and custom date range", () => {
    const todayShot = shot("today", { createdAt: at(2026, 11, 14, 1) });
    const d5Shot = shot("d5", { createdAt: at(2026, 11, 9, 12) });
    const d15Shot = shot("d15", { createdAt: at(2026, 10, 30, 12) });
    const oldShot = shot("old", { createdAt: at(2026, 9, 1, 12) });
    const all = [todayShot, d5Shot, d15Shot, oldShot];

    expect(filterHistoryShots(all, f({ datePreset: "today" }), now).map((s) => s.jobId)).toEqual(["today"]);
    expect(filterHistoryShots(all, f({ datePreset: "7d" }), now).map((s) => s.jobId)).toEqual(["today", "d5"]);
    expect(filterHistoryShots(all, f({ datePreset: "30d" }), now).map((s) => s.jobId)).toEqual(["today", "d5", "d15"]);
    expect(
      filterHistoryShots(all, f({ datePreset: "custom", dateFrom: "2026-10-30", dateTo: "2026-11-09" }), now).map((s) => s.jobId),
    ).toEqual(["d5", "d15"]);
    expect(filterHistoryShots(all, f({ datePreset: "custom", dateFrom: "2026-11-10" }), now).map((s) => s.jobId)).toEqual(["today"]);
    expect(filterHistoryShots(all, f({ datePreset: "custom", dateTo: "2026-10-30" }), now).map((s) => s.jobId)).toEqual(["d15", "old"]);
  });

  it("filters by model, effort, v5Mode, requestType, aspect, and sampler", () => {
    const sFull = shot("full", {
      width: 832,
      height: 1216,
      meta: { model: "nai-diffusion-5-full", effort: "high", v5Mode: "anime", requestType: "generate", sampler: "k_euler" },
    });
    const sMedium = shot("med", {
      width: 1216,
      height: 832,
      meta: { model: "nai-diffusion-5-full-medium-inpainting", effort: "medium", v5Mode: "furry", requestType: "infill", sampler: "k_dpmpp_2m" },
    });
    const sCurated = shot("cur", {
      width: 1024,
      height: 1024,
      meta: { model: "nai-diffusion-5-curated", effort: "high", requestType: "variation", sampler: "k_euler_ancestral" },
    });
    const all = [sFull, sMedium, sCurated];

    expect(filterHistoryShots(all, f({ model: "full" }), now).map((s) => s.jobId)).toEqual(["full"]);
    expect(filterHistoryShots(all, f({ model: "medium" }), now).map((s) => s.jobId)).toEqual(["med"]);
    expect(filterHistoryShots(all, f({ model: "curated" }), now).map((s) => s.jobId)).toEqual(["cur"]);
    expect(filterHistoryShots(all, f({ v5Mode: "furry" }), now).map((s) => s.jobId)).toEqual(["med"]);
    expect(filterHistoryShots(all, f({ requestType: "infill" }), now).map((s) => s.jobId)).toEqual(["med"]);
    expect(filterHistoryShots(all, f({ aspect: "port" }), now).map((s) => s.jobId)).toEqual(["full"]);
    expect(filterHistoryShots(all, f({ aspect: "land" }), now).map((s) => s.jobId)).toEqual(["med"]);
    expect(filterHistoryShots(all, f({ aspect: "square" }), now).map((s) => s.jobId)).toEqual(["cur"]);
    expect(filterHistoryShots(all, f({ sampler: "k_dpmpp_2m" }), now).map((s) => s.jobId)).toEqual(["med"]);
  });

  it("counts and describes active filters with working clear callbacks", () => {
    const active = f({
      query: "cat",
      datePreset: "7d",
      aspect: "land",
      sampler: "k_euler",
    });
    expect(countActiveHistoryFilters(active)).toBe(4);
    const chips = describeHistoryFilters(active);
    expect(chips.map((c) => c.label)).toEqual(["关键词: cat", "近 7 天", "横图", "Euler"]);
    const cleared = chips[0].clear(active);
    expect(cleared.query).toBe("");
    expect(countActiveHistoryFilters(cleared)).toBe(3);

    const emptyCustom = f({ datePreset: "custom", dateFrom: "", dateTo: "" });
    expect(countActiveHistoryFilters(emptyCustom)).toBe(0);
    expect(hasActiveHistoryFilter(emptyCustom)).toBe(false);
  });

  it("collects distinct samplers in known order followed by custom ones", () => {
    const samplers = collectHistorySamplers([
      shot("a", { meta: { sampler: "k_dpmpp_2m" } }),
      shot("b", { meta: { sampler: "custom_sampler" } }),
      shot("c", { meta: { sampler: "k_euler_ancestral" } }),
    ]);
    expect(samplers).toEqual(["k_euler_ancestral", "k_dpmpp_2m", "custom_sampler"]);
  });
});
