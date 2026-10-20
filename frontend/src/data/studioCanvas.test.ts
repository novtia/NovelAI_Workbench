import { describe, expect, it } from "vitest";
import { blobUrl } from "@/api/assets";
import { boundsOf, canvasLayout, CANVAS_BLOCK_W, cellOfShot, fitCamera, groupOfShot, scrollCamera, shotNearest, zoomAt } from "./studioCanvas";
import type { StudioShot } from "./types";

const shot = (id: string, extra: Partial<StudioShot> = {}): StudioShot => ({ id, url: `/u/${id}`, thumbUrl: "", width: 832, height: 1216, meta: {}, ...extra });

describe("canvasLayout", () => {
  it("最新的在最上面，往下是更早的图", () => {
    // 会话里最新的在前面
    const groups = canvasLayout([shot("new"), shot("old")]);
    expect(groups.map((g) => g.cells[0].shot?.id)).toEqual(["new", "old"]);
    expect(groups[1].y).toBeGreaterThan(groups[0].y + groups[0].h);
    expect(groups[0].cells[0].w).toBe(CANVAS_BLOCK_W);
  });

  it("变体组：原图带 ORIGINAL 角标，和 3 张变体排成 2x2", () => {
    const meta = { requestType: "variation", sourceHash: "src" };
    const vs = [0, 1, 2].map((i) => shot(`v${i}`, { jobId: "j", sample: i, meta }));
    const [g] = canvasLayout([vs[2], vs[0], vs[1]]);
    expect(g.cells).toHaveLength(4);
    expect(g.cells[0].badge).toBe("ORIGINAL");
    expect(g.cells[0].src).toBe(blobUrl("src"));
    expect(g.cells.slice(1).map((c) => c.shot?.id)).toEqual(["v0", "v1", "v2"]);
    expect(g.cells[1].x).toBeGreaterThan(g.cells[0].x);
    expect(g.cells[2].y).toBeGreaterThan(g.cells[0].y);
    expect(groupOfShot([g], "v1")).toBe(g);
    expect(cellOfShot([g], "v1")).toMatchObject({ x: g.cells[2].x, y: g.cells[2].y, w: g.cells[2].w, h: g.cells[2].h });
    expect(cellOfShot([g], "nope")).toBeNull();
    expect(groupOfShot([g], "nope")).toBeNull();
  });
});

describe("camera", () => {
  it("fit 把内容居中", () => {
    const box = boundsOf(canvasLayout([shot("a")]))!;
    const cam = fitCamera(box, 1000, 800);
    const cx = cam.x + (box.x + box.w / 2) * cam.z;
    const cy = cam.y + (box.y + box.h / 2) * cam.z;
    expect(cx).toBeCloseTo(500);
    expect(cy).toBeCloseTo(400);
  });

  it("滚轮只改纵向位置，中心落到哪张图就选哪张", () => {
    const groups = canvasLayout([shot("top"), shot("bottom")]);
    const cam = scrollCamera({ x: 0, y: 0, z: 1 }, 400);
    expect(cam).toEqual({ x: 0, y: -400, z: 1 });
    const top = groups[0].cells[0];
    const bottom = groups[1].cells[0];
    expect(shotNearest(groups, top.x + top.w / 2, top.y + 10)?.id).toBe("top");
    expect(shotNearest(groups, bottom.x + bottom.w / 2, bottom.y + bottom.h - 10)?.id).toBe("bottom");
  });

  it("以鼠标点为中心缩放", () => {
    const cam = { x: 100, y: 50, z: 1 };
    const next = zoomAt(cam, 300, 200, 2);
    // 鼠标下的世界坐标 (200, 150) 缩放后仍在 (300, 200)
    expect(next.x + 200 * next.z).toBeCloseTo(300);
    expect(next.y + 150 * next.z).toBeCloseTo(200);
  });
});
