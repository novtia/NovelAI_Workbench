import { create } from "zustand";
/** 每个测试集用的预设（继续生成时沿用）。画师顺序和生成进度都从默认集与测试集里的图现算，不再存。 */
export type TestRun = { testSetId: string; presetId: string; createdAt: number };

type TestRunState = {
  runs: Record<string, TestRun>;
  /** 正在逐个排队的测试集 id；空串表示没有在排队。 */
  submitting: string;
  addRun: (run: TestRun) => void;
  removeRun: (testSetId: string) => void;
  setSubmitting: (testSetId: string) => void;
};

const RUNS_KEY = "wb.testRuns";
const MAX_RUNS = 12;

function loadRuns(): Record<string, TestRun> {
  try {
    const raw = JSON.parse(localStorage.getItem(RUNS_KEY) || "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, TestRun>) : {};
  } catch {
    return {};
  }
}

function saveRuns(runs: Record<string, TestRun>) {
  try {
    const list = Object.values(runs).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RUNS);
    localStorage.setItem(RUNS_KEY, JSON.stringify(Object.fromEntries(list.map((r) => [r.testSetId, r]))));
  } catch {
    /* 存储不可用时只保留内存里的 run */
  }
}

/** 测试集用的预设记录。选择哪个测试集/预设是存在后端数据库里的，见 session。 */
export const useTestRunStore = create<TestRunState>((set) => ({
  runs: loadRuns(),
  submitting: "",
  addRun: (run) =>
    set((s) => {
      const runs = { ...s.runs, [run.testSetId]: run };
      saveRuns(runs);
      return { runs };
    }),
  removeRun: (testSetId) =>
    set((s) => {
      if (!s.runs[testSetId]) return s;
      const runs = { ...s.runs };
      delete runs[testSetId];
      saveRuns(runs);
      return { runs };
    }),
  setSubmitting: (submitting) => set({ submitting }),
}));
