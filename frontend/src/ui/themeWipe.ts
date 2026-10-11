/**
 * 主题切换墨迹扩散的共享状态：ui/themeInk.ts 负责启停并驱动 CSS 变量，ui/inkFluid.ts 的 WebGL 着色器每帧读取它，
 * 在背景画布里按同一张泼墨遮罩图、同一个半径画出「旧主题的墨 → 新主题的墨」，并在扩散的前沿画一圈湿墨边。
 * 页面其余部分（纸、界面）用同一张遮罩图做 CSS 遮罩，所以画布里的墨迹边缘和界面换色的边缘是同一条线。
 */

export type ThemeName = "light" | "dark";

export type ThemeWipe = {
  active: boolean;
  /** 遮罩图（只用 alpha），着色器把它传成纹理 */
  source: HTMLCanvasElement | null;
  sourceVersion: number;
  /** 扩散中心（CSS 像素，视口坐标） */
  x: number;
  y: number;
  /** 进度 1 时的边长：恰好盖住离中心最远的角 */
  sizeEnd: number;
  /** 当前这一段的起点：t0 时刻（performance.now 时基）进度为 p0，之后按 dir 方向匀速走；t0 之前停在 p0 */
  t0: number;
  p0: number;
  dir: 1 | -1;
  /** 进度从 0 走到 1 的时长 */
  duration: number;
  from: ThemeName;
  to: ThemeName;
};

export const themeWipe: ThemeWipe = {
  active: false,
  source: null,
  sourceVersion: 0,
  x: 0,
  y: 0,
  sizeEnd: 24,
  t0: Number.POSITIVE_INFINITY,
  p0: 0,
  dir: 1,
  duration: 1000,
  from: "light",
  to: "dark",
};

// 先快后慢，但到终点时仍保留速度：墨迹边缘冲出屏幕的那一帧就是结束，不会有「看着停了、其实还在爬」的尾巴
const easeOut = (t: number) => t * (1.6 - 0.6 * t);

/** 线性进度 0..1（0 = 全是旧主题，1 = 铺满新主题）。倒退时同一条曲线原路返回。 */
export function wipeProgress(now: number): number {
  const w = themeWipe;
  if (!(now > w.t0)) return w.p0;
  return Math.max(0, Math.min(1, w.p0 + (w.dir * (now - w.t0)) / w.duration));
}

/** 遮罩图当前的边长（CSS 像素）。CSS 变量和着色器都用它，所以两边永远同步。 */
export function wipeSize(now: number): number {
  return Math.max(1, themeWipe.sizeEnd * easeOut(wipeProgress(now)));
}

/** 与 theme.css 里 invert(1) hue-rotate(180deg) 等价的颜色变换（0..1 的 sRGB）。深色主题下的墨色 = 浅色墨色经此变换。 */
export function darkTheme(rgb: readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb.map((v) => 1 - v) as [number, number, number];
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return [
    clamp(-0.574 * r + 1.43 * g + 0.144 * b),
    clamp(0.426 * r + 0.43 * g + 0.144 * b),
    clamp(0.426 * r + 1.43 * g - 0.856 * b),
  ];
}

/** 背景墨的两套色（与 inkFluid 着色器里的原始浅色值一致；深色那套是滤镜后的样子）。 */
export const INK_LIGHT: [number, number, number] = [0.102, 0.114, 0.106];
export const TEA_LIGHT: [number, number, number] = [0.541, 0.416, 0.212];
