/**
 * 深色/浅色切换时的「水墨扩散」动画。
 *
 * 一张泼墨形状的遮罩图（ui/inkBlot.ts 用着色器程序化生成，每次形状不同）从点击处放大到铺满全屏，
 * 它同时驱动三样东西，所以边缘是同一条线：
 * 1. 背景活墨的 WebGL 着色器（ui/inkFluid.ts + ui/themeWipe.ts）：遮罩之内画新主题的墨、之外画旧主题的墨，
 *    前沿上再画一圈湿墨边，前沿还会随流动的墨轻轻起伏。画布是实时画面，背景的墨全程都在流动；
 * 2. 界面 #app：用 View Transitions 拍新旧两张图，新图套这张遮罩盖在旧图上——界面和背景在同一时刻、同一条边缘换色；
 * 3. 纸面/纸纹等静态背景层：同上（View Transitions 的 root）。
 *
 * 注意 ::view-transition-new(...) 是「实时画面」而不是静态截图：真实页面的主题一变，它马上跟着变。
 * 所以整个过渡期间真实主题固定在目标主题上不动（旧主题由那张静态的旧截图负责显示）；
 * 扩散途中再点一次切换按钮，墨迹沿原路倒退收回，收回到零的那一刻才把真实主题改回旧主题——
 * 此时旧截图已经铺满全屏，同一帧里换成真实页面，看不出任何跳变。
 * 墨迹铺满（或收回到零）的那一帧过渡立即结束，页面马上可以操作。
 *
 * 不支持 View Transitions、开启了「减少动效」时，直接切换。
 */

import { makeBlot, type Blot } from "./inkBlot";
import { themeWipe, wipeProgress, wipeSize, type ThemeName } from "./themeWipe";

type VT = { ready: Promise<void>; finished: Promise<void>; skipTransition: () => void };
type DocWithVT = Document & { startViewTransition?: (cb: () => void | Promise<void>) => VT };

/** 一次切换：从点击开始，到过渡结束（铺满或收回）为止 */
type Session = {
  from: ThemeName;
  to: ThemeName;
  /** 已经调用 startViewTransition（之后用进度的方向表示「现在是在铺开还是在收回」） */
  started: boolean;
  /** 还没开始过渡时又点了一次：撤销这次切换 */
  cancelled: boolean;
  /** 进度已走到头，正在结束过渡 */
  ending: boolean;
};

type SetTheme = (theme: ThemeName) => void;

let session: Session | null = null;
/** 过渡结束后的两帧收尾；新的切换要等它做完 */
let settling: Promise<void> | null = null;
/** 结束过渡的那一两帧里又点了一次：等收尾做完再开始新的切换 */
let queued: { trigger: HTMLElement; setTheme: SetTheme } | null = null;
/** 下一次切换要用的遮罩（提前生成好，点击时不用等） */
let nextBlot: Promise<Blot> | null = null;

function prepareBlot() {
  if (!nextBlot) {
    const p = makeBlot();
    nextBlot = p;
    p.catch(() => {
      if (nextBlot === p) nextBlot = null;
    });
  }
  return nextBlot;
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
 * 从切换按钮 trigger 的中心开始让墨迹扩散并切换主题；setTheme(t) 里真正修改主题设置，并且要同步生效（调用方用 flushSync 包一层）。
 * 扩散途中再次调用：墨迹倒退，收回到零时 setTheme 把主题改回去。
 */
export function inkSwitchTheme(trigger: HTMLElement, setTheme: SetTheme) {
  const root = document.documentElement;
  const doc = document as DocWithVT;
  const from: ThemeName = root.dataset.theme === "dark" ? "dark" : "light";
  const to: ThemeName = from === "dark" ? "light" : "dark";
  const prefersReduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduce || root.dataset.motion === "reduce" || typeof doc.startViewTransition !== "function") {
    setTheme(to);
    return;
  }
  if (session) {
    if (session.ending) queued = { trigger, setTheme };
    else reverse(session);
    return;
  }
  if (settling) {
    // 上一次的收尾还没做完：等它做完再开始
    queued = { trigger, setTheme };
    return;
  }
  const s: Session = { from, to, started: false, cancelled: false, ending: false };
  session = s;
  void run(s, trigger, setTheme);
}

function reverse(s: Session) {
  if (!s.started) {
    s.cancelled = !s.cancelled;
    return;
  }
  const now = performance.now();
  // 从当前进度出发，换个方向走；还没开始计时（t0 为无穷）时只记下方向
  themeWipe.p0 = wipeProgress(now);
  if (Number.isFinite(themeWipe.t0)) themeWipe.t0 = now;
  themeWipe.dir = themeWipe.dir > 0 ? -1 : 1;
}

async function run(s: Session, trigger: HTMLElement, setTheme: SetTheme) {
  const root = document.documentElement;
  const doc = document as DocWithVT;
  const rect = trigger.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  let blot: Blot;
  try {
    blot = await prepareBlot();
  } catch {
    session = null;
    if (!s.cancelled) setTheme(s.to);
    return;
  }
  if (s.cancelled) {
    session = null;
    return;
  }
  nextBlot = null;

  const farthest = Math.max(
    Math.hypot(x, y),
    Math.hypot(window.innerWidth - x, y),
    Math.hypot(x, window.innerHeight - y),
    Math.hypot(window.innerWidth - x, window.innerHeight - y),
  );
  // 遮罩图里半径 0.186 倍边长以内一定是实心的，再扣掉着色器里前沿的起伏：放大到这个尺寸恰好盖住最远的角
  const sizeEnd = farthest / 0.17 + 40;

  // 交给着色器：同一张遮罩、同一个中心、同一条进度曲线（wipeSize）
  themeWipe.source = blot.canvas;
  themeWipe.sourceVersion++;
  Object.assign(themeWipe, { x, y, sizeEnd, duration: DURATION, from: s.from, to: s.to, t0: Number.POSITIVE_INFINITY, p0: 0, dir: 1 });
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

  s.started = true;
  try {
    // 真实主题在这里切到目标主题，并且整个过渡期间不再动
    const vt = doc.startViewTransition!(() => setTheme(s.to));
    try {
      await vt.ready;
      themeWipe.t0 = performance.now();
      const tick = (now: number) => {
        if (s.ending) return;
        root.style.setProperty("--ink-s", `${wipeSize(now)}px`);
        const p = wipeProgress(now);
        if (themeWipe.dir > 0 ? p >= 1 : p <= 0) {
          s.ending = true;
          // 收回到零：旧截图此刻铺满全屏，同一帧里把真实主题改回旧主题，再撤掉过渡层
          if (themeWipe.dir < 0) setTheme(s.from);
          vt.skipTransition();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // 伪元素上的动画都被关掉了，过渡会立刻结束；挂一个足够长的空动画撑住，由 tick 在铺满/收回时结束过渡
      root.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 3_600_000, pseudoElement: "::view-transition-new(root)" });
    } catch {
      /* 过渡没能开始 */
    }
    await vt.finished;
  } catch {
    /* 动画被打断也无妨：下面会把主题落到最终状态 */
  } finally {
    s.ending = true;
    window.removeEventListener("click", onOverlayClick, true);
    // 无论怎么结束的，真实主题都要落在「当前方向」的终点上
    const final = themeWipe.dir > 0 ? s.to : s.from;
    if (root.dataset.theme !== final) setTheme(final);
    if (session === s) session = null;
    settling = settle(blot);
    void settling.then(() => {
      const q = queued;
      queued = null;
      if (q) inkSwitchTheme(q.trigger, q.setTheme);
    });
  }
}

// 收尾分两帧：画布的墨色由着色器画（带主题色，不带 CSS 滤镜），回到平时要换成「浅色原墨 + CSS 滤镜」。
// 两者必须在同一帧生效，否则会有一帧深色墨被滤镜再反相一次（闪一下）。
// 第一帧：着色器改回平时的画法（着色器的 rAF 在我们前面，这一帧画布仍是主题墨）；
// 第二帧：着色器已画出平时的样子，这时再去掉 ink-running（滤镜回来），同帧显示。
function settle(used: Blot) {
  const root = document.documentElement;
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      themeWipe.active = false;
      requestAnimationFrame(() => {
        root.classList.remove("ink-running");
        for (const k of VARS) root.style.removeProperty(k);
        URL.revokeObjectURL(used.url);
        settling = null;
        resolve();
        // 为下一次切换准备新的形状
        warmUpInkSwitch();
      });
    });
  });
}
