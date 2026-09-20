import { create } from "zustand";
import { DEFAULT_CONTROLS, normalizeBoard } from "@/data/lottery";
import type { LotSave, LotteryBoard, LotteryControls } from "@/data/types";

type SavedShot = { savedId: string; albumId: string };

type LotteryState = {
  poolQuery: string;
  excluded: string[];
  pinned: string[];
  weightCaps: Record<string, number>;
  controls: LotteryControls;
  presetId: string;
  boardVersion: number;
  dirty: boolean;
  lotSave: LotSave | null;
  pendingSave: LotSave | null;
  savedShots: Record<string, SavedShot>;
  enqueuing: string[];
  scrollTo: string;
  setPoolQuery: (poolQuery: string) => void;
  setControls: (controls: LotteryControls) => void;
  setPresetId: (presetId: string) => void;
  setExcluded: (excluded: string[]) => void;
  setPinned: (pinned: string[]) => void;
  setWeightCaps: (weightCaps: Record<string, number>) => void;
  setDirty: (dirty: boolean) => void;
  setBoardVersion: (boardVersion: number) => void;
  openLotSave: (lotSave: LotSave) => void;
  closeLotSave: () => void;
  setPendingSave: (pendingSave: LotSave | null) => void;
  moveLotSave: (left: number, top: number) => void;
  markSaved: (hash: string, rec: SavedShot) => void;
  addEnqueuing: (key: string) => void;
  removeEnqueuing: (key: string) => void;
  setScrollTo: (scrollTo: string) => void;
  hydrate: (board: LotteryBoard) => void;
  snapshot: () => LotteryBoard;
};

export const useLotteryStore = create<LotteryState>((set, get) => ({
  poolQuery: "",
  excluded: [],
  pinned: [],
  weightCaps: {},
  controls: { ...DEFAULT_CONTROLS },
  presetId: "",
  boardVersion: -1,
  dirty: false,
  lotSave: null,
  pendingSave: null,
  savedShots: {},
  enqueuing: [],
  scrollTo: "",
  setPoolQuery: (poolQuery) => set({ poolQuery }),
  setControls: (controls) => set({ controls, dirty: true }),
  setPresetId: (presetId) => set({ presetId, dirty: true }),
  setExcluded: (excluded) => set({ excluded, dirty: true }),
  setPinned: (pinned) => set({ pinned, dirty: true }),
  setWeightCaps: (weightCaps) => set({ weightCaps, dirty: true }),
  setDirty: (dirty) => set({ dirty }),
  setBoardVersion: (boardVersion) => set({ boardVersion }),
  openLotSave: (lotSave) => set({ lotSave }),
  closeLotSave: () => set({ lotSave: null }),
  setPendingSave: (pendingSave) => set({ pendingSave }),
  moveLotSave: (left, top) => set((s) => (s.lotSave ? { lotSave: { ...s.lotSave, left, top } } : s)),
  markSaved: (hash, rec) => set((s) => ({ savedShots: { ...s.savedShots, [hash]: rec } })),
  addEnqueuing: (key) => set((s) => (s.enqueuing.includes(key) ? s : { enqueuing: [...s.enqueuing, key] })),
  removeEnqueuing: (key) => set((s) => ({ enqueuing: s.enqueuing.filter((k) => k !== key) })),
  setScrollTo: (scrollTo) => set({ scrollTo }),
  hydrate: (board) => {
    const normalized = normalizeBoard(board);
    const { presetId, ...rest } = normalized.controls;
    set({
      excluded: normalized.excluded,
      pinned: normalized.pinned,
      weightCaps: normalized.weightCaps,
      controls: { ...DEFAULT_CONTROLS, ...rest },
      presetId: String(presetId || get().presetId || ""),
      boardVersion: normalized.version ?? 0,
      dirty: false,
    });
  },
  snapshot: () => {
    const s = get();
    return {
      albumId: null,
      excluded: s.excluded,
      pinned: s.pinned,
      weightCaps: s.weightCaps,
      controls: { ...s.controls, presetId: s.presetId },
      version: s.boardVersion,
    };
  },
}));
