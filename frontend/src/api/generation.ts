import { request } from "./client";
import type { Job, ParamSet, StudioForm, TokenStatus } from "@/data/types";

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

export async function cancelJob(id: string) {
  const data = await request<{ job: Job }>(`/api/nai/jobs/${id}/cancel`, { method: "POST" });
  return data.job;
}

export async function listJobs() {
  const data = await request<{ jobs: Job[] }>("/api/nai/jobs");
  return data.jobs;
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
