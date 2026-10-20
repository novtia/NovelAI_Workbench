import { describe, expect, it } from "vitest";
import { blobUrl } from "@/api/assets";
import {
  clampMagnitude,
  defaultEnhanceOpts,
  defaultForm,
  defaultI2iBase,
  ENHANCE_STRENGTH,
  enhanceJobPayload,
  formForShot,
  i2iJobPayload,
  upscaleJobPayload,
  historyCards,
  variationGroup,
  variationJobPayload,
} from "./studio";
import type { StudioShot } from "./types";

const base = defaultI2iBase({ hash: "h".repeat(64), url: blobUrl("x"), width: 832, height: 1216 });

describe("i2i payloads", () => {
  it("img2img 没有蒙版时只带强度和噪声", () => {
    const p = i2iJobPayload({ ...defaultForm(), prompt: "cat" }, { ...base, strength: 0.6, noise: 0.1 });
    expect(p.kind).toBe("img2img");
    expect(p.imageHash).toBe(base.hash);
    expect(p.strength).toBe(0.6);
    expect(p.noise).toBe(0.1);
    expect(p).not.toHaveProperty("maskHash");
    expect(p.prompt).toBe("cat");
  });

  it("有蒙版就是局部重绘", () => {
    const p = i2iJobPayload(defaultForm(), { ...base, maskHash: "m".repeat(64), inpaintStrength: 0.8 });
    expect(p.kind).toBe("infill");
    expect(p.maskHash).toBe("m".repeat(64));
    expect(p.inpaintStrength).toBe(0.8);
  });

  it("增强默认按 Magnitude 走，高级模式才发 strength/noise", () => {
    const opts = defaultEnhanceOpts();
    const plain = enhanceJobPayload(defaultForm(), base.hash, opts);
    expect(plain.kind).toBe("enhance");
    expect(plain.nSamples).toBe(1);
    expect(plain.upscaleAmount).toBe("max");
    expect(plain.magnitude).toBe(2);
    expect(plain).not.toHaveProperty("strength");
    const adv = enhanceJobPayload(defaultForm(), base.hash, { ...opts, advanced: true, strength: 0.33, noise: 0.2 });
    expect(adv.strength).toBe(0.33);
    expect(adv.noise).toBe(0.2);
  });

  it("Magnitude 夹在 1~5，2 对应官方实测的 0.5", () => {
    expect(clampMagnitude(0)).toBe(1);
    expect(clampMagnitude(9)).toBe(5);
    expect(clampMagnitude(Number.NaN)).toBe(2);
    expect(ENHANCE_STRENGTH[2]).toBe(0.5);
  });

  it("4x 放大只带图片哈希和继承的元数据", () => {
    expect(upscaleJobPayload("abc", 4, { prompt: "cat" })).toEqual({
      kind: "upscale",
      imageHash: "abc",
      scale: 4,
      inherit: { prompt: "cat" },
    });
  });

  it("表单没有 prompt 时增强沿用这张图自己的 prompt", () => {
    const form = formForShot(defaultForm(), { prompt: "1girl, hat", uc: "lowres" });
    expect(form.prompt).toBe("1girl, hat");
    expect(form.uc).toBe("lowres");
    const keep = formForShot({ ...defaultForm(), prompt: "mine" }, { prompt: "other" });
    expect(keep.prompt).toBe("mine");
  });
});

describe("variations", () => {
  const shot = (id: string, jobId: string, requestType = "variation"): StudioShot => ({
    id,
    url: "",
    thumbUrl: "",
    meta: { requestType, sourceHash: "src" },
    jobId,
  });

  it("变体任务固定 3 张、随机 seed、沿用表单 prompt", () => {
    const p = variationJobPayload({ ...defaultForm(), prompt: "cat", seed: 7 }, base.hash);
    expect(p.kind).toBe("variation");
    expect(p.imageHash).toBe(base.hash);
    expect(p.nSamples).toBe(3);
    expect(p.seed).toBe(-1);
    expect(p.prompt).toBe("cat");
  });

  it("同一任务的变体凑成网格，别的任务和普通图不凑", () => {
    const a = shot("a", "j1");
    const session = [a, shot("b", "j1"), shot("c", "j2"), shot("d", "j3", "generate")];
    const group = variationGroup(session, a);
    expect(group?.sourceHash).toBe("src");
    expect(group?.shots.map((x) => x.id)).toEqual(["a", "b"]);
    expect(variationGroup(session, session[3])).toBeNull();
    expect(variationGroup(session, null)).toBeNull();
  });

  it("历史里同一组变体收成一张，右下角按原图加变体计数", () => {
    const a = shot("a", "j1");
    const session = [a, shot("b", "j1"), shot("c", "j1"), shot("d", "j3", "generate")];
    const cards = historyCards(session);
    expect(cards.map((c) => c.key)).toEqual(["j1", "d"]);
    expect(cards[0].badge).toBe("x4");
    expect(cards[0].item.id).toBe("a");
    expect(cards[0].src).toBe(blobUrl("src"));
    expect(cards[1].badge).toBe("");
  });
});