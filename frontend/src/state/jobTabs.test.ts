import { beforeEach, describe, expect, it } from "vitest";
import { assignJobsToTabs, resetJobTabsCache, setJobTab } from "./jobTabs";

const KEY = "wb.jobTabs";

beforeEach(() => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* node 里可能没有 localStorage */
  }
  resetJobTabsCache();
});

describe("assignJobsToTabs", () => {
  it("推送比本地登记更早时，用任务上的 tabId，不落到第一个标签", () => {
    const jobs = [{ id: "job-b", client: { tabId: "tab-b" } }];
    const assigned = assignJobsToTabs(jobs, ["tab-a", "tab-b"], "tab-a");
    expect(assigned.get("tab-a")).toEqual([]);
    expect(assigned.get("tab-b")).toEqual(jobs);
  });

  it("没有归属的旧任务仍归 fallback", () => {
    const jobs = [{ id: "old" }];
    const assigned = assignJobsToTabs(jobs, ["tab-a", "tab-b"], "tab-a");
    expect(assigned.get("tab-a")?.map((job) => job.id)).toEqual(["old"]);
    expect(assigned.get("tab-b")).toEqual([]);
  });

  it("本地登记优先，归属标签已关闭时归 fallback", () => {
    setJobTab("job-a", "tab-a");
    const live = [{ id: "job-a", client: { tabId: "tab-b" } }];
    expect(assignJobsToTabs(live, ["tab-a", "tab-b"], "tab-b").get("tab-a")?.map((job) => job.id)).toEqual(["job-a"]);

    setJobTab("job-gone", "closed");
    const gone = [{ id: "job-gone", client: { tabId: "closed" } }];
    expect(assignJobsToTabs(gone, ["tab-a", "tab-b"], "tab-a").get("tab-a")?.map((job) => job.id)).toEqual(["job-gone"]);
  });
});
