import { call, callRaw } from "./client";
import type { AnlasEstimate, Job, ParamSet, StudioForm, TokenStatus } from "@/data/types";

export async function tokenStatus() {
  return call<TokenStatus>("nai_status");
}

export async function saveToken(token: string) {
  return call<TokenStatus>("nai_save_token", { token });
}

export async function clearToken() {
  return call<TokenStatus>("nai_clear_token");
}

export async function listParamSets() {
  const data = await call<{ paramSets: ParamSet[] }>("param_sets_list");
  return data.paramSets;
}

export async function saveParamSet(name: string, form: StudioForm) {
  const data = await call<{ paramSet: ParamSet }>("param_sets_save", { name, form });
  return data.paramSet;
}

export async function updateParamSet(id: string, form: StudioForm) {
  const data = await call<{ paramSet: ParamSet }>("param_sets_update", { id, form });
  return data.paramSet;
}

export async function deleteParamSet(id: string) {
  await call("param_sets_delete", { id });
}

export async function submitJob(body: Record<string, unknown>) {
  const data = await call<{ job: Job }>("nai_submit_job", { body });
  return data.job;
}

export async function estimateCost(body: Record<string, unknown>) {
  return call<AnlasEstimate>("nai_estimate", { body });
}

export type UploadedBlob = { blobHash: string; url: string; width: number | null; height: number | null };

/** 上传底图 / 蒙版：请求体直接是图片，后端统一转 PNG 入库。 */
export async function uploadBlob(blob: Blob) {
  return callRaw<UploadedBlob>("nai_upload_blob", new Uint8Array(await blob.arrayBuffer()));
}

export async function cancelJob(id: string) {
  const data = await call<{ job: Job }>("nai_cancel_job", { id });
  return data.job;
}

export async function listJobs() {
  const data = await call<{ jobs: Job[] }>("nai_list_jobs");
  return data.jobs;
}

export type HistoryPage = { jobs: Job[]; nextBefore: number | null; nextBeforeId: string | null };

/** 生图室的全部完成记录，按创建时间倒序翻页，不受「最近任务条数」截断。 */
export async function listHistory(cursor?: { before: number; beforeId?: string | null }, limit = 60) {
  return call<HistoryPage>("nai_history", {
    limit,
    before: cursor && Number.isFinite(cursor.before) ? cursor.before : null,
    beforeId: cursor?.beforeId || null,
  });
}

export type HistoryRef = { jobId: string; itemId: string };

/** 从历史里移除图片记录。只删记录，图片文件和收藏夹里的图都不受影响。 */
export async function deleteHistory(items: HistoryRef[]) {
  return call<{ removed: number }>("nai_history_delete", { items });
}

export async function promoteItems(albumId: string, blobHashes: string[], meta: Record<string, unknown>) {
  const data = await call<{ items: unknown[] }>("nai_promote", {
    body: { albumId, blobHashes, save: true, meta },
  });
  return data.items;
}

export async function verifyIntegrity() {
  return call<{ ok?: boolean } & Record<string, unknown>>("integrity_verify");
}
