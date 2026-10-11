import { create } from "zustand";

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

type UiState = {
  overlay: OverlayCopy;
  progress: ImportProgress;
  showOverlay: (title: string, desc: string) => void;
  hideOverlay: () => void;
  setProgress: (show: boolean, done?: number, total?: number) => void;
};

const EMPTY_OVERLAY: OverlayCopy = {
  show: false,
  title: "松开以导入",
  desc: "PNG / WEBP，将自动解析 NAI 参数",
};

/** 整个窗口共用的临时界面状态（拖放遮罩、导入进度），不随标签切换丢失。 */
export const useUiStore = create<UiState>((set) => ({
  overlay: EMPTY_OVERLAY,
  progress: { show: false, done: 0, total: 0 },
  showOverlay: (title, desc) => set({ overlay: { show: true, title, desc } }),
  hideOverlay: () => set((s) => ({ overlay: { ...s.overlay, show: false } })),
  setProgress: (show, done = 0, total = 0) => set({ progress: { show, done, total } }),
}));
