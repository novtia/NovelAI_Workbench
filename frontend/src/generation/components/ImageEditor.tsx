import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { triggerBlobDownload } from "@/data";
import {
  ADJUST_ZERO,
  FILL_TOLERANCE,
  adjustFilter,
  dab,
  dilate,
  floodRegion,
  hexToRgb,
  isAdjusted,
  rgbToHex,
  selBox,
  selContains,
  selPath,
  stroke as strokeSegment,
  validSel,
  type Adjust,
  type EditorTool,
  type Pt,
  type Sel,
  type Tip,
} from "@/data/imageEditor";
import type { EditorMode } from "@/data/types";
import { pushToast, useStudioActions, useStudioStore } from "@/state";
import { AdjustPanel } from "./editor/AdjustPanel";
import { EditorToolbar } from "./editor/EditorToolbar";
import { EditorTopBar } from "./editor/EditorTopBar";

type Layer = "paint" | "mask";
type Entry = { layer: Layer; data: ImageData };
/** 浮在画布上、还没落下的一块图（复制出来的选区，或刚导入的图片）。 */
type Floating = { src: HTMLCanvasElement; x: number; y: number; persistent: boolean };
type Gesture =
  | { kind: "stroke"; layer: Layer; tool: EditorTool; last: Pt; before: ImageData; blurred?: HTMLCanvasElement }
  | { kind: "marquee"; start: Pt }
  | { kind: "lasso"; pts: Pt[] }
  | { kind: "float"; dx: number; dy: number; commitOnUp: boolean };

const MAX_HISTORY = 20;
const MASK_RGB: [number, number, number] = [255, 59, 48];
const DRAW_ONLY: EditorTool[] = ["eyedrop", "blur", "clone"];

function toBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("导出图片失败"))), "image/png");
  });
}

function hasAlpha(data: ImageData, threshold = 0) {
  const px = data.data;
  for (let i = 3; i < px.length; i += 4) if (px[i] > threshold) return true;
  return false;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("无法读取图片"));
    img.src = src;
  });
}

function newCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** 浮动块：画到自己的 canvas 上，位置和大小由父级按百分比摆。 */
function FloatLayer({ f, dim }: { f: Floating; dim: { w: number; h: number } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = f.src.width;
    c.height = f.src.height;
    c.getContext("2d")?.drawImage(f.src, 0, 0);
  }, [f.src]);
  return (
    <canvas
      ref={ref}
      className={`ied-layer ied-float${f.persistent ? " persistent" : ""}`}
      style={{
        inset: "auto",
        left: `${(f.x / dim.w) * 100}%`,
        top: `${(f.y / dim.h) * 100}%`,
        width: `${(f.src.width / dim.w) * 100}%`,
        height: `${(f.src.height / dim.h) * 100}%`,
      }}
    />
  );
}

function SelShape({ sel }: { sel: Sel }) {
  const common = { className: "ied-ants", fill: "none", vectorEffect: "non-scaling-stroke" as const };
  return sel.kind === "rect" ? (
    <rect x={sel.x} y={sel.y} width={sel.w} height={sel.h} {...common} />
  ) : (
    <polygon points={sel.pts.map((p) => `${p.x},${p.y}`).join(" ")} {...common} />
  );
}

/** 全屏图片编辑器：官方那套画笔 / 橡皮 / 填充 / 选区 / 套索 / 吸管 / 模糊 / 复制 / 调整 / 导入。Save & Close 把结果回写成图生图底图和蒙版。 */
export function ImageEditor() {
  const mode = useStudioStore((s) => s.editor);
  const hasBase = useStudioStore((s) => Boolean(s.i2i));
  return mode && hasBase ? <EditorBody initialMode={mode} /> : null;
}

function EditorBody({ initialMode }: { initialMode: EditorMode }) {
  const i2i = useStudioStore((s) => s.i2i)!;
  const setEditor = useStudioStore((s) => s.setEditor);
  const { saveEditor } = useStudioActions();

  const [mode, setMode] = useState<EditorMode>(initialMode);
  const [tool, setTool] = useState<EditorTool>("pen");
  const [tip, setTip] = useState<Tip>("round");
  const [size, setSize] = useState(20);
  const [color, setColor] = useState("#000000");
  const [dim, setDim] = useState({ w: 0, h: 0 });
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [sel, setSelState] = useState<Sel | null>(null);
  const [draft, setDraft] = useState<Sel | null>(null);
  const [float, setFloatState] = useState<Floating | null>(null);
  const [adjust, setAdjust] = useState<Adjust>(ADJUST_ZERO);
  const [adjustOpen, setAdjustOpen] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const hitRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const paintRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const stacks = useRef<{ undo: Entry[]; redo: Entry[] }>({ undo: [], redo: [] });
  const gesture = useRef<Gesture | null>(null);
  // 事件回调里要读最新值，状态同步镜像一份到 ref。
  const selRef = useRef<Sel | null>(null);
  const floatRef = useRef<Floating | null>(null);

  const maskMode = mode === "mask";
  const layer: Layer = maskMode ? "mask" : "paint";

  const setSel = (next: Sel | null) => {
    selRef.current = next;
    setSelState(next);
  };
  const setFloat = (next: Floating | null) => {
    floatRef.current = next;
    setFloatState(next);
  };

  const ctxOf = useCallback((l: Layer) => (l === "mask" ? maskRef : paintRef).current?.getContext("2d", { willReadFrequently: true }) ?? null, []);
  const sync = useCallback(() => setHist({ undo: stacks.current.undo.length, redo: stacks.current.redo.length }), []);

  // 加载底图（和已有蒙版）
  useEffect(() => {
    let alive = true;
    loadImage(i2i.url)
      .then((img) => {
        if (!alive) return;
        imgRef.current = img;
        setDim({ w: img.naturalWidth, h: img.naturalHeight });
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
    // 只在打开时读一次底图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 画布有了尺寸后，把已有蒙版（黑白图）转成红色选区画到蒙版层
  useEffect(() => {
    if (!dim.w || !i2i.maskUrl) return;
    let alive = true;
    loadImage(i2i.maskUrl)
      .then((img) => {
        if (!alive) return;
        const tmp = newCanvas(dim.w, dim.h);
        const t = tmp.getContext("2d", { willReadFrequently: true });
        const ctx = ctxOf("mask");
        if (!t || !ctx) return;
        t.drawImage(img, 0, 0, dim.w, dim.h);
        const src = t.getImageData(0, 0, dim.w, dim.h);
        const out = ctx.createImageData(dim.w, dim.h);
        for (let i = 0; i < src.data.length; i += 4) {
          if (src.data[i] > 127) {
            out.data[i] = MASK_RGB[0];
            out.data[i + 1] = MASK_RGB[1];
            out.data[i + 2] = MASK_RGB[2];
            out.data[i + 3] = 255;
          }
        }
        ctx.putImageData(out, 0, 0);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dim.w, dim.h]);

  // 让画板按窗口大小等比缩放
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || !dim.w) return;
    const calc = () => {
      const pad = 24;
      const sw = Math.max(80, el.clientWidth - pad * 2);
      const sh = Math.max(80, el.clientHeight - pad * 2);
      const k = Math.min(sw / dim.w, sh / dim.h);
      setFit({ w: Math.floor(dim.w * k), h: Math.floor(dim.h * k) });
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dim.w, dim.h]);

  // ---------- 撤销 / 重做 ----------
  function pushUndo(l: Layer, before: ImageData) {
    const s = stacks.current;
    s.undo.push({ layer: l, data: before });
    if (s.undo.length > MAX_HISTORY) s.undo.shift();
    s.redo = [];
    sync();
  }

  function swap(from: "undo" | "redo", to: "undo" | "redo") {
    const s = stacks.current;
    const e = s[from].pop();
    if (!e) return;
    const ctx = ctxOf(e.layer);
    if (!ctx) return;
    s[to].push({ layer: e.layer, data: ctx.getImageData(0, 0, dim.w, dim.h) });
    ctx.putImageData(e.data, 0, 0);
    sync();
  }

  const undo = () => {
    if (floatRef.current) return cancelFloat();
    swap("undo", "redo");
  };
  const redo = () => swap("redo", "undo");

  // ---------- 通用小工具 ----------
  /** 底图 + 涂画层合成后的整图（蒙版层不算）。 */
  function composite(): HTMLCanvasElement | null {
    const base = imgRef.current;
    const paint = paintRef.current;
    if (!base || !paint) return null;
    const c = newCanvas(dim.w, dim.h);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(base, 0, 0, dim.w, dim.h);
    ctx.drawImage(paint, 0, 0);
    return c;
  }

  const paintRgb = (): [number, number, number] => (maskMode ? MASK_RGB : hexToRgb(color));

  function clipSel(ctx: CanvasRenderingContext2D) {
    const s = selRef.current;
    if (s) ctx.clip(selPath(s));
  }

  function toPoint(e: ReactPointerEvent): { p: Pt; k: number } {
    const rect = hitRef.current!.getBoundingClientRect();
    const k = dim.w / Math.max(1, rect.width);
    return { p: { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k }, k };
  }

  function chooseTool(next: EditorTool) {
    if (maskMode && DRAW_ONLY.includes(next)) return;
    commitFloat();
    setTool(next);
  }

  function chooseMode(mask: boolean) {
    commitFloat();
    setMode(mask ? "mask" : "draw");
    setAdjustOpen(false);
    setAdjust(ADJUST_ZERO);
    if (mask && DRAW_ONLY.includes(tool)) setTool("pen");
  }

  // ---------- 浮动块（复制 / 导入） ----------
  function commitFloat() {
    const f = floatRef.current;
    if (!f) return;
    const ctx = ctxOf("paint");
    if (ctx) {
      const before = ctx.getImageData(0, 0, dim.w, dim.h);
      ctx.drawImage(f.src, Math.round(f.x), Math.round(f.y));
      pushUndo("paint", before);
    }
    setFloat(null);
  }

  function cancelFloat() {
    setFloat(null);
  }

  function moveFloat(x: number, y: number) {
    const f = floatRef.current;
    if (f) setFloat({ ...f, x, y });
  }

  /** 把选区里的内容复制成浮动块，停在原位。 */
  function copySelection(s: Sel): Floating | null {
    const all = composite();
    if (!all) return null;
    const box = selBox(s);
    const bx = Math.max(0, Math.floor(box.x));
    const by = Math.max(0, Math.floor(box.y));
    const bw = Math.min(dim.w - bx, Math.ceil(box.w));
    const bh = Math.min(dim.h - by, Math.ceil(box.h));
    if (bw < 1 || bh < 1) return null;
    const c = newCanvas(bw, bh);
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.translate(-bx, -by);
    ctx.clip(selPath(s));
    ctx.drawImage(all, 0, 0);
    return { src: c, x: bx, y: by, persistent: false };
  }

  async function importFile(file: File) {
    if (!file.type.startsWith("image/")) {
      pushToast("只能导入图片", "warn");
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      commitFloat();
      const k = Math.min(1, dim.w / img.naturalWidth, dim.h / img.naturalHeight);
      const c = newCanvas(img.naturalWidth * k, img.naturalHeight * k);
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      setFloat({ src: c, x: Math.round((dim.w - c.width) / 2), y: Math.round((dim.h - c.height) / 2), persistent: true });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "导入失败", "warn");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** 导入的图铺满整个画面（等比裁切）。 */
  async function coverFloat() {
    const f = floatRef.current;
    if (!f) return;
    const k = Math.max(dim.w / f.src.width, dim.h / f.src.height);
    const c = newCanvas(dim.w, dim.h);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dw = f.src.width * k;
    const dh = f.src.height * k;
    ctx.drawImage(f.src, (dim.w - dw) / 2, (dim.h - dh) / 2, dw, dh);
    setFloat({ src: c, x: 0, y: 0, persistent: true });
  }

  // ---------- 清空 / 反选 ----------
  function clearLayer() {
    const ctx = ctxOf(layer);
    if (!ctx) return;
    pushUndo(layer, ctx.getImageData(0, 0, dim.w, dim.h));
    const s = selRef.current;
    if (s) {
      ctx.save();
      ctx.clip(selPath(s));
      ctx.clearRect(0, 0, dim.w, dim.h);
      ctx.restore();
    } else {
      ctx.clearRect(0, 0, dim.w, dim.h);
    }
  }

  function invertMask() {
    const ctx = ctxOf("mask");
    if (!ctx) return;
    const before = ctx.getImageData(0, 0, dim.w, dim.h);
    const next = ctx.createImageData(dim.w, dim.h);
    for (let i = 0; i < before.data.length; i += 4) {
      if (before.data[i + 3] <= 127) {
        next.data[i] = MASK_RGB[0];
        next.data[i + 1] = MASK_RGB[1];
        next.data[i + 2] = MASK_RGB[2];
        next.data[i + 3] = 255;
      }
    }
    pushUndo("mask", before);
    ctx.putImageData(next, 0, 0);
  }

  // ---------- 调整 ----------
  function applyAdjust() {
    const all = composite();
    const ctx = ctxOf("paint");
    if (!all || !ctx) return;
    const out = newCanvas(dim.w, dim.h);
    const octx = out.getContext("2d");
    if (!octx) return;
    octx.filter = adjustFilter(adjust);
    octx.drawImage(all, 0, 0);
    pushUndo("paint", ctx.getImageData(0, 0, dim.w, dim.h));
    ctx.save();
    clipSel(ctx);
    ctx.drawImage(out, 0, 0);
    ctx.restore();
    setAdjust(ADJUST_ZERO);
    setAdjustOpen(false);
  }

  // ---------- 填充 ----------
  function fillAt(p: Pt) {
    const ctx = ctxOf(layer);
    if (!ctx) return;
    const before = ctx.getImageData(0, 0, dim.w, dim.h);
    const [r, g, b] = paintRgb();
    const s = selRef.current;
    const tmp = newCanvas(dim.w, dim.h);
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    if (s && selContains(s, p)) {
      // 点在选区里：直接把整个选区填满
      tctx.fillStyle = `rgb(${r},${g},${b})`;
      tctx.fillRect(0, 0, dim.w, dim.h);
    } else {
      const source = maskMode ? before : composite()?.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, dim.w, dim.h);
      if (!source) return;
      const region = dilate(floodRegion(source, p.x, p.y, FILL_TOLERANCE), dim.w, dim.h);
      const fillData = tctx.createImageData(dim.w, dim.h);
      for (let i = 0; i < region.length; i++) {
        if (!region[i]) continue;
        const o = i * 4;
        fillData.data[o] = r;
        fillData.data[o + 1] = g;
        fillData.data[o + 2] = b;
        fillData.data[o + 3] = 255;
      }
      tctx.putImageData(fillData, 0, 0);
    }
    pushUndo(layer, before);
    ctx.save();
    clipSel(ctx);
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
  }

  // ---------- 吸管 ----------
  function pickColor(p: Pt) {
    const all = composite();
    const data = all?.getContext("2d", { willReadFrequently: true })?.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
    if (!data) return;
    setColor(rgbToHex(data[0], data[1], data[2]));
    setTool("pen");
  }

  // ---------- 画笔 / 橡皮 / 模糊 ----------
  function brushSegment(g: Extract<Gesture, { kind: "stroke" }>, ctx: CanvasRenderingContext2D, a: Pt, b: Pt, k: number, dot: boolean) {
    const px = size * k;
    ctx.save();
    clipSel(ctx);
    if (g.tool === "blur" && g.blurred) {
      const dist = dot ? 0 : Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(dist / Math.max(1, px * 0.2)));
      for (let i = 1; i <= n; i++) {
        const t = dot ? 1 : i / n;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, px / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(g.blurred, 0, 0);
        ctx.restore();
      }
    } else if (dot) {
      dab(ctx, b, px, tip, paintRgb(), g.tool === "eraser");
    } else {
      strokeSegment(ctx, a, b, px, tip, paintRgb(), g.tool === "eraser");
    }
    ctx.restore();
  }

  // ---------- 指针事件 ----------
  function onDown(e: ReactPointerEvent) {
    if (e.button !== 0 || !dim.w) return;
    const { p, k } = toPoint(e);
    const f = floatRef.current;
    if (f?.persistent) {
      // 导入的图还没放下：在它身上拖动来摆位置
      if (p.x >= f.x && p.x <= f.x + f.src.width && p.y >= f.y && p.y <= f.y + f.src.height) {
        e.currentTarget.setPointerCapture(e.pointerId);
        gesture.current = { kind: "float", dx: p.x - f.x, dy: p.y - f.y, commitOnUp: false };
      }
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === "pen" || tool === "eraser" || tool === "blur") {
      const ctx = ctxOf(layer);
      if (!ctx) return;
      const before = ctx.getImageData(0, 0, dim.w, dim.h);
      const g: Extract<Gesture, { kind: "stroke" }> = { kind: "stroke", layer, tool, last: p, before };
      if (tool === "blur") {
        const all = composite();
        if (!all) return;
        const blurred = newCanvas(dim.w, dim.h);
        const bctx = blurred.getContext("2d");
        if (!bctx) return;
        bctx.filter = `blur(${Math.max(2, Math.round((size * k) / 6))}px)`;
        bctx.drawImage(all, 0, 0);
        g.blurred = blurred;
      }
      gesture.current = g;
      brushSegment(g, ctx, p, p, k, true);
    } else if (tool === "fill") {
      fillAt(p);
    } else if (tool === "eyedrop") {
      pickColor(p);
    } else if (tool === "marquee") {
      gesture.current = { kind: "marquee", start: p };
      setDraft({ kind: "rect", x: p.x, y: p.y, w: 0, h: 0 });
    } else if (tool === "lasso") {
      gesture.current = { kind: "lasso", pts: [p] };
      setDraft({ kind: "lasso", pts: [p] });
    } else if (tool === "clone") {
      const s = selRef.current;
      if (!s) {
        pushToast("先用矩形选区或套索框住要复制的地方", "warn");
        return;
      }
      if (!selContains(s, p)) return;
      const copy = copySelection(s);
      if (!copy) return;
      setFloat(copy);
      gesture.current = { kind: "float", dx: p.x - copy.x, dy: p.y - copy.y, commitOnUp: true };
    }
  }

  function moveRing(e: ReactPointerEvent) {
    const ring = ringRef.current;
    const hit = hitRef.current;
    if (!ring || !hit) return;
    const rect = hit.getBoundingClientRect();
    ring.style.transform = `translate(${e.clientX - rect.left - size / 2}px, ${e.clientY - rect.top - size / 2}px)`;
    ring.style.opacity = "1";
  }

  function onMove(e: ReactPointerEvent) {
    moveRing(e);
    const g = gesture.current;
    if (!g) return;
    const { p, k } = toPoint(e);
    if (g.kind === "stroke") {
      const ctx = ctxOf(g.layer);
      if (!ctx) return;
      brushSegment(g, ctx, g.last, p, k, false);
      g.last = p;
    } else if (g.kind === "marquee") {
      const x = Math.max(0, Math.min(g.start.x, p.x));
      const y = Math.max(0, Math.min(g.start.y, p.y));
      setDraft({ kind: "rect", x, y, w: Math.min(dim.w, Math.max(g.start.x, p.x)) - x, h: Math.min(dim.h, Math.max(g.start.y, p.y)) - y });
    } else if (g.kind === "lasso") {
      g.pts.push({ x: Math.max(0, Math.min(dim.w, p.x)), y: Math.max(0, Math.min(dim.h, p.y)) });
      setDraft({ kind: "lasso", pts: [...g.pts] });
    } else if (g.kind === "float") {
      moveFloat(p.x - g.dx, p.y - g.dy);
    }
  }

  function onUp() {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "stroke") {
      pushUndo(g.layer, g.before);
    } else if (g.kind === "marquee" || g.kind === "lasso") {
      setSel(validSel(draft));
      setDraft(null);
    } else if (g.kind === "float" && g.commitOnUp) {
      commitFloat();
    }
  }

  // ---------- 导出 / 保存 ----------
  async function exportPng() {
    commitFloat();
    const all = composite();
    if (!all) return;
    try {
      triggerBlobDownload(await toBlob(all), `edit-${Date.now()}.png`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "导出失败", "warn");
    }
  }

  async function save() {
    commitFloat();
    const base = imgRef.current;
    const pctx = ctxOf("paint");
    const mctx = ctxOf("mask");
    if (!base || !pctx || !mctx || saving) return;
    setSaving(true);
    try {
      let image: Blob | null = null;
      if (hasAlpha(pctx.getImageData(0, 0, dim.w, dim.h))) {
        const all = composite();
        if (all) image = await toBlob(all);
      }
      const md = mctx.getImageData(0, 0, dim.w, dim.h);
      let mask: Blob | null = null;
      if (hasAlpha(md, 127)) {
        const c = newCanvas(dim.w, dim.h);
        const ctx = c.getContext("2d")!;
        const out = ctx.createImageData(dim.w, dim.h);
        for (let i = 0; i < md.data.length; i += 4) {
          const v = md.data[i + 3] > 127 ? 255 : 0;
          out.data[i] = v;
          out.data[i + 1] = v;
          out.data[i + 2] = v;
          out.data[i + 3] = 255;
        }
        ctx.putImageData(out, 0, 0);
        mask = await toBlob(c);
      }
      await saveEditor({ image, mask, clearMask: !mask });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "保存失败", "warn");
    } finally {
      setSaving(false);
    }
  }

  // 快捷键：Esc 一层层退出，Enter 放下浮动块，Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 撤销重做
  const keyRef = useRef({ undo, redo, commitFloat });
  keyRef.current = { undo, redo, commitFloat };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (floatRef.current) setFloat(null);
        else if (adjustOpenRef.current) setAdjustOpen(false);
        else if (selRef.current) setSel(null);
        else setEditor(null);
        return;
      }
      if (e.key === "Enter" && floatRef.current && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        keyRef.current.commitFloat();
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) keyRef.current.redo();
        else keyRef.current.undo();
      } else if (k === "y") {
        e.preventDefault();
        keyRef.current.redo();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setEditor]);
  const adjustOpenRef = useRef(false);
  adjustOpenRef.current = adjustOpen;

  const shownSel = draft || sel;
  const brushTool = tool === "pen" || tool === "eraser" || tool === "blur";
  const hitCursor = float?.persistent ? "move" : tool === "eyedrop" ? "copy" : brushTool ? "none" : "crosshair";

  return (
    <div className="ied" role="dialog" aria-label="编辑图片" onClick={(e) => e.stopPropagation()}>
      <EditorTopBar
        maskMode={maskMode}
        onMode={chooseMode}
        color={color}
        onColor={setColor}
        eyedropOn={tool === "eyedrop"}
        onEyedrop={() => chooseTool("eyedrop")}
        size={size}
        onSize={setSize}
        tip={tip}
        onTip={setTip}
        saving={saving}
        ready={Boolean(dim.w)}
        onExport={() => void exportPng()}
        onSave={() => void save()}
        onClose={() => setEditor(null)}
      />

      <div className="ied-stage" ref={stageRef}>
        {error ? <p className="ied-error">{error}</p> : null}
        {!dim.w && !error ? <p className="ied-error">载入中…</p> : null}
        {float?.persistent ? (
          <div className="ied-floatbar">
            <span>拖动调整位置</span>
            <button className="btn btn-primary" type="button" onClick={commitFloat}>
              放入
            </button>
            <button className="i2i-mini" type="button" onClick={() => void coverFloat()}>
              铺满
            </button>
            <button className="i2i-mini" type="button" onClick={cancelFloat}>
              取消
            </button>
          </div>
        ) : null}
        {dim.w ? (
          <div className="ied-board" style={{ width: fit.w, height: fit.h }}>
            <div className="ied-comp" style={isAdjusted(adjust) ? { filter: adjustFilter(adjust) } : undefined}>
              <img className="ied-img" src={i2i.url} alt="" draggable={false} />
              <canvas ref={paintRef} className="ied-layer" width={dim.w} height={dim.h} />
            </div>
            <canvas ref={maskRef} className="ied-layer ied-mask" width={dim.w} height={dim.h} style={{ opacity: maskMode ? 0.6 : 0.3 }} />
            {float ? <FloatLayer f={float} dim={dim} /> : null}
            <svg className="ied-sel" viewBox={`0 0 ${dim.w} ${dim.h}`} preserveAspectRatio="none">
              {shownSel ? <SelShape sel={shownSel} /> : null}
            </svg>
            {brushTool && !float?.persistent ? <div ref={ringRef} className="ied-ring" style={{ width: size, height: size }} /> : null}
            <div
              ref={hitRef}
              className="ied-hit"
              style={{ cursor: hitCursor }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onPointerLeave={() => {
                if (ringRef.current) ringRef.current.style.opacity = "0";
              }}
            />
          </div>
        ) : null}
        {adjustOpen ? (
          <AdjustPanel
            value={adjust}
            hasSel={Boolean(sel)}
            onChange={setAdjust}
            onApply={applyAdjust}
            onClose={() => {
              setAdjust(ADJUST_ZERO);
              setAdjustOpen(false);
            }}
          />
        ) : null}
      </div>

      <EditorToolbar
        maskMode={maskMode}
        tool={tool}
        onTool={chooseTool}
        hasSel={Boolean(sel)}
        adjustOn={adjustOpen}
        onAdjust={() => {
          commitFloat();
          if (adjustOpen) setAdjust(ADJUST_ZERO);
          setAdjustOpen(!adjustOpen);
        }}
        onClear={clearLayer}
        onImport={() => fileRef.current?.click()}
        onInvert={invertMask}
        canUndo={Boolean(hist.undo) || Boolean(float)}
        canRedo={Boolean(hist.redo)}
        onUndo={undo}
        onRedo={redo}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importFile(file);
        }}
      />
    </div>
  );
}
