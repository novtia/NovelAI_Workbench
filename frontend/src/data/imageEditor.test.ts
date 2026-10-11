import { describe, expect, it } from "vitest";
import {
  ADJUST_ZERO,
  adjustFilter,
  dilate,
  floodRegion,
  hexToRgb,
  isAdjusted,
  rgbToHex,
  selBox,
  selContains,
  validSel,
  type Pixels,
  type Sel,
} from "./imageEditor";

/** 4x3：左边 2 列是红，右边 2 列是蓝，中间没有隔断。 */
function twoColor(): Pixels {
  const w = 4;
  const h = 3;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const red = x < 2;
      data[o] = red ? 255 : 0;
      data[o + 2] = red ? 0 : 255;
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

describe("floodRegion", () => {
  it("只填点击处连通的同色区域", () => {
    const out = floodRegion(twoColor(), 0, 0, 10);
    expect(Array.from(out)).toEqual([1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0]);
  });

  it("容差够大就连成一片", () => {
    const out = floodRegion(twoColor(), 3, 2, 255);
    expect(out.every((v) => v === 1)).toBe(true);
  });

  it("点在画布外什么也不填", () => {
    expect(floodRegion(twoColor(), -1, 0, 10).some((v) => v)).toBe(false);
    expect(floodRegion(twoColor(), 4, 0, 10).some((v) => v)).toBe(false);
  });

  it("dilate 向外扩一圈", () => {
    const m = new Uint8Array(9);
    m[4] = 1;
    expect(Array.from(dilate(m, 3, 3))).toEqual([0, 1, 0, 1, 1, 1, 0, 1, 0]);
  });
});

describe("selection", () => {
  const rect: Sel = { kind: "rect", x: 10, y: 10, w: 20, h: 10 };
  const tri: Sel = { kind: "lasso", pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] };

  it("矩形和套索的命中判断", () => {
    expect(selContains(rect, { x: 15, y: 12 })).toBe(true);
    expect(selContains(rect, { x: 31, y: 12 })).toBe(false);
    expect(selContains(tri, { x: 2, y: 2 })).toBe(true);
    expect(selContains(tri, { x: 8, y: 8 })).toBe(false);
  });

  it("包围盒和过小选区", () => {
    expect(selBox(tri)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(validSel({ kind: "rect", x: 0, y: 0, w: 1, h: 1 })).toBeNull();
    expect(validSel(rect)).toBe(rect);
    expect(validSel(null)).toBeNull();
  });
});

describe("color and adjust", () => {
  it("十六进制和 rgb 互转", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(rgbToHex(255, 128, 0)).toBe("#ff8000");
    expect(hexToRgb("bad")).toEqual([0, 0, 0]);
  });

  it("调整滤镜", () => {
    expect(isAdjusted(ADJUST_ZERO)).toBe(false);
    expect(isAdjusted({ ...ADJUST_ZERO, hue: 10 })).toBe(true);
    expect(adjustFilter(ADJUST_ZERO)).toBe("brightness(1.00) contrast(1.00) saturate(1.00) hue-rotate(0deg)");
    expect(adjustFilter({ brightness: 50, contrast: -100, saturation: 200, hue: 30 })).toBe("brightness(1.50) contrast(0.00) saturate(2.00) hue-rotate(30deg)");
  });
});
