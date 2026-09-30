import { create } from "zustand";
import { galleryApi } from "@/api";
export type ViewId = "gallery" | "lottery" | "studio";
export type AlbumDialogState = {
  mode: "create" | "rename";
  albumId?: string;
  name: string;
};
export type OverlayCopy = {
  show: boolean;
  title: string;
  desc: string;
};
export type ImportProgress = {
  show: boolean;
  done: number;
  total: number;
};

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
  compact: boolean;
  dialog: AlbumDialogState | null;
  overlay: OverlayCopy;
  progress: ImportProgress;
  setView: (view: ViewId) => void;
  setAlbumId: (id: string) => void;
  setTestSetId: (id: string) => void;
  setTestPresetId: (id: string) => void;
  hydrateSelection: (sel: { albumId: string; testSetId: string; testPresetId: string }) => void;
  setOpenId: (id: string | null) => void;
  setBasketOpen: (open: boolean) => void;
  toggleBasket: () => void;
  setQuery: (query: string) => void;
  setCompact: (compact: boolean) => void;
  toggleCompact: () => void;
  openCreateDialog: () => void;
  openRenameDialog: (albumId: string, name: string) => void;
  setDialogName: (name: string) => void;
  closeDialog: () => void;
  showOverlay: (title: string, desc: string) => void;
  hideOverlay: () => void;
  setProgress: (show: boolean, done?: number, total?: number) => void;
};

const EMPTY_OVERLAY: OverlayCopy = {
  show: false,
  title: "松开以导入",
  desc: "PNG / WEBP，将自动解析 NAI 参数",
};

let saveChain: Promise<unknown> = Promise.resolve();

/** 图库视图选择（收藏夹 / 测试集 / 测试生图预设）存到后端数据库，是全局参数，刷新、换浏览器都在。 */
function persistSelection(albumId: string, testSetId: string, presetId: string) {
  if (!useSession.getState().selectionReady) return;
  saveChain = saveChain.then(() => galleryApi.putView({ albumId, testSetId, presetId })).catch(() => undefined);
}

function hashView(): ViewId {
  const raw = location.hash.replace("#", "");
  if (raw === "lottery" || raw === "studio" || raw === "gallery") return raw;
  return "gallery";
}

export const useSession = create<SessionState>((set) => ({
  view: hashView(),
  albumId: "",
  testSetId: "",
  testPresetId: "",
  selectionReady: false,
  openId: null,
  basketOpen: false,
  query: "",
  compact: false,
  dialog: null,
  overlay: EMPTY_OVERLAY,
  progress: { show: false, done: 0, total: 0 },
  setView: (view) => {
    history.replaceState(null, "", `#${view}`);
    set({ view });
  },
  hydrateSelection: (sel) => set({ ...sel, selectionReady: true }),
  setAlbumId: (albumId) => {
    // 测试集选择原样保留（也一起存进数据库）：从单画师切到别的收藏夹再切回来，还是原来那个测试集。
    // 只有停在「单画师」收藏夹时它才生效，见 activeTestSetId。
    const s = useSession.getState();
    set({ albumId, openId: null });
    persistSelection(albumId, s.testSetId, s.testPresetId);
  },
  setTestSetId: (testSetId) => {
    set({ testSetId, openId: null });
    const s = useSession.getState();
    persistSelection(s.albumId, testSetId, s.testPresetId);
  },
  setTestPresetId: (testPresetId) => {
    set({ testPresetId });
    const s = useSession.getState();
    persistSelection(s.albumId, s.testSetId, testPresetId);
  },
  setOpenId: (openId) => set({ openId }),
  setBasketOpen: (basketOpen) => set({ basketOpen }),
  toggleBasket: () => set((s) => ({ basketOpen: !s.basketOpen })),
  setQuery: (query) => set({ query }),
  setCompact: (compact) => set({ compact }),
  toggleCompact: () => set((s) => ({ compact: !s.compact })),
  openCreateDialog: () => set({ dialog: { mode: "create", name: "" } }),
  openRenameDialog: (albumId, name) => set({ dialog: { mode: "rename", albumId, name } }),
  setDialogName: (name) => set((s) => (s.dialog ? { dialog: { ...s.dialog, name } } : s)),
  closeDialog: () => set({ dialog: null }),
  showOverlay: (title, desc) => set({ overlay: { show: true, title, desc } }),
  hideOverlay: () => set((s) => ({ overlay: { ...s.overlay, show: false } })),
  setProgress: (show, done = 0, total = 0) => set({ progress: { show, done, total } }),
}));
