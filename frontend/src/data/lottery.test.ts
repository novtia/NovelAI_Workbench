import { describe, expect, it } from "vitest";
import { applyJobToBatches, chainText, collectArtistPool, matchDrawJob, parseCapInput, parseEntries, placeLotPop, resolveDrawJob, resolveDrawVisual } from "./lottery";
import type { DrawBatch, Job } from "./types";

function job(partial: Partial<Job> & Pick<Job, "id" | "client">): Job {
  return {
    source: "lottery",
    status: "done",
    progress: {},
    items: [],
    meta: {},
    createdAt: 1,
    ...partial,
  };
}

describe("lottery data", () => {
  it("parses cap input", () => {
    expect(parseCapInput("")).toBe("");
    expect(parseCapInput(" 1.256 ")).toBe(1.26);
    expect(parseCapInput("abc")).toBe(false);
  });

  it("pads numeric artist closers", () => {
    expect(chainText("0.50::artist:foo2::")).toBe("0.50::artist:foo2 ::");
  });

  it("builds a pool with weights from artist chains", () => {
    const items = [
      {
        artists: ["Foo", "Bar"],
        artistLine: "0.80::artist:Foo::, 0.20::artist:Bar::",
        params: { artistChain: "0.80::artist:Foo::, 0.20::artist:Bar::" },
      },
    ];
    const pool = collectArtistPool(items);
    expect(pool.map((p) => p.key)).toEqual(["bar", "foo"]);
    expect(pool.find((p) => p.key === "foo")?.weight).toBe(0.8);
  });

  it("parses weighted entries", () => {
    const entries = parseEntries("0.50::artist:alpha::, artist:beta");
    expect(entries[0].weight).toBe(0.5);
    expect(entries[1].hadWeight).toBe(false);
  });

  it("prefers the active lottery job then the finished one", () => {
    const jobs = [
      job({
        id: "old",
        items: [{ blobHash: "aaa" }],
        client: { batchId: "b1", drawId: "draw-a" },
      }),
      job({
        id: "live",
        status: "running",
        createdAt: 2,
        previewUrl: "/cache/live-1.png",
        client: { batchId: "b1", drawId: "draw-a" },
      }),
    ];
    const resolved = resolveDrawJob(jobs, "b1", "draw-a");
    expect(resolved.job?.id).toBe("live");
    expect(matchDrawJob(jobs, "b1", "draw-a")?.id).toBe("live");
    expect(resolved.shots[0]?.blobHash).toBe("aaa");
  });

  it("keeps images on the artist-string id after a middle draw is deleted", () => {
    const jobs = [
      job({ id: "job-a", items: [{ blobHash: "img-a" }], client: { batchId: "b1", drawId: "draw-a", drawIndex: 0 } }),
      job({ id: "job-b", items: [{ blobHash: "img-b" }], client: { batchId: "b1", drawId: "draw-b", drawIndex: 1 } }),
      job({ id: "job-c", items: [{ blobHash: "img-c" }], client: { batchId: "b1", drawId: "draw-c", drawIndex: 2 } }),
    ];
    expect(matchDrawJob(jobs, "b1", "draw-c")?.id).toBe("job-c");
    expect(resolveDrawJob(jobs, "b1", "draw-c").shots[0]?.blobHash).toBe("img-c");
    expect(matchDrawJob(jobs, "b1", "draw-b")?.id).toBe("job-b");
    expect(matchDrawJob(jobs, "b1", "b1:1")).toBeNull();
  });

  it("matches legacy jobs by batchId:drawIndex only when drawId is missing", () => {
    const jobs = [
      job({ id: "legacy-c", items: [{ blobHash: "img-c" }], client: { batchId: "b1", drawIndex: 2 } }),
    ];
    expect(matchDrawJob(jobs, "b1", "b1:2")?.id).toBe("legacy-c");
    expect(matchDrawJob(jobs, "b1", "b1:1")).toBeNull();
  });

  it("reads persisted previews on the artist-string when jobs are gone", () => {
    const draw = { outputText: "c", artistCount: 1, id: "draw-c", previews: [{ blobHash: "img-c" }] };
    const visual = resolveDrawVisual([], "b1", "draw-c", draw);
    expect(visual.shots[0]?.blobHash).toBe("img-c");
  });

  it("writes completed lottery shots onto the matching draw id", () => {
    const batches: DrawBatch[] = [
      {
        id: "b1",
        albumId: "a1",
        seed: 1,
        poolHash: "h",
        params: {},
        createdAt: 1,
        draws: [
          { id: "draw-a", outputText: "a", artistCount: 1 },
          { id: "draw-c", outputText: "c", artistCount: 1 },
        ],
      },
    ];
    const next = applyJobToBatches(
      batches,
      job({ id: "job-c", items: [{ blobHash: "img-c" }], client: { batchId: "b1", drawId: "draw-c" } }),
    );
    expect(next?.[0].draws[0].previews).toBeUndefined();
    expect(next?.[0].draws[1].previews?.[0]?.blobHash).toBe("img-c");
    expect(next?.[0].draws[1].jobId).toBe("job-c");
  });

  it("places the save pop above the trigger when there is room", () => {
    Object.assign(globalThis, { window: { innerWidth: 1024, innerHeight: 768 } });
    const pos = placeLotPop(220, 120, { left: 400, top: 300, right: 428, bottom: 328, width: 28, height: 28 });
    expect(pos.left).toBe(208);
    expect(pos.top).toBe(174);
  });
});
