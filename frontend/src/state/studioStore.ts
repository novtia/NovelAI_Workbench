import { create } from "zustand";
import { defaultForm, defaultImportOpts, loadDraft, loadSelectedSet } from "@/data/studio";
import type { StudioForm, StudioImportOpts, StudioPop, StudioShot } from "@/data/types";

export type StudioDd = "model" | "mode" | "qtags" | "preset" | "";

type StudioState = {
  form: StudioForm;
  promptTab: "base" | "uc";
  charTabs: Record<number, "prompt" | "uc">;
  aiOpen: boolean;
  aiSettled: boolean;
  i2iOpen: boolean;
  directing: boolean;
  activeChar: number;
  currentSetId: string;
  session: StudioShot[];
  currentId: string | null;
  liveUrl: string;
  busy: boolean;
  studioJobId: string;
  genProgress: string;
  tokenInput: string;
  pop: StudioPop;
  popPos: { left: number; top: number };
  popPreferUp: boolean;
  openDd: StudioDd;
  leftW: number;
  histW: number;
  paramDialog: boolean;
  paramName: string;
  metaOpen: boolean;
  metaUrl: string;
  metaForm: Partial<StudioForm> | null;
  metaStatus: "loading" | "ok" | "empty" | "error";
  metaError: string;
  importOpts: StudioImportOpts;
  pendingSave: boolean;
  quotaOpen: boolean;
  jobsOpen: boolean;
  patchForm: (patch: Partial<StudioForm>) => void;
  setForm: (form: StudioForm) => void;
  setPromptTab: (promptTab: "base" | "uc") => void;
  setCharTab: (i: number, tab: "prompt" | "uc") => void;
  setAiOpen: (aiOpen: boolean) => void;
  setAiSettled: (aiSettled: boolean) => void;
  setI2iOpen: (i2iOpen: boolean) => void;
  setDirecting: (directing: boolean) => void;
  setActiveChar: (activeChar: number) => void;
  setCurrentSetId: (currentSetId: string) => void;
  setSession: (session: StudioShot[]) => void;
  setCurrentId: (currentId: string | null) => void;
  setLiveUrl: (liveUrl: string) => void;
  setBusy: (busy: boolean, studioJobId?: string, genProgress?: string) => void;
  setGenProgress: (genProgress: string) => void;
  setTokenInput: (tokenInput: string) => void;
  openPop: (pop: StudioPop, pos?: { left: number; top: number }, preferUp?: boolean) => void;
  closePops: (keep?: StudioPop | "quota" | "jobs") => void;
  setPopPos: (popPos: { left: number; top: number }) => void;
  setOpenDd: (openDd: StudioDd) => void;
  setLeftW: (leftW: number) => void;
  setHistW: (histW: number) => void;
  setParamDialog: (paramDialog: boolean, name?: string) => void;
  setParamName: (paramName: string) => void;
  setMeta: (patch: Partial<Pick<StudioState, "metaOpen" | "metaUrl" | "metaForm" | "metaStatus" | "metaError">>) => void;
  setImportOpts: (importOpts: StudioImportOpts) => void;
  setPendingSave: (pendingSave: boolean) => void;
  setQuotaOpen: (quotaOpen: boolean) => void;
  setJobsOpen: (jobsOpen: boolean) => void;
};

const draft = typeof localStorage !== "undefined" ? loadDraft() : null;

export const useStudioStore = create<StudioState>((set, get) => ({
  form: draft || defaultForm(),
  promptTab: "base",
  charTabs: {},
  aiOpen: false,
  aiSettled: false,
  i2iOpen: false,
  directing: false,
  activeChar: 0,
  currentSetId: typeof localStorage !== "undefined" ? loadSelectedSet() : "",
  session: [],
  currentId: null,
  liveUrl: "",
  busy: false,
  studioJobId: "",
  genProgress: "",
  tokenInput: "",
  pop: null,
  popPos: { left: 0, top: 0 },
  popPreferUp: false,
  openDd: "",
  leftW: 392,
  histW: 268,
  paramDialog: false,
  paramName: "",
  metaOpen: false,
  metaUrl: "",
  metaForm: null,
  metaStatus: "empty",
  metaError: "",
  importOpts: defaultImportOpts(),
  pendingSave: false,
  quotaOpen: false,
  jobsOpen: false,
  patchForm: (patch) => set({ form: { ...get().form, ...patch } }),
  setForm: (form) => set({ form }),
  setPromptTab: (promptTab) => set({ promptTab }),
  setCharTab: (i, tab) => set((s) => ({ charTabs: { ...s.charTabs, [i]: tab } })),
  setAiOpen: (aiOpen) => set({ aiOpen, aiSettled: false }),
  setAiSettled: (aiSettled) => set({ aiSettled }),
  setI2iOpen: (i2iOpen) => set({ i2iOpen }),
  setDirecting: (directing) => set({ directing }),
  setActiveChar: (activeChar) => set({ activeChar }),
  setCurrentSetId: (currentSetId) => set({ currentSetId }),
  setSession: (session) => set({ session }),
  setCurrentId: (currentId) => set({ currentId }),
  setLiveUrl: (liveUrl) => set({ liveUrl }),
  setBusy: (busy, studioJobId, genProgress) =>
    set({
      busy,
      studioJobId: studioJobId ?? (busy ? get().studioJobId : ""),
      genProgress: genProgress ?? (busy ? get().genProgress : ""),
    }),
  setGenProgress: (genProgress) => set({ genProgress }),
  setTokenInput: (tokenInput) => set({ tokenInput }),
  openPop: (pop, pos, preferUp) =>
    set({
      pop,
      popPos: pos || get().popPos,
      popPreferUp: Boolean(preferUp),
      openDd: "",
      quotaOpen: false,
      jobsOpen: false,
    }),
  closePops: (keep) =>
    set({
      pop: keep && keep !== "quota" && keep !== "jobs" ? get().pop : null,
      openDd: "",
      quotaOpen: keep === "quota" ? get().quotaOpen : false,
      jobsOpen: keep === "jobs" ? get().jobsOpen : false,
    }),
  setPopPos: (popPos) => set({ popPos }),
  setOpenDd: (openDd) => set({ openDd, pop: null, quotaOpen: false, jobsOpen: false }),
  setLeftW: (leftW) => set({ leftW }),
  setHistW: (histW) => set({ histW }),
  setParamDialog: (paramDialog, name) => set({ paramDialog, paramName: name ?? (paramDialog ? "" : get().paramName) }),
  setParamName: (paramName) => set({ paramName }),
  setMeta: (patch) => set(patch),
  setImportOpts: (importOpts) => set({ importOpts }),
  setPendingSave: (pendingSave) => set({ pendingSave }),
  setQuotaOpen: (quotaOpen) => set({ quotaOpen, jobsOpen: false, pop: null, openDd: "" }),
  setJobsOpen: (jobsOpen) => set({ jobsOpen, quotaOpen: false, pop: null, openDd: "" }),
}));
