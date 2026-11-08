import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * 图库滚动位置持久化（系统功能，界面上不显示任何进度）。
 * 每个收藏夹 / 测试集各记一份：滚动位置 + 已渲染的批数（分批加载时要先渲染够才滚得到）。
 * 存 localStorage，刷新、重启、切页面再回来都停在原处。
 */
const STORAGE_KEY = "wb.galleryScroll";
const MAX_ENTRIES = 60;
const SAVE_DELAY = 250;

type Pos = { top: number; shown: number };

let cache: Map<string, Pos> | null = null;

function all() {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Record<string, unknown> | null;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        const p = v as Partial<Pos> | null;
        if (p && Number.isFinite(p.top) && Number.isFinite(p.shown)) cache.set(k, { top: Number(p.top), shown: Number(p.shown) });
      }
    }
  } catch {
    /* ignore */
  }
  return cache;
}

function remember(key: string, pos: Pos) {
  const m = all();
  m.delete(key);
  m.set(key, pos);
  while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value as string);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(m)));
  } catch {
    /* ignore */
  }
}

export function useScrollMemory(opts: {
  ref: RefObject<HTMLElement | null>;
  /** 一份进度的标识：收藏夹 + 测试集。 */
  storeKey: string;
  /** 内容已经加载好，才能恢复；搜索过滤中不记也不恢复。 */
  ready: boolean;
  /** 图库页是否正在显示（隐藏的页面滚动位置会被浏览器清零，不能记）。 */
  active: boolean;
  getShown: () => number;
  setShown: (fn: (n: number) => number) => void;
}) {
  const { ref, storeKey, ready, active } = opts;
  const getShown = useRef(opts.getShown);
  const setShown = useRef(opts.setShown);
  getShown.current = opts.getShown;
  setShown.current = opts.setShown;
  /** 已经恢复完的 key：恢复期间不能把中途位置写回去。 */
  const settled = useRef("");
  const timer = useRef(0);
  const pending = useRef<{ key: string; pos: Pos } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !ready || !active) return;
    const saved = all().get(storeKey);
    if (!saved) {
      el.scrollTop = 0;
      settled.current = storeKey;
      return;
    }
    settled.current = "";
    setShown.current((n) => Math.max(n, saved.shown));
    let cancelled = false;
    let raf = 0;
    let tries = 0;
    const step = () => {
      if (cancelled) return;
      el.scrollTop = saved.top;
      tries += 1;
      // 内容还没撑到足够高时滚不到位，等下一帧再试（图片按宽高比占位，通常很快）。
      if (Math.abs(el.scrollTop - saved.top) < 2 || tries > 40) {
        settled.current = storeKey;
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [ref, storeKey, ready, active]);

  // 离开时把还没写出去的那一次记下来。
  useEffect(() => {
    const flush = () => {
      window.clearTimeout(timer.current);
      const p = pending.current;
      pending.current = null;
      if (p) remember(p.key, p.pos);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  /** 挂在滚动容器的 onScroll 上。位置在事件发生时就取下来，延迟写入，避免页面被隐藏后读到 0。 */
  return useCallback(
    (e: { currentTarget: HTMLElement }) => {
      if (!ready || !active || settled.current !== storeKey) return;
      const pos = { top: e.currentTarget.scrollTop, shown: getShown.current() };
      window.clearTimeout(timer.current);
      pending.current = { key: storeKey, pos };
      timer.current = window.setTimeout(() => {
        pending.current = null;
        remember(storeKey, pos);
      }, SAVE_DELAY);
    },
    [ready, active, storeKey],
  );
}
