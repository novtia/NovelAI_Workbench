import { request } from "./client";
import type { AnlasEstimate, Job, ParamSet, StudioForm, TokenStatus } from "@/data/types";

export async function tokenStatus() {
  return request<TokenStatus>("/api/nai/status");
}

export async function saveToken(token: string) {
  return request<TokenStatus>("/api/nai/token", { method: "POST", body: JSON.stringify({ token }) });
}

export async function clearToken() {
  return request<TokenStatus>("/api/nai/token", { method: "DELETE" });
}

export async function listParamSets() {
  const data = await request<{ paramSets: ParamSet[] }>("/api/param-sets");
  return data.paramSets;
}

export async function saveParamSet(name: string, form: StudioForm) {
  const data = await request<{ paramSet: ParamSet }>("/api/param-sets", {
    method: "POST",
    body: JSON.stringify({ name, form }),
  });
  return data.paramSet;
}

export async function updateParamSet(id: string, form: StudioForm) {
  const data = await request<{ paramSet: ParamSet }>(`/api/param-sets/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ form }),
  });
  return data.paramSet;
}

export async function deleteParamSet(id: string) {
  await request(`/api/param-sets/${id}`, { method: "DELETE" });
}

export async function submitJob(body: Record<string, unknown>) {
  const data = await request<{ job: Job }>("/api/nai/jobs", { method: "POST", body: JSON.stringify(body) });
  return data.job;
}

export async function estimateCost(body: Record<string, unknown>) {
  return request<AnlasEstimate>("/api/nai/estimate", { method: "POST", body: JSON.stringify(body) });
}

export type UploadedBlob = { blobHash: string; url: string; width: number | null; height: number | null };

/** 上传底图 / 蒙版：请求体直接是图片，后端统一转 PNG 入库。 */
export async function uploadBlob(blob: Blob) {
  return request<UploadedBlob>("/api/blobs", {
    method: "POST",
    body: blob,
    headers: { "Content-Type": blob.type || "image/png" },
  });
}

export async function cancelJob(id: string) {
  const data = await request<{ job: Job }>(`/api/nai/jobs/${id}/cancel`, { method: "POST" });
  return data.job;
}

export async function listJobs() {
  const data = await request<{ jobs: Job[] }>("/api/nai/jobs");
  return data.jobs;
}

export type HistoryPage = { jobs: Job[]; nextBefore: number | null; nextBeforeId: string | null };

/** 生图室的全部完成记录，按创建时间倒序翻页，不受「最近任务条数」截断。 */
export async function listHistory(cursor?: { before: number; beforeId?: string | null }, limit = 60) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor && Number.isFinite(cursor.before)) q.set("before", String(cursor.before));
  if (cursor?.beforeId) q.set("beforeId", cursor.beforeId);
  return request<HistoryPage>(`/api/nai/history?${q}`);
}

export type HistoryRef = { jobId: string; itemId: string };

/** 从历史里移除图片记录。只删记录，图片文件和收藏夹里的图都不受影响。 */
export async function deleteHistory(items: HistoryRef[]) {
  return request<{ removed: number }>("/api/nai/history/delete", {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}

export async function promoteItems(albumId: string, blobHashes: string[], meta: Record<string, unknown>) {
  const data = await request<{ items: unknown[] }>("/api/nai/generate", {
    method: "POST",
    body: JSON.stringify({ albumId, blobHashes, save: true, meta }),
  });
  return data.items;
}

export async function verifyIntegrity() {
  return request<{ ok?: boolean } & Record<string, unknown>>("/api/integrity/verify", { method: "POST" });
}
