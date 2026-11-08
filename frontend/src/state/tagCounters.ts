import { create } from "zustand";

/** 标签公式的计数器：key -> 当前位置。存 localStorage，重启后接着走。 */
const KEY = "wb.tagCounters";

function load(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null") as Record<string, unknown> | null;
    if (raw && typeof raw === "object") {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function save(counters: Record<string, number>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(counters));
  } catch {
    /* ignore */
  }
}

type TagCounterState = {
  counters: Record<string, number>;
  /** 循环开关只放内存，重启即关。 */
  loops: Record<string, boolean>;
  /** 有一条循环正在排队下一张。 */
  running: boolean;
  /** 批量前进：key -> 位数。 */
  advance: (by: Record<string, number>) => void;
  setIndex: (key: string, index: number) => void;
  reset: (key: string) => void;
  setLoop: (key: string, on: boolean) => void;
  setRunning: (on: boolean) => void;
};

export const useTagCounters = create<TagCounterState>((set, get) => {
  const commit = (counters: Record<string, number>) => {
    save(counters);
    set({ counters });
  };
  return {
    counters: load(),
    loops: {},
    running: false,
    advance(by) {
      const next = { ...get().counters };
      for (const [k, n] of Object.entries(by)) next[k] = (next[k] || 0) + n;
      commit(next);
    },
    setIndex(key, index) {
      commit({ ...get().counters, [key]: Math.max(0, Math.trunc(index)) });
    },
    reset(key) {
      const next = { ...get().counters };
      delete next[key];
      commit(next);
    },
    setLoop(key, on) {
      const loops = { ...get().loops };
      if (on) loops[key] = true;
      else delete loops[key];
      set({ loops });
    },
    setRunning(on) {
      set({ running: on });
    },
  };
});
