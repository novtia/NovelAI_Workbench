/**
 * 任务归属：生图任务是哪个标签提交的。
 * 任务结果由后端统一推送，前端靠这张表把结果送回提交它的标签。
 * 存 localStorage，刷新后还能认得；只留最近一批。
 */
const KEY = "wb.jobTabs";
const MAX = 200;

let map: Map<string, string> | null = null;

function load() {
  if (map) return map;
  map = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null") as Record<string, unknown> | null;
    if (raw && typeof raw === "object") {
      for (const [jobId, tabId] of Object.entries(raw)) if (typeof tabId === "string") map.set(jobId, tabId);
    }
  } catch {
    /* ignore */
  }
  return map;
}

function save() {
  const m = load();
  while (m.size > MAX) m.delete(m.keys().next().value as string);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(m)));
  } catch {
    /* ignore */
  }
}

export function setJobTab(jobId: string, tabId: string) {
  if (!jobId) return;
  const m = load();
  m.delete(jobId);
  m.set(jobId, tabId);
  save();
}

export function getJobTab(jobId: string) {
  return load().get(jobId);
}

/**
 * 这条任务该回到哪个标签。
 * 本地表是提交返回后写的；推送往往比那一次返回更早到，所以同时认请求体里的 client.tabId。
 */
export function jobOwnerTab(job: { id: string; client?: { tabId?: unknown } | null }) {
  const mapped = getJobTab(job.id);
  if (mapped) return mapped;
  const tabId = job.client?.tabId;
  return typeof tabId === "string" && tabId ? tabId : undefined;
}

/** 测试用：丢掉内存缓存。 */
export function resetJobTabsCache() {
  map = null;
}

/**
 * 把一批任务分给各标签：有归属且归属标签还在的给它，其余（旧任务、归属标签已关闭）归 fallback。
 */
export function assignJobsToTabs<T extends { id: string; client?: { tabId?: unknown } | null }>(jobs: T[], tabIds: string[], fallback: string) {
  const out = new Map<string, T[]>(tabIds.map((id) => [id, []]));
  for (const job of jobs) {
    const owner = jobOwnerTab(job);
    const target = owner && out.has(owner) ? owner : fallback;
    out.get(target)?.push(job);
  }
  return out;
}
