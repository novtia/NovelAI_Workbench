import { describe, expect, it } from "vitest";
import { basketAdd, basketHasAll, basketRemove, basketText, normalizeBasketNames } from "./artistBasket";
import type { BasketArtist } from "./types";

const A = (name: string, key = name.toLowerCase()): BasketArtist => ({ key, name, addedAt: 1 });

describe("normalizeBasketNames", () => {
  it("去掉 artist: 前缀、去空、按 key 去重并保持顺序", () => {
    const out = normalizeBasketNames(["artist:foo", "Bar", "  ", "FOO", "artist:artist:baz", null]);
    expect(out.map((n) => n.name)).toEqual(["foo", "Bar", "baz"]);
  });

  it("非数组返回空", () => {
    expect(normalizeBasketNames(undefined)).toEqual([]);
  });
});

describe("basketText", () => {
  it("按加入顺序输出 artist:a, artist:b，没有权重", () => {
    const text = basketText([A("a"), A("b"), A("c")]);
    expect(text).toBe("artist:a, artist:b, artist:c");
    expect(text).not.toContain("::");
  });

  it("名称自带前缀也不会重复", () => {
    expect(basketText([A("artist:x")])).toBe("artist:x");
  });

  it("空列表得到空串", () => {
    expect(basketText([])).toBe("");
  });
});

describe("basketAdd / basketRemove", () => {
  it("追加缺失的画师，已有的不重复", () => {
    const base = [A("a")];
    const next = basketAdd(base, ["a", "b", "c"], 5);
    expect(next.map((x) => x.name)).toEqual(["a", "b", "c"]);
    expect(next[1].addedAt).toBe(5);
    expect(basketAdd(next, ["b"])).toBe(next);
  });

  it("按 key 移除", () => {
    const base = [A("a"), A("b"), A("c")];
    expect(basketRemove(base, ["b"]).map((x) => x.name)).toEqual(["a", "c"]);
    expect(basketRemove(base, ["zzz"])).toBe(base);
  });
});

describe("basketHasAll", () => {
  const list = [A("a"), A("b")];
  it("全部都在才算已加入", () => {
    expect(basketHasAll(list, ["a", "b"])).toBe(true);
    expect(basketHasAll(list, ["a", "c"])).toBe(false);
  });
  it("没有画师算未加入", () => {
    expect(basketHasAll(list, [])).toBe(false);
  });
});
