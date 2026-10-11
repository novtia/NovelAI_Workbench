import { create } from "zustand";
import { removeTabDraft } from "@/data/studio";
import { disposeTab, MAIN_TAB_ID, setActiveTab } from "./scoped";

export type ViewId = "gallery" | "lottery" | "studio" | "settings";

export type Tab = { id: string; view: ViewId };

export const TABS_KEY = "wb.tabs";
const VIEW_IDS: ViewId[] = ["gallery", "lottery", "studio", "settings"];

export function isViewId(v: unknown): v is ViewId {
  return typeof v === "string" && (VIEW_IDS as string[]).includes(v);
}

type Persisted = { tabs: Tab[]; activeId: string };

type TabsState = {
  tabs: Tab[];
  activeId: string;
  /** 新开一个标签并切过去，返回它的 id。 */
  openTab: (view?: ViewId) => string;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  /** 把标签移到 index 位置。 */
  moveTab: (id: string, index: number) => void;
  setTabView: (id: string, view: ViewId) => void;
};

function newTabId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function hashView(): ViewId {
  if (typeof location === "undefined") return "gallery";
  const raw = location.hash.replace("#", "");
  return isViewId(raw) ? raw : "gallery";
}

/** 读取持久化的标签；数据不合法就退回单个标签（视图取自地址栏 hash）。 */
export function loadTabs(raw: string | null, fallbackView: ViewId = "gallery"): Persisted {
  try {
    const data = JSON.parse(raw || "null") as Partial<Persisted> | null;
    const seen = new Set<string>();
    const tabs = (Array.isArray(data?.tabs) ? data!.tabs : []).filter((t): t is Tab => {
      if (!t || typeof t.id !== "string" || !t.id || seen.has(t.id) || !isViewId(t.view)) return false;
      seen.add(t.id);
      return true;
    });
    if (tabs.length) {
      const activeId = tabs.some((t) => t.id === data?.activeId) ? String(data!.activeId) : tabs[0].id;
      return { tabs, activeId };
    }
  } catch {
    /* ignore */
  }
  return { tabs: [{ id: MAIN_TAB_ID, view: fallbackView }], activeId: MAIN_TAB_ID };
}

function readStored() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(TABS_KEY);
  } catch {
    return null;
  }
}

function persist(s: Pick<TabsState, "tabs" | "activeId">) {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: s.tabs, activeId: s.activeId }));
  } catch {
    /* ignore */
  }
}

const initial = loadTabs(readStored(), hashView());
// 地址栏带了明确的 #页面（比如书签）时，让激活标签先去那一页。
if (typeof location !== "undefined" && isViewId(location.hash.replace("#", ""))) {
  const want = hashView();
  initial.tabs = initial.tabs.map((t) => (t.id === initial.activeId ? { ...t, view: want } : t));
}
setActiveTab(initial.activeId);

export const useTabs = create<TabsState>((set, get) => {
  /** 更新并持久化。 */
  const commit = (patch: Pick<TabsState, "tabs" | "activeId">) => {
    set(patch);
    persist(patch);
    setActiveTab(patch.activeId);
  };
  return {
    tabs: initial.tabs,
    activeId: initial.activeId,
    openTab: (view = "gallery") => {
      const id = newTabId();
      const { tabs } = get();
      const at = tabs.findIndex((t) => t.id === get().activeId);
      const next = [...tabs];
      next.splice(at < 0 ? next.length : at + 1, 0, { id, view });
      commit({ tabs: next, activeId: id });
      return id;
    },
    closeTab: (id) => {
      const { tabs, activeId } = get();
      const index = tabs.findIndex((t) => t.id === id);
      if (index < 0) return;
      const rest = tabs.filter((t) => t.id !== id);
      disposeTab(id);
      removeTabDraft(id);
      if (!rest.length) {
        const fresh = newTabId();
        commit({ tabs: [{ id: fresh, view: "gallery" }], activeId: fresh });
        return;
      }
      const nextActive = id === activeId ? rest[Math.min(index, rest.length - 1)].id : activeId;
      commit({ tabs: rest, activeId: nextActive });
    },
    activateTab: (id) => {
      const s = get();
      if (id === s.activeId || !s.tabs.some((t) => t.id === id)) return;
      commit({ tabs: s.tabs, activeId: id });
    },
    moveTab: (id, index) => {
      const { tabs, activeId } = get();
      const from = tabs.findIndex((t) => t.id === id);
      if (from < 0) return;
      const to = Math.max(0, Math.min(tabs.length - 1, index));
      if (from === to) return;
      const next = [...tabs];
      const [tab] = next.splice(from, 1);
      next.splice(to, 0, tab);
      commit({ tabs: next, activeId });
    },
    setTabView: (id, view) => {
      const { tabs, activeId } = get();
      if (!tabs.some((t) => t.id === id && t.view !== view)) return;
      commit({ tabs: tabs.map((t) => (t.id === id ? { ...t, view } : t)), activeId });
    },
  };
});

/** 某个标签当前的视图（标签不存在时按图库）。 */
export function tabView(id: string): ViewId {
  return useTabs.getState().tabs.find((t) => t.id === id)?.view ?? "gallery";
}
