import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * 滚动位置持久化（界面上不显示任何进度）。
 * 每份进度记两样：滚动位置，以及已经展开的内容量（分批渲染或翻页时，要先有够高的内容才滚得到）。
 * 存 localStorage，刷新、重启、切页面再回来都停在原处。
 */
const DEFAULT_BUCKET = "wb.galleryScroll";
const MAX_ENTRIES = 60;
const SAVE_DELAY = 250;

export type ScrollPos = { top: number; shown: number };

const caches = new Map<string, Map<string, ScrollPos>>();

function bucketOf(storageKey: string) {
  let cache = caches.get(storageKey);
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) || "null") as Record<string, unknown> | null;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        const p = v as Partial<ScrollPos> | null;
        if (p && Number.isFinite(p.top) && Number.isFinite(p.shown)) cache.set(k, { top: Number(p.top), shown: Number(p.shown) });
      }
    }
  } catch {
    /* ignore */
  }
  caches.set(storageKey, cache);
  return cache;
}

function remember(storageKey: string, key: string, pos: ScrollPos) {
  const m = bucketOf(storageKey);
  m.delete(key);
  m.set(key, pos);
  while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value as string);
  try {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(m)));
  } catch {
    /* ignore */
  }
}

export function useScrollMemory(opts: {
  ref: RefObject<HTMLElement | null>;
  /** 一份进度的标识。图库是收藏夹 + 测试集，历史页是固定的一份。 */
  storeKey: string;
  /** localStorage 键。不传则沿用图库原来的桶，历史页单独一只，互不覆盖。 */
  storageKey?: string;
  /** 内容已经加载好，才能恢复；过滤、加载中、出错时不记也不恢复。 */
  ready: boolean;
  /** 页面是否正在显示（隐藏时滚动位置会被浏览器清零，不能记）。 */
  active: boolean;
  getShown: () => number;
  /** 图库靠它把已在内存里的列表展开到上次的张数。历史页改走 prepare。 */
  setShown?: (fn: (n: number) => number) => void;
  /** 恢复前把内容准备够（历史页继续翻页）。完成前不会把中途位置写回去。 */
  prepare?: (saved: ScrollPos, isCancelled: () => boolean) => Promise<void> | void;
  /** 恢复结束（或本来就没有记录）后调用。历史页用它重新打开「滚到底再加载」。 */
  onSettled?: (settled: boolean) => void;
}) {
  const { ref, storeKey, ready, active } = opts;
  const storageKey = opts.storageKey || DEFAULT_BUCKET;
  const getShown = useRef(opts.getShown);
  const setShown = useRef(opts.setShown);
  const prepare = useRef(opts.prepare);
  const onSettled = useRef(opts.onSettled);
  getShown.current = opts.getShown;
  setShown.current = opts.setShown;
  prepare.current = opts.prepare;
  onSettled.current = opts.onSettled;
  /** 已经恢复完的 key：恢复期间不能把中途位置写回去。 */
  const settled = useRef("");
  const timer = useRef(0);
  const pending = useRef<{ storageKey: string; key: string; pos: ScrollPos } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !ready || !active) return;
    const saved = bucketOf(storageKey).get(storeKey);
    if (!saved) {
      el.scrollTop = 0;
      settled.current = storeKey;
      onSettled.current?.(true);
      return;
    }
    settled.current = "";
    onSettled.current?.(false);
    let cancelled = false;
    let raf = 0;
    const finish = () => {
      if (cancelled) return;
      setShown.current?.((n) => Math.max(n, saved.shown));
      let tries = 0;
      const step = () => {
        if (cancelled) return;
        el.scrollTop = saved.top;
        tries += 1;
        // 内容还没撑到足够高时滚不到位，等下一帧再试（图片按宽高比占位，通常很快）。
        if (Math.abs(el.scrollTop - saved.top) < 2 || tries > 40) {
          settled.current = storeKey;
          onSettled.current?.(true);
          return;
        }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const job = prepare.current;
    if (job) {
      void Promise.resolve()
        .then(() => job(saved, () => cancelled))
        .catch(() => {
          /* 翻页失败也按现有内容恢复，别卡在未结算 */
        })
        .then(() => finish());
    } else {
      finish();
    }
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [ref, storeKey, storageKey, ready, active]);

  // 离开时把还没写出去的那一次记下来。
  useEffect(() => {
    const flush = () => {
      window.clearTimeout(timer.current);
      const p = pending.current;
      pending.current = null;
      if (p) remember(p.storageKey, p.key, p.pos);
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
      pending.current = { storageKey, key: storeKey, pos };
      timer.current = window.setTimeout(() => {
        pending.current = null;
        remember(storageKey, storeKey, pos);
      }, SAVE_DELAY);
    },
    [ready, active, storeKey, storageKey],
  );
}
