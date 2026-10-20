import { listen } from "@tauri-apps/api/event";
import { call } from "./client";
import type { Settings, SettingsPatch, SystemInfo } from "@/data/settings";

export type SettingsPayload = { settings: Settings; version: number };

export function getSettings() {
  return call<SettingsPayload>("settings_get");
}

export function putSettings(patch: SettingsPatch) {
  return call<SettingsPayload>("settings_put", { patch });
}

export function resetSettings(section?: string) {
  return call<SettingsPayload>("settings_reset", { section: section ?? null });
}

export function importSettings(settings: unknown) {
  return call<SettingsPayload>("settings_import", { settings });
}

export function getSystemInfo() {
  return call<SystemInfo>("settings_system");
}

export type IntegrityReport = {
  ok: boolean;
  chain: { ok: boolean; events: number; errors: string[] };
  blobs: { referenced: number; missing: string[]; mismatch: string[] };
  projections: { match: boolean };
};

export function verifyIntegrity() {
  return call<IntegrityReport>("integrity_verify");
}

export function rebuildProjections() {
  return call<{ rebuilt: number; chain: { ok: boolean } }>("integrity_rebuild");
}

export function backupHint() {
  return call<{ copy: string[]; note: string }>("integrity_backup");
}

export type DbExportResult = { cancelled: boolean; path?: string; events?: number; size?: number };

/** 弹出系统「另存为」对话框，把事件库导出成单个 SQLite 文件。 */
export function exportDatabase(suggestedName: string) {
  return call<DbExportResult>("db_export", { suggestedName });
}

export type DbPackResult = DbExportResult & { blobs?: number; missingBlobs?: number };

/** 弹出系统「另存为」对话框，把数据库和图片打成一个 zip 完整包。进度见 `onTransferProgress`。 */
export function exportPack(suggestedName: string) {
  return call<DbPackResult>("db_export_pack", { suggestedName });
}

export type DbImportResult = {
  cancelled: boolean;
  events?: number;
  rebuilt?: number;
  missingBlobs?: number;
  backup?: string;
  /** 导入的是完整包（带图片）而不是单个数据库文件。 */
  pack?: boolean;
  blobsAdded?: number;
  blobsSkipped?: number;
  blobsCorrupt?: number;
};

/** 弹出系统「打开文件」对话框，选一个数据库或完整包替换当前数据（后端会先自动备份）。 */
export function importDatabase() {
  return call<DbImportResult>("db_import");
}

export type TransferProgress = { phase: "database" | "blobs"; done: number; total: number };

/** 订阅导出/导入的进度；返回取消订阅函数。 */
export async function onTransferProgress(cb: (p: TransferProgress) => void): Promise<() => void> {
  return listen<TransferProgress>("transfer-progress", (e) => cb(e.payload));
}
