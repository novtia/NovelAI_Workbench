import { create } from "zustand";

export type ConfirmOptions = {
  title?: string;
  confirmText?: string;
  cancelText?: string;
};

type Pending = ConfirmOptions & { message: string; resolve: (ok: boolean) => void };

type ConfirmState = {
  pending: Pending | null;
  settle: (ok: boolean) => void;
};

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  settle: (ok) => {
    const cur = get().pending;
    if (!cur) return;
    set({ pending: null });
    cur.resolve(ok);
  },
}));

/** 全局确认弹窗（替代浏览器自带的 window.confirm）。返回 true 表示用户点了确认。 */
export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // 已经有一个在等待时，把旧的当作取消，避免悬空的 Promise
    useConfirmStore.getState().settle(false);
    useConfirmStore.setState({ pending: { ...opts, message, resolve } });
  });
}
