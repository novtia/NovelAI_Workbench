/**
 * 深色/浅色切换时的「水墨扩散」动画。
 *
 * 一张泼墨形状的遮罩图（边缘毛糙、带飞白和溅点）从点击处放大到铺满全屏，它同时驱动三样东西，所以边缘是同一条线：
 * 1. 背景活墨的 WebGL 着色器（ui/inkFluid.ts + ui/themeWipe.ts）：遮罩之内画新主题的墨、之外画旧主题的墨，
 *    前沿上再画一圈湿墨边，前沿还会随流动的墨轻轻起伏。画布是实时画面，背景的墨全程都在流动；
 * 2. 界面 #app：用 View Transitions 拍新旧两张图，新图套这张遮罩盖在旧图上——界面和背景在同一时刻、同一条边缘换色；
 * 3. 纸面/纸纹等静态背景层：同上（View Transitions 的 root）。
 *
 * 扩散途中再点一次切换按钮，墨迹沿原路倒退收回；墨迹铺满（或收回到零）的那一帧过渡立即结束，页面马上可以操作。
 *
 * 不支持 View Transitions、开启了「减少动效」时，直接切换。
 */

import { themeWipe, wipeProgress, wipeSize } from "./themeWipe";

type VT = { ready: Promise<void>; finished: Promise<void>; skipTransition: () => void };
type DocWithVT = Document & { startViewTransition?: (cb: () => void | Promise<void>) => VT };

/** 一次切换：从点击开始，到过渡结束（铺满或收回）为止 */
type Session = {
  /** 浏览器是否已经调用过更新回调（之后界面的实际主题 = 当前方向的目标主题） */
  updated: boolean;
  /** 更新回调之前又点了一次：撤销这次切换 */
  cancelled: boolean;
};

let session: Session | null = null;
/** 过渡结束后的两帧收尾；新的切换要等它做完 */
let settling: Promise<void> | null = null;
let blotPromise: Promise<{ url: string; canvas: HTMLCanvasElement }> | null = null;

/** 泼墨遮罩：一个被噪声层层扭曲的圆（中心全实，外缘毛糙、带细碎飞白和溅出的墨点），只用到 alpha 通道。 */
function blotSvg(N: number) {
  const c = N / 2;
  const R = N * 0.29;
  const drops = [
    [0.84, 0.31, 0.022],
    [0.15, 0.42, 0.018],
    [0.62, 0.9, 0.024],
    [0.36, 0.1, 0.016],
    [0.93, 0.62, 0.014],
    [0.07, 0.72, 0.02],
    [0.78, 0.12, 0.012],
    [0.5, 0.97, 0.014],
  ]
    .map(([x, y, r]) => `<circle cx="${x * N}" cy="${y * N}" r="${r * N}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">
  <filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.0055" numOctaves="3" seed="14" result="n1"/>
    <feDisplacementMap in="SourceGraphic" in2="n1" scale="${N * 0.15}" xChannelSelector="R" yChannelSelector="G" result="d1"/>
    <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="3" seed="5" result="n2"/>
    <feDisplacementMap in="d1" in2="n2" scale="${N * 0.045}" xChannelSelector="G" yChannelSelector="B" result="d2"/>
    <feTurbulence type="fractalNoise" baseFrequency="0.35" numOctaves="2" seed="9" result="n3"/>
    <feDisplacementMap in="d2" in2="n3" scale="${N * 0.012}" xChannelSelector="B" yChannelSelector="R" result="d3"/>
    <feGaussianBlur in="d3" stdDeviation="${N * 0.0025}"/>
  </filter>
  <g filter="url(#f)" fill="#fff"><circle cx="${c}" cy="${c}" r="${R}"/>${drops}</g>
</svg>`;
}

/** 生成遮罩（只做一次）：返回给 CSS 用的 blob 地址，和给着色器上传纹理用的画布。 */
function prepareBlot() {
  if (blotPromise) return blotPromise;
  blotPromise = (async () => {
    const N = 1024;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(blotSvg(N))}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.drawImage(img, 0, 0, N, N);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("blob");
    return { url: URL.createObjectURL(blob), canvas };
  })();
  blotPromise.catch(() => {
    blotPromise = null;
  });
  return blotPromise;
}

/** 空闲时预生成遮罩，点击时不用等。 */
export function warmUpInkSwitch() {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  const run = () => void prepareBlot().catch(() => {});
  if (idle) idle(run);
  else setTimeout(run, 1500);
}

const DURATION = 1000;
const VARS = ["--ink-blot", "--ink-x", "--ink-y", "--ink-s"];

/**
 * 从切换按钮 trigger 的中心开始让墨迹扩散并切换主题；apply() 里真正修改主题设置，并且要同步生效（调用方用 flushSync 包一层）。
 * 扩散途中再次调用：墨迹倒退，apply() 把主题改回去。
 */
export function inkSwitchTheme(trigger: HTMLElement, apply: () => void) {
  const root = document.documentElement;
  const doc = document as DocWithVT;
  const prefersReduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduce || root.dataset.motion === "reduce" || typeof doc.startViewTransition !== "function") {
    apply();
    return;
  }
  if (session) {
    reverse(session, apply);
    return;
  }
  const s: Session = { updated: false, cancelled: false };
  session = s;
  void run(s, trigger, apply);
}

function reverse(s: Session, apply: () => void) {
  if (!s.updated) {
    s.cancelled = !s.cancelled;
    return;
  }
  const now = performance.now();
  themeWipe.p0 = wipeProgress(now);
  if (Number.isFinite(themeWipe.t0)) themeWipe.t0 = now;
  themeWipe.dir = themeWipe.dir > 0 ? -1 : 1;
  // 过渡没结束前真实页面不显示，这里改主题看不出来；墨迹收回到零的那一刻，真实页面正好是旧主题
  apply();
}

async function run(s: Session, trigger: HTMLElement, apply: () => void) {
  const root = document.documentElement;
  const doc = document as DocWithVT;
  const rect = trigger.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  let blot: Awaited<ReturnType<typeof prepareBlot>>;
  try {
    if (settling) await settling;
    blot = await prepareBlot();
  } catch {
    session = null;
    if (!s.cancelled) apply();
    return;
  }
  if (s.cancelled) {
    session = null;
    return;
  }

  const from = root.dataset.theme === "dark" ? "dark" : "light";
  const to = from === "dark" ? "light" : "dark";
  const farthest = Math.max(
    Math.hypot(x, y),
    Math.hypot(window.innerWidth - x, y),
    Math.hypot(x, window.innerHeight - y),
    Math.hypot(window.innerWidth - x, window.innerHeight - y),
  );
  // 遮罩图里半径 0.186 倍边长以内一定是实心的，再扣掉着色器里前沿的起伏：放大到这个尺寸恰好盖住最远的角
  const sizeEnd = farthest / 0.17 + 40;

  // 交给着色器：同一张遮罩、同一个中心、同一条进度曲线（wipeSize）
  if (themeWipe.source !== blot.canvas) {
    themeWipe.source = blot.canvas;
    themeWipe.sourceVersion++;
  }
  Object.assign(themeWipe, { x, y, sizeEnd, duration: DURATION, from, to, t0: Number.POSITIVE_INFINITY, p0: 0, dir: 1 });
  themeWipe.active = true;

  root.style.setProperty("--ink-blot", `url("${blot.url}")`);
  root.style.setProperty("--ink-x", `${x}px`);
  root.style.setProperty("--ink-y", `${y}px`);
  root.style.setProperty("--ink-s", "1px");
  root.classList.add("ink-running");

  // 过渡期间浏览器把所有点击都交给 <html>（过渡层不让点击穿透，pointer-events 也不管用），
  // 按坐标认出落在切换按钮上的点击，转给真实按钮——再点一次 = 墨迹倒退
  const onOverlayClick = (e: MouseEvent) => {
    if (e.target !== root) return;
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
    e.preventDefault();
    e.stopPropagation();
    trigger.click();
  };
  window.addEventListener("click", onOverlayClick, true);

  try {
    const vt = doc.startViewTransition!(() => {
      s.updated = true;
      if (s.cancelled) themeWipe.dir = -1;
      else apply();
    });
    try {
      await vt.ready;
      themeWipe.t0 = performance.now();
      const tick = (now: number) => {
        if (session !== s) return;
        root.style.setProperty("--ink-s", `${wipeSize(now)}px`);
        const p = wipeProgress(now);
        if ((themeWipe.dir > 0 && p >= 1) || (themeWipe.dir < 0 && p <= 0)) {
          session = null;
          vt.skipTransition();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // 伪元素上的动画都被关掉了，过渡会立刻结束；挂一个足够长的空动画撑住，由 tick 在铺满/收回时结束过渡
      root.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 3_600_000, pseudoElement: "::view-transition-new(root)" });
    } catch {
      /* 过渡没能开始：主题已经切换 */
    }
    await vt.finished;
  } catch {
    /* 动画被打断也无妨：主题已经切换 */
  } finally {
    window.removeEventListener("click", onOverlayClick, true);
    if (session === s) session = null;
    settling = settle();
  }
}

// 收尾分两帧：画布的墨色由着色器画（带主题色，不带 CSS 滤镜），回到平时要换成「浅色原墨 + CSS 滤镜」。
// 两者必须在同一帧生效，否则会有一帧深色墨被滤镜再反相一次（闪一下）。
// 第一帧：着色器改回平时的画法（着色器的 rAF 在我们前面，这一帧画布仍是主题墨）；
// 第二帧：着色器已画出平时的样子，这时再去掉 ink-running（滤镜回来），同帧显示。
function settle() {
  const root = document.documentElement;
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      themeWipe.active = false;
      requestAnimationFrame(() => {
        root.classList.remove("ink-running");
        for (const k of VARS) root.style.removeProperty(k);
        settling = null;
        resolve();
      });
    });
  });
}

