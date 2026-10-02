import type { Settings, ThemeMode } from "@/data/settings";

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "auto") {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

/** 把外观类设置落到 <html> 的 data 属性 / CSS 变量上，样式全部在 CSS 里按这些属性切换。 */
export function applySettingsToDom(s: Settings, root: HTMLElement = document.documentElement) {
  const a = s.appearance;
  const g = s.gallery;
  root.dataset.theme = resolveTheme(a.theme);
  root.dataset.font = a.font;
  root.dataset.grain = a.grain ? "on" : "off";
  root.dataset.motion = a.reduceMotion ? "reduce" : "full";
  root.dataset.labels = a.sidebarLabels ? "on" : "off";
  root.dataset.density = g.density;
  root.dataset.artists = g.showArtists ? "on" : "off";
  root.style.setProperty("--card-min", `${g.cardMinWidth}px`);
  root.style.setProperty("--card-min-compact", `${Math.max(110, Math.round(g.cardMinWidth * 0.65))}px`);
}
