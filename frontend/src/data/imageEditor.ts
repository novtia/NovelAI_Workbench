/** 图片编辑器的纯逻辑：选区几何、油漆桶洪泛、笔尖、调整滤镜。不依赖 React，方便测试。 */

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Sel = ({ kind: "rect" } & Box) | { kind: "lasso"; pts: Pt[] };
export type Tip = "round" | "soft" | "square" | "slash";
export type EditorTool = "pen" | "eraser" | "fill" | "marquee" | "lasso" | "eyedrop" | "blur" | "clone";
export type Pixels = { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
export type Adjust = { brightness: number; contrast: number; saturation: number; hue: number };

export const ADJUST_ZERO: Adjust = { brightness: 0, contrast: 0, saturation: 0, hue: 0 };
/** 油漆桶颜色容差（每个通道允许的差值，0~255）。 */
export const FILL_TOLERANCE = 32;

export function isAdjusted(a: Adjust) {
  return a.brightness !== 0 || a.contrast !== 0 || a.saturation !== 0 || a.hue !== 0;
}

/** 亮度 / 对比度 / 饱和度 -100~100，色相 -180~180，转成 CSS / canvas filter。 */
export function adjustFilter(a: Adjust) {
  const k = (v: number) => (1 + Math.max(-100, Math.min(100, v)) / 100).toFixed(2);
  return `brightness(${k(a.brightness)}) contrast(${k(a.contrast)}) saturate(${k(a.saturation)}) hue-rotate(${Math.round(a.hue)}deg)`;
}

export function selBox(sel: Sel): Box {
  if (sel.kind === "rect") return { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
  const xs = sel.pts.map((p) => p.x);
  const ys = sel.pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function selContains(sel: Sel, p: Pt) {
  if (sel.kind === "rect") return p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h;
  let inside = false;
  const pts = sel.pts;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 太小的选区当作没选。 */
export function validSel(sel: Sel | null, min = 3): Sel | null {
  if (!sel) return null;
  if (sel.kind === "lasso") return sel.pts.length >= 3 && selBox(sel).w >= min && selBox(sel).h >= min ? sel : null;
  return sel.w >= min && sel.h >= min ? sel : null;
}

export function selPath(sel: Sel): Path2D {
  const path = new Path2D();
  if (sel.kind === "rect") {
    path.rect(sel.x, sel.y, sel.w, sel.h);
  } else {
    sel.pts.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    path.closePath();
  }
  return path;
}

/** 从 (sx, sy) 起按颜色容差做洪泛，返回命中像素的 0/1 标记。 */
export function floodRegion(src: Pixels, sx: number, sy: number, tol: number): Uint8Array {
  const { data, width: w, height: h } = src;
  const out = new Uint8Array(w * h);
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return out;
  const o0 = (y0 * w + x0) * 4;
  const r = data[o0];
  const g = data[o0 + 1];
  const b = data[o0 + 2];
  const a = data[o0 + 3];
  const hit = (i: number) => {
    const o = i * 4;
    return Math.abs(data[o] - r) <= tol && Math.abs(data[o + 1] - g) <= tol && Math.abs(data[o + 2] - b) <= tol && Math.abs(data[o + 3] - a) <= tol;
  };
  const free = (i: number) => out[i] === 0 && hit(i);
  const stack: number[] = [x0, y0];
  while (stack.length) {
    const y = stack.pop() as number;
    let x = stack.pop() as number;
    while (x >= 0 && free(y * w + x)) x--;
    x++;
    let up = false;
    let down = false;
    for (; x < w && free(y * w + x); x++) {
      out[y * w + x] = 1;
      if (y > 0) {
        const ok = free((y - 1) * w + x);
        if (ok && !up) stack.push(x, y - 1);
        up = ok;
      }
      if (y < h - 1) {
        const ok = free((y + 1) * w + x);
        if (ok && !down) stack.push(x, y + 1);
        down = ok;
      }
    }
  }
  return out;
}

/** 向外扩 1 像素，盖住抗锯齿边缘留下的白边。 */
export function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = mask.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) continue;
      if ((x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) || (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w])) out[i] = 1;
    }
  }
  return out;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

/** 在 p 处盖一个笔尖。圆形笔尖走描边，其余笔尖都是沿路径连续盖章。 */
export function dab(ctx: CanvasRenderingContext2D, p: Pt, size: number, tip: Tip, rgb: [number, number, number], erase: boolean) {
  ctx.save();
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  const [r, g, b] = rgb;
  if (tip === "soft") {
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size / 2);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.55)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (tip === "square") {
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
  } else if (tip === "slash") {
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.translate(p.x, p.y);
    ctx.rotate(-Math.PI / 4);
    ctx.fillRect(-size / 2, -size / 6, size, size / 3);
  } else {
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 从 a 画到 b。 */
export function stroke(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, size: number, tip: Tip, rgb: [number, number, number], erase: boolean) {
  if (tip === "round") {
    ctx.save();
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = `rgb(${rgb.join(",")})`;
    ctx.lineWidth = size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const gap = Math.max(1, size * (tip === "soft" ? 0.12 : 0.18));
  const n = Math.max(1, Math.ceil(dist / gap));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    dab(ctx, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, size, tip, rgb, erase);
  }
}
