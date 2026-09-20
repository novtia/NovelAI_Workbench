import { create } from "zustand";

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
  openId: string | null;
  query: string;
  compact: boolean;
  dialog: AlbumDialogState | null;
  overlay: OverlayCopy;
  progress: ImportProgress;
  setView: (view: ViewId) => void;
  setAlbumId: (id: string) => void;
  setOpenId: (id: string | null) => void;
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

function hashView(): ViewId {
  const raw = location.hash.replace("#", "");
  if (raw === "lottery" || raw === "studio" || raw === "gallery") return raw;
  return "gallery";
}

export const useSession = create<SessionState>((set) => ({
  view: hashView(),
  albumId: "",
  openId: null,
  query: "",
  compact: false,
  dialog: null,
  overlay: EMPTY_OVERLAY,
  progress: { show: false, done: 0, total: 0 },
  setView: (view) => {
    history.replaceState(null, "", `#${view}`);
    set({ view });
  },
  setAlbumId: (albumId) => set({ albumId, openId: null }),
  setOpenId: (openId) => set({ openId }),
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
