import type { StudioShot } from "./types";

/** 画布上的一格：一张会话图，或变体组左上角的原图。坐标是画布世界坐标。 */
export type CanvasCell = {
  key: string;
  shot: StudioShot | null;
  src: string;
  badge?: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
export type CanvasGroup = { key: string; cells: CanvasCell[]; x: number; y: number; w: number; h: number };
export type Box = { x: number; y: number; w: number; h: number };

/** 每个任务块的宽度、块与块之间、格与格之间的间距（世界坐标）。 */
export const CANVAS_BLOCK_W = 360;
export const CANVAS_GROUP_GAP = 48;
export const CANVAS_CELL_GAP = 8;

function ratio(shot: StudioShot | null | undefined, fallback: [number, number]) {
  const w = Number(shot?.width) || fallback[0];
  const h = Number(shot?.height) || fallback[1];
  return h / Math.max(1, w);
}

/**
 * 把会话排到画布上：一个任务一块，最新的在最上面，往下是更早的图。
 * 单张图占满块宽；多张（含变体组的原图）两列网格。
 */
export function canvasLayout(session: StudioShot[], fallback: [number, number] = [832, 1216]): CanvasGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, StudioShot[]>();
  for (const shot of session) {
    const key = shot.jobId || shot.id;
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(shot);
  }
  const groups: CanvasGroup[] = [];
  let y = 0;
  for (const key of order) {
    const shots = byKey.get(key)!.sort((a, b) => (a.sample ?? 0) - (b.sample ?? 0));
    const first = shots[0];
    const source = first.meta?.requestType === "variation" ? String(first.meta?.sourceHash || "") : "";
    const entries: Array<{ shot: StudioShot | null; src: string; badge?: string; key: string }> = [];
    if (source) entries.push({ shot: null, src: `/api/blobs/${source}`, badge: "ORIGINAL", key: `${key}:original` });
    for (const shot of shots) entries.push({ shot, src: "", key: shot.id });
    const x0 = -CANVAS_BLOCK_W / 2;
    const cells: CanvasCell[] = [];
    if (entries.length === 1) {
      const h = CANVAS_BLOCK_W * ratio(first, fallback);
      cells.push({ ...entries[0], x: x0, y, w: CANVAS_BLOCK_W, h });
    } else {
      const cw = (CANVAS_BLOCK_W - CANVAS_CELL_GAP) / 2;
      const ch = cw * ratio(first, fallback);
      entries.forEach((e, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        cells.push({ ...e, x: x0 + col * (cw + CANVAS_CELL_GAP), y: y + row * (ch + CANVAS_CELL_GAP), w: cw, h: ch });
      });
    }
    const bottom = Math.max(...cells.map((c) => c.y + c.h));
    groups.push({ key, cells, x: x0, y, w: CANVAS_BLOCK_W, h: bottom - y });
    y = bottom + CANVAS_GROUP_GAP;
  }
  return groups;
}

/** 某张会话图在画布上的格子。变体组里点选后用它把这一张放大居中。 */
export function cellOfShot(groups: CanvasGroup[], shotId: string | null | undefined): Box | null {
  if (!shotId) return null;
  for (const g of groups) {
    const c = g.cells.find((cell) => cell.shot?.id === shotId);
    if (c) return { x: c.x, y: c.y, w: c.w, h: c.h };
  }
  return null;
}

export function groupOfShot(groups: CanvasGroup[], shotId: string | null | undefined): CanvasGroup | null {
  if (!shotId) return null;
  return groups.find((g) => g.cells.some((c) => c.shot?.id === shotId)) || null;
}

export function boundsOf(groups: CanvasGroup[]): Box | null {
  if (!groups.length) return null;
  const x = Math.min(...groups.map((g) => g.x));
  const y = Math.min(...groups.map((g) => g.y));
  const r = Math.max(...groups.map((g) => g.x + g.w));
  const b = Math.max(...groups.map((g) => g.y + g.h));
  return { x, y, w: r - x, h: b - y };
}

export type Camera = { x: number; y: number; z: number };
export const CANVAS_MIN_ZOOM = 0.05;
export const CANVAS_MAX_ZOOM = 8;

export function clampZoom(z: number) {
  return Math.max(CANVAS_MIN_ZOOM, Math.min(CANVAS_MAX_ZOOM, z));
}

/** 让 box 以 fill 比例居中放进 vw×vh 的视口。 */
export function fitCamera(box: Box, vw: number, vh: number, fill = 0.82): Camera {
  const z = clampZoom(Math.min((vw * fill) / Math.max(1, box.w), (vh * fill) / Math.max(1, box.h)));
  return { z, x: vw / 2 - (box.x + box.w / 2) * z, y: vh / 2 - (box.y + box.h / 2) * z };
}

/** 普通滚轮：视口上下移动（滚轮向下看到更下面的图）。 */
export function scrollCamera(cam: Camera, deltaY: number): Camera {
  return { ...cam, y: cam.y - deltaY };
}

/** 视口中心对应的世界坐标落在哪张图上：按格子中心的距离，原图格没有会话图，跳过。 */
export function shotNearest(groups: CanvasGroup[], worldX: number, worldY: number): StudioShot | null {
  let best: StudioShot | null = null;
  let bestDist = Infinity;
  for (const g of groups) {
    for (const c of g.cells) {
      if (!c.shot) continue;
      const dx = c.x + c.w / 2 - worldX;
      const dy = c.y + c.h / 2 - worldY;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = c.shot;
      }
    }
  }
  return best;
}

/** 以屏幕点 (sx, sy) 为中心缩放，那一点下面的画面保持不动。 */
export function zoomAt(cam: Camera, sx: number, sy: number, nextZ: number): Camera {
  const z = clampZoom(nextZ);
  const wx = (sx - cam.x) / cam.z;
  const wy = (sy - cam.y) / cam.z;
  return { z, x: sx - wx * z, y: sy - wy * z };
}
