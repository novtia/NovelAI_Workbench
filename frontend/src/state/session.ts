import { galleryApi } from "@/api";
import { createTabScopedStore, activeTab } from "./scoped";
import { tabView, useTabs, type ViewId } from "./tabs";

export type { ViewId } from "./tabs";
export type { OverlayCopy, ImportProgress } from "./uiStore";
export type AlbumDialogState = {
  mode: "create" | "rename";
  albumId?: string;
  name: string;
};

type Selection = { albumId: string; testSetId: string; testPresetId: string };

type SessionState = {
  view: ViewId;
  albumId: string;
  testSetId: string;
  testPresetId: string;
  /** 已从后端读到持久化的选择；在这之前不要自动选默认收藏夹，也不要写回。 */
  selectionReady: boolean;
  openId: string | null;
  /** 画师串抽屉是否打开，只放内存，刷新后默认关闭。 */
  basketOpen: boolean;
  query: string;
  dialog: AlbumDialogState | null;
  setView: (view: ViewId) => void;
  setAlbumId: (id: string) => void;
  setTestSetId: (id: string) => void;
  setTestPresetId: (id: string) => void;
  hydrateSelection: (sel: Selection) => void;
  setOpenId: (id: string | null) => void;
  setBasketOpen: (open: boolean) => void;
  toggleBasket: () => void;
  setQuery: (query: string) => void;
  openCreateDialog: () => void;
  openRenameDialog: (albumId: string, name: string) => void;
  setDialogName: (name: string) => void;
  closeDialog: () => void;
};

let saveChain: Promise<unknown> = Promise.resolve();
/** 最近一次读到 / 改动的图库选择；新开的标签从它起步。 */
let lastSelection: Selection | null = null;

/** 图库视图选择（收藏夹 / 测试集 / 测试生图预设）存到后端数据库，是全局参数，刷新、换浏览器都在。 */
function persistSelection(ready: boolean, albumId: string, testSetId: string, presetId: string) {
  if (!ready) return;
  lastSelection = { albumId, testSetId, testPresetId: presetId };
  saveChain = saveChain.then(() => galleryApi.putView({ albumId, testSetId, presetId })).catch(() => undefined);
}

/** 每个标签一份：当前页面、图库选择、搜索、弹窗等。 */
export const useSession = createTabScopedStore<SessionState>((tabId) => (set, get) => ({
  view: tabView(tabId),
  albumId: lastSelection?.albumId ?? "",
  testSetId: lastSelection?.testSetId ?? "",
  testPresetId: lastSelection?.testPresetId ?? "",
  selectionReady: lastSelection != null,
  openId: null,
  basketOpen: false,
  query: "",
  dialog: null,
  setView: (view) => {
    // 标签栏里的视图是唯一来源，store 里的 view 只是镜像。
    useTabs.getState().setTabView(tabId, view);
    if (tabId === activeTab() && typeof history !== "undefined") history.replaceState(null, "", `#${view}`);
    set({ view });
  },
  hydrateSelection: (sel) => {
    lastSelection = sel;
    set({ ...sel, selectionReady: true });
  },
  setAlbumId: (albumId) => {
    // 测试集选择原样保留（也一起存进数据库）：从单画师切到别的收藏夹再切回来，还是原来那个测试集。
    // 只有停在「单画师」收藏夹时它才生效，见 activeTestSetId。
    const s = get();
    set({ albumId, openId: null });
    persistSelection(s.selectionReady, albumId, s.testSetId, s.testPresetId);
  },
  setTestSetId: (testSetId) => {
    set({ testSetId, openId: null });
    const s = get();
    persistSelection(s.selectionReady, s.albumId, testSetId, s.testPresetId);
  },
  setTestPresetId: (testPresetId) => {
    set({ testPresetId });
    const s = get();
    persistSelection(s.selectionReady, s.albumId, s.testSetId, testPresetId);
  },
  setOpenId: (openId) => set({ openId }),
  setBasketOpen: (basketOpen) => set({ basketOpen }),
  toggleBasket: () => set((s) => ({ basketOpen: !s.basketOpen })),
  setQuery: (query) => set({ query }),
  openCreateDialog: () => set({ dialog: { mode: "create", name: "" } }),
  openRenameDialog: (albumId, name) => set({ dialog: { mode: "rename", albumId, name } }),
  setDialogName: (name) => set((s) => (s.dialog ? { dialog: { ...s.dialog, name } } : s)),
  closeDialog: () => set({ dialog: null }),
}));
