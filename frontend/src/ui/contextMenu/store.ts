import { create } from "zustand";
import { tidy, type MenuEntry } from "./registry";

type MenuState = {
  open: boolean;
  x: number;
  y: number;
  entries: MenuEntry[];
  openMenu: (x: number, y: number, entries: MenuEntry[]) => void;
  closeMenu: () => void;
};

export const useContextMenuStore = create<MenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  entries: [],
  openMenu: (x, y, entries) => {
    const clean = tidy(entries);
    if (!clean.length) return;
    set({ open: true, x, y, entries: clean });
  },
  closeMenu: () => set({ open: false, entries: [] }),
}));

export function closeContextMenu() {
  useContextMenuStore.getState().closeMenu();
}
