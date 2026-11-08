import { describe, expect, it } from "vitest";
import { hasInsertTag, placeChain, stripInsertTags } from "./insertTag";
import { lotteryPrompt } from "./lottery";
import { expandFormulas, findFormulas, previewFormula, stepsUntilEnd } from "./tagFormula";

const lib = ["cc", "Aa", "bb"];

describe("tagFormula", () => {
  it("按 a-z 顺序取并回绕", () => {
    expect(expandFormulas("x, <画师>", lib, {}).text).toBe("x, artist:Aa");
    expect(expandFormulas("<画师>", lib, { "pool:artist": 1 }).text).toBe("artist:bb");
    expect(expandFormulas("<画师>", lib, { "pool:artist": 3 }).text).toBe("artist:Aa");
  });

  it("返回推进量，随机不推进", () => {
    expect(expandFormulas("<画师>", lib, {}).advance).toEqual({ "pool:artist": 1 });
    const r = expandFormulas("<画师:随机>", lib, {}, () => 0.99);
    expect(r.text).toBe("artist:cc");
    expect(r.advance).toEqual({});
  });

  it("步长取连续多个", () => {
    const r = expandFormulas("<画师:2>", lib, { "pool:artist": 2 });
    expect(r.text).toBe("artist:cc, artist:Aa");
    expect(r.advance).toEqual({ "pool:artist": 2 });
  });

  it("行内列表", () => {
    expect(expandFormulas("<red|blue>", [], { "list:red|blue": 1 }).text).toBe("blue");
  });

  it("空池保留原文，未知尖括号忽略", () => {
    const r = expandFormulas("<画师> <foo>", [], {});
    expect(r.text).toBe("<画师> <foo>");
    expect(r.missing).toEqual(["<画师>"]);
    expect(findFormulas("<foo>")).toEqual([]);
  });

  it("重复公式共用一个位置", () => {
    const r = expandFormulas("<画师>, <画师>", lib, {});
    expect(r.text).toBe("artist:Aa, artist:Aa");
    expect(r.advance).toEqual({ "pool:artist": 1 });
  });

  it("循环到末尾不再绕回开头", () => {
    const [f] = findFormulas("<画师:2>");
    expect(stepsUntilEnd(f, lib, {})).toBe(2);
    expect(stepsUntilEnd(f, lib, { "pool:artist": 2 })).toBe(1);
    expect(stepsUntilEnd(f, lib, { "pool:artist": 1 })).toBe(1);
    const last = expandFormulas("<画师:2>", lib, { "pool:artist": 2 }, Math.random, true);
    expect(last.text).toBe("artist:cc");
    expect(last.advance).toEqual({ "pool:artist": 1 });
    expect(stepsUntilEnd(findFormulas("<画师:随机>")[0], lib, {})).toBe(0);
  });

  it("预览", () => {
    const [f] = findFormulas("<画师>");
    const p = previewFormula(f, lib, { "pool:artist": 4 });
    expect(p.index).toBe(1);
    expect(p.total).toBe(3);
    expect(p.current).toEqual(["bb"]);
    expect(p.next).toEqual(["cc"]);
  });
});

describe("插入位置标签", () => {
  it("替换标签位置，无标签时加在最前", () => {
    expect(lotteryPrompt("artist:a", "1girl, <插入位置:抽奖,图库>, night")).toBe("1girl, artist:a, night");
    expect(lotteryPrompt("artist:a", "1girl, <插入位置>, night")).toBe("1girl, artist:a, night");
    expect(lotteryPrompt("artist:a", "1girl")).toBe("artist:a, 1girl");
  });

  it("只对列出的界面生效", () => {
    expect(placeChain("artist:a", "1girl, <插入位置:图库>", "抽奖")).toBe("artist:a, 1girl");
    expect(placeChain("artist:a", "1girl, <插入位置:图库>", "图库")).toBe("1girl, artist:a");
    expect(hasInsertTag("<插入位置:抽奖>", "图库")).toBe(false);
  });

  it("中文冒号逗号不识别，生图室直接去掉标签", () => {
    expect(hasInsertTag("<插入位置：抽奖，图库>", "抽奖")).toBe(false);
    expect(stripInsertTags("1girl, <插入位置:抽奖,图库>, night")).toBe("1girl, night");
  });
});
