import { describe, expect, it } from "vitest";
import {
  findArtistAt,
  findArtistSpans,
  splitSingleArtistSections,
  indexArtistPreviews,
  isSingleArtistAlbum,
  splitArtistTokens,
  uniqueArtistKeys,
} from "./singleArtist";
import type { Artwork } from "./types";

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

describe("single artist helpers", () => {
  it("recognizes the system album", () => {
    expect(isSingleArtistAlbum({ id: "x", name: "单画师" })).toBe(true);
    expect(isSingleArtistAlbum({ id: "single-artist", name: "其它" })).toBe(true);
    expect(isSingleArtistAlbum({ id: "x", name: "默认收藏夹", kind: "singleArtist" })).toBe(true);
    expect(isSingleArtistAlbum({ id: "x", name: "默认收藏夹" })).toBe(false);
  });

  it("dedupes artist keys", () => {
    expect(uniqueArtistKeys(["hiro_(dismaless)", "artist:Hiro_(dismaless)"])).toEqual(["hiro (dismaless)"]);
    expect(uniqueArtistKeys(["a", "b"])).toHaveLength(2);
    expect(uniqueArtistKeys([])).toEqual([]);
  });

  it("keeps unique artists in the shared grid and splits duplicates below", () => {
    const sections = splitSingleArtistSections([
      art({ id: "new", artists: ["hiro_(dismaless)"], addedAt: 3 }),
      art({ id: "foo", artists: ["foo"], addedAt: 2 }),
      art({ id: "old", artists: ["hiro_(dismaless)"], addedAt: 1 }),
      art({ id: "bar", artists: ["bar"], addedAt: 0 }),
    ]);
    expect(sections.shared.map((it) => it.id)).toEqual(["foo", "bar"]);
    expect(sections.extras).toHaveLength(1);
    expect(sections.extras[0].key).toBe("hiro (dismaless)");
    expect(sections.extras[0].items.map((it) => it.id)).toEqual(["new", "old"]);
  });

  it("indexes previews newest first", () => {
    const map = indexArtistPreviews([
      art({ id: "a", artists: ["foo"], addedAt: 1 }),
      art({ id: "b", artists: ["foo"], addedAt: 9 }),
    ]);
    expect(map.get("foo")?.map((it) => it.id)).toEqual(["b", "a"]);
  });

  it("finds artist tokens including prefix", () => {
    const text = "0.80::artist:hiro_(dismaless)::, artist:foo";
    const spans = findArtistSpans(text);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["artist:hiro_(dismaless)", "artist:foo"]);
    expect(findArtistAt(text, text.indexOf("hiro"))?.name).toBe("hiro_(dismaless)");
    expect(findArtistAt(text, 0)).toBeNull();
    const parts = splitArtistTokens(text);
    expect(parts.filter((p) => p.type === "artist").map((p) => p.name)).toEqual(["hiro_(dismaless)", "foo"]);
  });
});
