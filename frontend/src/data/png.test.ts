import { describe, expect, it } from "vitest";
import { scrubStealth, type PixelData } from "./png";

/** 和 NovelAI 一样：按列优先，把每个 bit 写进 alpha 的最低位（alpha 只会是 254/255）。 */
function stealthAlpha(width: number, height: number, text: string): PixelData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) data.set([120, 90, 60, 255], p * 4);
  const bits: number[] = [];
  for (const byte of new TextEncoder().encode(text)) for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  bits.forEach((bit, i) => {
    const x = Math.floor(i / height);
    const y = i % height;
    data[(y * width + x) * 4 + 3] = 254 + bit;
  });
  return { data, width, height };
}

describe("scrubStealth", () => {
  it("flattens alpha-channel stealth data to fully opaque", () => {
    const img = stealthAlpha(16, 16, "stealth_pngcomp-secret");
    expect(img.data.some((_, i) => i % 4 === 3 && img.data[i] === 254)).toBe(true);
    scrubStealth(img);
    for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
  });

  it("keeps real transparency and does not touch RGB without an RGB stealth header", () => {
    const img: PixelData = { data: new Uint8ClampedArray([10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 255]), width: 3, height: 1 };
    scrubStealth(img);
    expect([...img.data]).toEqual([10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 255]);
  });

  it("scrambles the RGB LSBs when an RGB stealth header is present", () => {
    const width = 16;
    const height = 16;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const bits: number[] = [];
    for (const byte of new TextEncoder().encode("stealth_rgbinfo\0")) for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
    bits.forEach((bit, i) => {
      const pixel = Math.floor(i / 3);
      data[pixel * 4 + (i % 3)] = 200 + bit;
    });
    const before = [...data];
    scrubStealth({ data, width, height });
    // 高 7 位保持不变，只有最低位被打乱
    for (let i = 0; i < data.length; i++) if (i % 4 !== 3) expect(data[i] >> 1).toBe(before[i] >> 1);
    const head = new Uint8Array(48).map((_, i) => data[Math.floor(i / 3) * 4 + (i % 3)] & 1);
    expect([...head]).not.toEqual(bits.slice(0, 48));
  });
});
