import { create } from "zustand";
import { removeTabDraft } from "@/data/studio";
import { disposeTab, MAIN_TAB_ID, setActiveTab } from "./scoped";

export type ViewId = "gallery" | "lottery" | "studio" | "media" | "history" | "settings" | "album" | "web";

export type Tab = {
  id: string;
  view: ViewId;
  albumId?: string;
  webSiteId?: string;
  webUrl?: string;
  webTitle?: string;
};

export type WebTabTarget = {
  id?: string;
  name: string;
  baseUrl: string;
};

export const TABS_KEY = "wb.tabs";
const VIEW_IDS: ViewId[] = ["gallery", "lottery", "studio", "media", "history", "settings", "album", "web"];

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
  /** 打开某个收藏夹的详细页。已经开着就切过去，不重复开。 */
  openAlbumTab: (albumId: string) => string;
  /** 在工作台内置标签栏中打开自定义网页（相同站点或网址已打开时直接切过去）。 */
  openWebTab: (site: WebTabTarget) => string;
};

function newTabId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function hashView(): ViewId {
  if (typeof location === "undefined") return "gallery";
  const raw = location.hash.replace("#", "");
  // 详细页必须带着收藏夹 id，网页标签必须带网址，空存储不能靠 #album / #web 凭空造一个。
  if (isViewId(raw) && raw !== "album" && raw !== "web") return raw;
  return "gallery";
}

function asTab(raw: unknown, seen: Set<string>): Tab | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Partial<Tab>;
  if (typeof t.id !== "string" || !t.id || seen.has(t.id) || !isViewId(t.view)) return null;
  if (t.view === "album") {
    if (typeof t.albumId !== "string" || !t.albumId) return null;
    seen.add(t.id);
    return { id: t.id, view: "album", albumId: t.albumId };
  }
  if (t.view === "web") {
    if (typeof t.webUrl !== "string" || !t.webUrl.trim()) return null;
    seen.add(t.id);
    const out: Tab = { id: t.id, view: "web", webUrl: t.webUrl.trim() };
    if (typeof t.webSiteId === "string" && t.webSiteId.trim()) out.webSiteId = t.webSiteId.trim();
    if (typeof t.webTitle === "string" && t.webTitle.trim()) out.webTitle = t.webTitle.trim();
    return out;
  }
  seen.add(t.id);
  return { id: t.id, view: t.view };
}

/** 读取持久化的标签；数据不合法就退回单个标签（视图取自地址栏 hash）。 */
export function loadTabs(raw: string | null, fallbackView: ViewId = "gallery"): Persisted {
  try {
    const data = JSON.parse(raw || "null") as Partial<Persisted> | null;
    const seen = new Set<string>();
    const tabs = (Array.isArray(data?.tabs) ? data!.tabs : []).flatMap((raw) => {
      const tab = asTab(raw, seen);
      return tab ? [tab] : [];
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
// #album / #web 需要各自参数；不要把别的标签改成没有收藏夹或没有网址的空页。
if (typeof location !== "undefined") {
  const raw = location.hash.replace("#", "");
  if (raw !== "album" && raw !== "web" && isViewId(raw)) {
    initial.tabs = initial.tabs.map((t) => (t.id === initial.activeId ? { ...t, view: raw } : t));
  }
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
      // 详细页必须带收藏夹 id，网页必须带网址，普通开标签不能走进去。
      const useView = view === "album" || view === "web" ? "gallery" : view;
      const id = newTabId();
      const { tabs } = get();
      const at = tabs.findIndex((t) => t.id === get().activeId);
      const next = [...tabs];
      next.splice(at < 0 ? next.length : at + 1, 0, { id, view: useView });
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
      // 详细页只能由 openAlbumTab 打开，网页只能由 openWebTab 打开。
      if (view === "album" || view === "web") return;
      const { tabs, activeId } = get();
      if (!tabs.some((t) => t.id === id && t.view !== view)) return;
      commit({
        tabs: tabs.map((t) =>
          t.id === id ? { id: t.id, view } : t,
        ),
        activeId,
      });
    },
    openAlbumTab: (albumId) => {
      const { tabs, activeId } = get();
      const existing = tabs.find((t) => t.view === "album" && t.albumId === albumId);
      if (existing) {
        if (existing.id !== activeId) commit({ tabs, activeId: existing.id });
        return existing.id;
      }
      const id = newTabId();
      const at = tabs.findIndex((t) => t.id === activeId);
      const next = [...tabs];
      next.splice(at < 0 ? next.length : at + 1, 0, { id, view: "album", albumId });
      commit({ tabs: next, activeId: id });
      return id;
    },
    openWebTab: (site) => {
      const rawUrl = (site.baseUrl || "").trim();
      if (!rawUrl) return get().activeId;
      const webUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
      const webTitle = (site.name || "").trim() || webUrl;
      const webSiteId = (site.id || "").trim() || undefined;
      const { tabs, activeId } = get();
      const existing = tabs.find(
        (t) =>
          t.view === "web" &&
          ((webSiteId && t.webSiteId === webSiteId) || t.webUrl === webUrl),
      );
      if (existing) {
        const updatedTabs = tabs.map((t) =>
          t.id === existing.id ? { ...t, webUrl, webTitle, ...(webSiteId ? { webSiteId } : {}) } : t,
        );
        commit({ tabs: updatedTabs, activeId: existing.id });
        return existing.id;
      }
      const id = newTabId();
      const at = tabs.findIndex((t) => t.id === activeId);
      const next = [...tabs];
      const newTab: Tab = { id, view: "web", webUrl, webTitle };
      if (webSiteId) newTab.webSiteId = webSiteId;
      next.splice(at < 0 ? next.length : at + 1, 0, newTab);
      commit({ tabs: next, activeId: id });
      return id;
    },
  };
});

/** 某个标签当前的视图（标签不存在时按图库）。 */
export function tabView(id: string): ViewId {
  return useTabs.getState().tabs.find((t) => t.id === id)?.view ?? "gallery";
}
