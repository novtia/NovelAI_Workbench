import { describe, expect, it } from "vitest";
import { findArtistCards } from "@/data/artistCards";
import { stillTyping } from "./promptDom";

describe("stillTyping（实时渲染时哪些 tag 先不变卡片）", () => {
  const plain = findArtistCards("1girl, artist:foo")[0];
  const weighted = findArtistCards("0.5::artist:foo::")[0];
  const bracket = findArtistCards("[artist:foo]")[0];

  it("没有光标信息时一律转成卡片", () => {
    expect(stillTyping(plain, null)).toBe(false);
  });

  it("光标在 tag 中间：保留成文字", () => {
    expect(stillTyping(plain, plain.start + 4)).toBe(true);
    expect(stillTyping(weighted, weighted.start + 3)).toBe(true);
  });

  it("光标在末尾：只有还可能继续打字的无权重 tag 保留成文字", () => {
    expect(stillTyping(plain, plain.end)).toBe(true);
    expect(stillTyping(weighted, weighted.end)).toBe(false);
    expect(stillTyping(bracket, bracket.end)).toBe(false);
  });

  it("光标在 tag 之外：转成卡片", () => {
    expect(stillTyping(plain, plain.start)).toBe(false);
    expect(stillTyping(plain, plain.end + 1)).toBe(false);
  });
});
