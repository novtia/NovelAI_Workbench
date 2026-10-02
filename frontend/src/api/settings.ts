import { request } from "./client";
import type { Settings, SettingsPatch, SystemInfo } from "@/data/settings";

export type SettingsPayload = { settings: Settings; version: number };

export function getSettings() {
  return request<SettingsPayload>("/api/settings");
}

export function putSettings(patch: SettingsPatch) {
  return request<SettingsPayload>("/api/settings", { method: "PUT", body: JSON.stringify({ patch }) });
}

export function resetSettings(section?: string) {
  return request<SettingsPayload>("/api/settings/reset", { method: "POST", body: JSON.stringify({ section: section ?? null }) });
}

export function importSettings(settings: unknown) {
  return request<SettingsPayload>("/api/settings/import", { method: "POST", body: JSON.stringify({ settings }) });
}

export function getSystemInfo() {
  return request<SystemInfo>("/api/settings/system");
}

export type IntegrityReport = {
  ok: boolean;
  chain: { ok: boolean; events: number; errors: string[] };
  blobs: { referenced: number; missing: string[]; mismatch: string[] };
  projections: { match: boolean };
};

export function verifyIntegrity() {
  return request<IntegrityReport>("/api/integrity/verify", { method: "POST" });
}

export function rebuildProjections() {
  return request<{ rebuilt: number; chain: { ok: boolean } }>("/api/integrity/rebuild", { method: "POST" });
}

export function backupHint() {
  return request<{ copy: string[]; note: string }>("/api/integrity/backup");
}
