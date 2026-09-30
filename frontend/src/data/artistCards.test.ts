import { describe, expect, it } from "vitest";
import {
  applySuggestionText,
  artistLibraryNames,
  filterArtistNames,
  findArtistCards,
  formatArtistCard,
  joinPromptSegments,
  parseWeightInput,
  splitPromptSegments,
  stepWeight,
  suggestQueryFromSegment,
} from "./artistCards";

describe("artist cards", () => {
  it("recognises the three forms and leaves commas outside", () => {
    const text = "0.92::artist:maabo harusame ::, artist:foo, [artist:bar], 1girl";
    const cards = findArtistCards(text);
    expect(cards.map((c) => text.slice(c.start, c.end))).toEqual([
      "0.92::artist:maabo harusame ::",
      "artist:foo",
      "[artist:bar]",
    ]);
    expect(cards.map((c) => c.name)).toEqual(["maabo harusame", "foo", "bar"]);
    expect(cards.map((c) => c.weight)).toEqual([0.92, null, null]);
    expect(cards.map((c) => c.bracket)).toEqual([false, false, true]);
  });

  it("handles digit-ending names, underscores and parentheses", () => {
    const text = "0.45::artist:tarapisu153 ::,0.7::artist:nnk_(nongnong)::, artist:toma_(toma50)";
    const cards = findArtistCards(text);
    expect(cards.map((c) => c.name)).toEqual(["tarapisu153", "nnk_(nongnong)", "toma_(toma50)"]);
    expect(cards[0].weight).toBe(0.45);
    expect(cards[2].weight).toBeNull();
  });

  it("keeps weight-only groups and plain text as text", () => {
    expect(findArtistCards("1.2::red hair::, 1girl")).toEqual([]);
    expect(findArtistCards("nonartist:foo, a")).toEqual([]);
    expect(findArtistCards("artist:foo::, x")).toEqual([]);
  });

  it("supports a trailing tag with no comma and multi-line text", () => {
    const text = "1girl\nartist:foo bar\nsolo, artist:baz";
    expect(findArtistCards(text).map((c) => c.name)).toEqual(["foo bar", "baz"]);
  });

  it("round-trips through segments", () => {
    for (const text of [
      "",
      "1girl, solo",
      "0.92::artist:a ::, 1girl, artist:b",
      "a  ,  [artist:x]  ,\n0.5::artist:y2 ::  tail",
      "artist:only",
    ]) {
      expect(joinPromptSegments(splitPromptSegments(text))).toBe(text);
    }
    const parts = splitPromptSegments("x, artist:a, y");
    expect(parts.map((p) => p.type)).toEqual(["text", "card", "text"]);
  });

  it("formats cards and steps weights by 0.1", () => {
    expect(formatArtistCard("foo", null)).toBe("artist:foo");
    expect(formatArtistCard("foo", 0.9)).toBe("0.90::artist:foo::");
    expect(formatArtistCard("toma_(toma50)", 1.25)).toBe("1.25::artist:toma_(toma50)::");
    expect(formatArtistCard("tarapisu153", 0.92)).toBe("0.92::artist:tarapisu153 ::");
    expect(formatArtistCard("artist:foo", 1)).toBe("1.00::artist:foo::");
    expect(stepWeight(0.92, 1)).toBe(1.02);
    expect(stepWeight(null, 1)).toBe(1.1);
    expect(stepWeight(null, -1)).toBe(0.9);
    expect(stepWeight(0.05, -1)).toBe(0);
    expect(stepWeight(1.1, -1)).toBe(1);
  });

  it("parses free weight input", () => {
    expect(parseWeightInput("1.25")).toBe(1.25);
    expect(parseWeightInput(" 0,8 ")).toBe(0.8);
    expect(parseWeightInput("-0.5")).toBe(-0.5);
    expect(parseWeightInput("")).toBeNull();
    expect(parseWeightInput("abc")).toBe(false);
    expect(parseWeightInput("1..2")).toBe(false);
  });

  it("reads the suggestion query from the current segment", () => {
    expect(suggestQueryFromSegment("a")).toEqual({ query: "a", weight: null });
    expect(suggestQueryFromSegment("  artist:ab")).toEqual({ query: "ab", weight: null });
    expect(suggestQueryFromSegment("0.8::artist:hero ne")).toEqual({ query: "hero ne", weight: 0.8 });
    expect(suggestQueryFromSegment("0.8::ab")).toEqual({ query: "ab", weight: 0.8 });
    expect(suggestQueryFromSegment("")).toBeNull();
    expect(suggestQueryFromSegment("  ")).toBeNull();
    expect(suggestQueryFromSegment("artist:")).toBeNull();
    expect(suggestQueryFromSegment("0.8::")).toBeNull();
  });

  it("filters the library by prefix", () => {
    const names = ["Alpha", "abc_(x)", "beta", "artist:Aki", "hero neisan", "ba"];
    expect(filterArtistNames(names, "a")).toEqual(["abc_(x)", "Aki", "Alpha"]);
    expect(filterArtistNames(names, "abc ")).toEqual(["abc_(x)"]);
    expect(filterArtistNames(names, "hero_")).toEqual(["hero neisan"]);
    expect(filterArtistNames(names, "a", new Set(["alpha"]))).toEqual(["abc_(x)", "Aki"]);
    expect(filterArtistNames(names, "")).toEqual([]);
    expect(filterArtistNames(names, "z")).toEqual([]);
  });

  it("builds the artist library from gallery items", () => {
    expect(
      artistLibraryNames([{ artists: ["Foo_Bar"] }, { artists: ["artist:foo bar"] }, { artists: [] }, { artists: ["baz"] }]),
    ).toEqual(["Foo_Bar", "baz"]);
  });

  it("replaces the typed segment with a card and adds a comma on its right", () => {
    expect(applySuggestionText("a", 1, 1, "abc", null)).toEqual({ text: "artist:abc, ", caret: 12 });
    expect(applySuggestionText("1girl, ab", 9, 2, "abc", 0.8)).toEqual({
      text: "1girl, 0.80::artist:abc::, ",
      caret: 27,
    });
    expect(applySuggestionText("ab, solo", 2, 2, "abc", null).text).toBe("artist:abc, solo");
    expect(applySuggestionText("ab , solo", 2, 2, "abc", null).text).toBe("artist:abc , solo");
    expect(applySuggestionText("ab\nsolo", 2, 2, "abc", null).text).toBe("artist:abc,\nsolo");
    expect(applySuggestionText("x, ab tail", 5, 2, "abc", null).text).toBe("x, artist:abc, tail");
  });
});
