import { describe, expect, it } from "vitest";
import { buildSkinLayout, buildTestTargets, indexSkins, missingTargets, testJobKey } from "./testRun";
import type { Artwork, Job } from "./types";

function art(partial: Partial<Artwork> & Pick<Artwork, "id" | "artists" | "addedAt">): Artwork {
  return {
    albumId: "single-artist",
    name: `${partial.id}.png`,
    mime: "image/png",
    size: 1,
    hash: partial.id,
    artistLine: "",
    params: {},
    imageUrl: "",
    thumbUrl: "",
    ...partial,
  };
}

function job(id: string, artist: string, status: string, testSetId = "testset-a"): Job {
  return {
    id,
    source: "gallery",
    status,
    progress: {},
    items: [],
    meta: {},
    createdAt: 0,
    client: { testSetId, artists: [artist], artist },
  } as unknown as Job;
}

// 默认集：a、b、c 各一张；d 两张（分组）
const base = [
  art({ id: "a", artists: ["a"], addedAt: 6 }),
  art({ id: "b", artists: ["b"], addedAt: 5 }),
  art({ id: "c", artists: ["c"], addedAt: 4 }),
  art({ id: "d1", artists: ["d"], addedAt: 3 }),
  art({ id: "d2", artists: ["d"], addedAt: 2 }),
];

const skin = (id: string, artist: string, addedAt = 10) =>
  art({ id, albumId: "testset-a", artists: [artist], addedAt });

describe("test set targets", () => {
  it("follows the default set display order and dedupes artists", () => {
    const targets = buildTestTargets([
      art({ id: "new", artists: ["hiro_(dismaless)"], artistLine: "artist:hiro_(dismaless)", addedAt: 4 }),
      art({ id: "foo", artists: ["foo"], artistLine: "0.8::artist:foo::", addedAt: 3 }),
      art({ id: "old", artists: ["artist:Hiro (dismaless)"], addedAt: 2 }),
      art({ id: "bar", artists: ["bar"], addedAt: 1 }),
      art({ id: "none", artists: [], addedAt: 0 }),
    ]);
    // 单张的画师在前（foo、bar），多图的画师（hiro）在后，与图库显示顺序一致
    expect(targets.map((t) => t.key)).toEqual(["foo", "bar", "hiro (dismaless)"]);
    expect(targets.map((t) => t.index)).toEqual([0, 1, 2]);
  });

  it("returns nothing for an empty gallery", () => {
    expect(buildTestTargets([])).toEqual([]);
  });
});

describe("skin layout", () => {
  it("keeps the default layout and shows defaults when the test set is empty", () => {
    const layout = buildSkinLayout(base, [], [], "testset-a");
    expect(layout.shared.map((s) => s.base.id)).toEqual(["a", "b", "c"]);
    expect(layout.extras.map((g) => g.slots.map((s) => s.base.id))).toEqual([["d1", "d2"]]);
    expect(layout.shared.every((s) => !s.skin && !s.pending)).toBe(true);
    expect(layout.progress).toMatchObject({ total: 4, done: 0, missing: 4 });
  });

  it("swaps only the artists that have a skin; the rest stay default", () => {
    const layout = buildSkinLayout(base, [skin("sb", "b")], [], "testset-a");
    expect(layout.shared.map((s) => s.skin?.id ?? null)).toEqual([null, "sb", null]);
    // 位置、数量不变
    expect(layout.shared.map((s) => s.base.id)).toEqual(["a", "b", "c"]);
    expect(layout.progress).toMatchObject({ total: 4, done: 1, missing: 3 });
  });

  it("only replaces the first image of a multi-image artist group", () => {
    const layout = buildSkinLayout(base, [skin("sd", "d")], [], "testset-a");
    const group = layout.extras[0].slots;
    expect(group.map((s) => s.skin?.id ?? null)).toEqual(["sd", null]);
    expect(group.map((s) => s.base.id)).toEqual(["d1", "d2"]);
  });

  it("uses the newest skin when an artist has several", () => {
    const skins = indexSkins([skin("old", "a", 1), skin("new", "a", 2)]);
    expect(skins.get("a")?.id).toBe("new");
  });

  it("shows streaming, queued and failed slots by artist key, not by index", () => {
    const jobs = [job("ja", "a", "done"), job("jb", "b", "running"), job("jc", "c", "error"), job("jd", "d", "queued")];
    const layout = buildSkinLayout(base, [], jobs, "testset-a", false);
    expect(layout.shared.map((s) => s.pending?.state ?? null)).toEqual(["running", "running", "error"]);
    // 重新排队（继续）期间，上一轮的失败记录不再显示
    const resuming = buildSkinLayout(base, [], jobs, "testset-a", true);
    expect(resuming.shared[2].pending?.state).toBe("queued");
    expect(layout.extras[0].slots[0].pending?.state).toBe("queued");
    expect(layout.extras[0].slots[1].pending).toBeNull();
    expect(layout.progress).toMatchObject({ total: 4, done: 0, failed: 1, pending: 3, finished: false });
  });

  it("marks unsent artists as queued while submitting and falls back to default once stopped", () => {
    const submitting = buildSkinLayout(base, [], [], "testset-a", true);
    expect(submitting.shared.map((s) => s.pending?.state)).toEqual(["queued", "queued", "queued"]);
    const stopped = buildSkinLayout(base, [], [job("jx", "a", "cancelled")], "testset-a", false);
    expect(stopped.shared.every((s) => !s.pending)).toBe(true);
    expect(stopped.progress.finished).toBe(true);
  });

  it("ignores jobs of other test sets", () => {
    const layout = buildSkinLayout(base, [], [job("jx", "a", "running", "testset-b")], "testset-a", false);
    expect(layout.shared[0].pending).toBeNull();
  });

  it("a newly imported artist adds a slot everywhere and shows its default image", () => {
    const withNew = [...base, art({ id: "e", artists: ["e"], addedAt: 20 })];
    const layout = buildSkinLayout(withNew, [skin("sa", "a")], [], "testset-a");
    expect(layout.shared.map((s) => s.base.id)).toEqual(["a", "b", "c", "e"]);
    expect(layout.shared[3].skin).toBeNull();
    expect(layout.progress.total).toBe(5);
  });

  it("does not show a skin whose artist was removed from the default set", () => {
    const layout = buildSkinLayout(base, [skin("sz", "zzz")], [], "testset-a");
    const shown = [...layout.shared, ...layout.extras.flatMap((g) => g.slots)];
    expect(shown.some((s) => s.skin?.id === "sz")).toBe(false);
  });
});

describe("missingTargets / testJobKey", () => {
  it("lists artists without skin in default order", () => {
    const missing = missingTargets(base, [skin("sb", "b")]);
    expect(missing.map((t) => t.key)).toEqual(["a", "c", "d"]);
    expect(missing.map((t) => t.index)).toEqual([0, 1, 2]);
  });

  it("reads the artist key from the job client", () => {
    expect(testJobKey(job("j", "Foo_Bar", "queued"))).toBe("foo bar");
  });
});
