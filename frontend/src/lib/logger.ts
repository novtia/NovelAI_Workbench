import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogOrigin = "fe" | "rust";

export type LogEntry = {
  id: string;
  seq: number;
  origin: LogOrigin;
  level: LogLevel;
  scope: string;
  event: string;
  detail?: unknown;
  at: number;
  ts: string;
};

export type ScopedLogger = {
  debug: (event: string, detail?: unknown) => void;
  info: (event: string, detail?: unknown) => void;
  warn: (event: string, detail?: unknown) => void;
  error: (event: string, detail?: unknown) => void;
};

type BackendLogRecord = {
  seq: number;
  at: number;
  level: LogLevel;
  scope: string;
  event: string;
  detail?: unknown;
};

const MAX_LOGS = 1000;

let debugEnabled = false;
let localSeq = 0;
let entries: LogEntry[] = [];
const seenBackendSeq = new Set<number>();
const listeners = new Set<() => void>();
let emitTimer: number | null = null;
let initialized = false;
let shortcutBlockedHandler: (() => void) | undefined;

declare global {
  interface Window {
    __WB_LOGS__?: LogEntry[];
    __wbDumpLogs?: (filter?: string) => string;
    __wbClearLogs?: () => void;
    __wbOpenDevtools?: () => void;
  }
}

export function formatLogTime(ms = Date.now()): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function notifySoon() {
  if (typeof window === "undefined") {
    for (const fn of listeners) fn();
    return;
  }
  if (emitTimer !== null) return;
  emitTimer = window.setTimeout(() => {
    emitTimer = null;
    for (const fn of listeners) fn();
  }, 40);
}

function syncWindowCache() {
  if (typeof window !== "undefined") {
    window.__WB_LOGS__ = entries;
  }
}

function printToConsole(entry: LogEntry) {
  if (typeof console === "undefined") return;
  const isRust = entry.origin === "rust";
  const badge = isRust ? "background:#2b1f1a;color:#f5a97f" : "background:#1a2433;color:#8aadf4";
  const label = isRust ? `RUST:${entry.scope}` : `FE:${entry.scope}`;
  const prefix = `%c[${entry.ts}] [${label}]%c ${entry.event}`;
  const fn = entry.level === "error" ? console.error : entry.level === "warn" ? console.warn : console.info;
  if (entry.detail !== undefined) {
    fn(prefix, `${badge};padding:1px 4px;border-radius:3px`, "color:inherit;font-weight:600", entry.detail);
  } else {
    fn(prefix, `${badge};padding:1px 4px;border-radius:3px`, "color:inherit;font-weight:600");
  }
}

function pushEntry(entry: LogEntry, shouldPrint: boolean) {
  const next = entries.length >= MAX_LOGS ? entries.slice(entries.length - MAX_LOGS + 1) : entries.slice();
  next.push(entry);
  entries = next;
  syncWindowCache();
  if (shouldPrint && debugEnabled) {
    printToConsole(entry);
  }
  notifySoon();
}

function pushBackendRecord(rec: BackendLogRecord, shouldPrint: boolean) {
  if (seenBackendSeq.has(rec.seq)) return;
  seenBackendSeq.add(rec.seq);
  const at = typeof rec.at === "number" ? rec.at : Date.now();
  pushEntry(
    {
      id: `rust:${rec.seq}`,
      seq: rec.seq,
      origin: "rust",
      level: rec.level || "debug",
      scope: rec.scope || "kernel",
      event: rec.event || "",
      detail: rec.detail,
      at,
      ts: formatLogTime(at),
    },
    shouldPrint,
  );
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function setDebugEnabled(enabled: boolean) {
  const prev = debugEnabled;
  debugEnabled = Boolean(enabled);
  if (!prev && debugEnabled) {
    void hydrateBackendLogs();
  }
}

export async function hydrateBackendLogs() {
  if (typeof window === "undefined") return;
  try {
    const res = await invoke<{ records?: BackendLogRecord[] }>("logs_snapshot");
    if (Array.isArray(res?.records)) {
      for (const rec of res.records) {
        pushBackendRecord(rec, false);
      }
    }
  } catch {
    /* 非 Tauri 环境或命令不可用时忽略 */
  }
}

export function logEvent(origin: LogOrigin, level: LogLevel, scope: string, event: string, detail?: unknown, atMs?: number) {
  if (!debugEnabled && (level === "debug" || level === "info")) {
    return;
  }
  const at = typeof atMs === "number" ? atMs : Date.now();
  const seq = ++localSeq;
  pushEntry(
    {
      id: `${origin}:${seq}`,
      seq,
      origin,
      level,
      scope,
      event,
      detail,
      at,
      ts: formatLogTime(at),
    },
    true,
  );
}

/** 创建带模块命名空间的日志器，任意模块引入即可调用。 */
export function createLogger(scope: string): ScopedLogger {
  return {
    debug: (event, detail) => logEvent("fe", "debug", scope, event, detail),
    info: (event, detail) => logEvent("fe", "info", scope, event, detail),
    warn: (event, detail) => logEvent("fe", "warn", scope, event, detail),
    error: (event, detail) => logEvent("fe", "error", scope, event, detail),
  };
}

export function getLogs(): LogEntry[] {
  return entries;
}

export function subscribeLogs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useDebugLogs(): LogEntry[] {
  return useSyncExternalStore(subscribeLogs, getLogs, getLogs);
}

export function clearLogs() {
  entries = [];
  seenBackendSeq.clear();
  syncWindowCache();
  notifySoon();
  if (typeof window !== "undefined") {
    void invoke("logs_clear").catch(() => {});
  }
}

export function filterLogs(list: LogEntry[], opts?: { origin?: LogOrigin | "all"; onlyWarn?: boolean; query?: string }): LogEntry[] {
  const origin = opts?.origin ?? "all";
  const onlyWarn = Boolean(opts?.onlyWarn);
  const q = (opts?.query ?? "").trim().toLowerCase();
  return list.filter((r) => {
    if (origin !== "all" && r.origin !== origin) return false;
    if (onlyWarn && r.level !== "warn" && r.level !== "error") return false;
    if (!q) return true;
    const detailText = r.detail !== undefined ? JSON.stringify(r.detail) : "";
    const hay = `${r.origin}:${r.scope} ${r.level} ${r.event} ${detailText}`.toLowerCase();
    return hay.includes(q);
  });
}

export function formatLogLine(r: LogEntry): string {
  const originTag = r.origin === "rust" ? "RUST" : "FE";
  const lvl = r.level.toUpperCase();
  const detail = r.detail !== undefined ? ` ${JSON.stringify(r.detail)}` : "";
  return `${r.ts} [${originTag}:${r.scope}] [${lvl}] ${r.event}${detail}`;
}

export function exportLogsText(filter?: string, list = entries): string {
  const rows = filter ? filterLogs(list, { query: filter }) : list;
  return rows.map(formatLogLine).join("\n");
}

export function openDevtools(): boolean {
  if (!debugEnabled) {
    shortcutBlockedHandler?.();
    return false;
  }
  if (typeof window !== "undefined") {
    void invoke("open_devtools").catch(() => {});
  }
  return true;
}

export function initLogger(opts?: { onShortcutBlocked?: () => void }) {
  shortcutBlockedHandler = opts?.onShortcutBlocked;
  if (typeof window === "undefined" || initialized) return;
  initialized = true;

  syncWindowCache();
  window.__wbDumpLogs = (filter?: string) => {
    const text = exportLogsText(filter);
    console.log(text);
    return text;
  };
  window.__wbClearLogs = clearLogs;
  window.__wbOpenDevtools = () => {
    openDevtools();
  };

  window.addEventListener("keydown", (e) => {
    const isF12 = e.key === "F12";
    const isCtrlShiftI = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "i";
    if (isF12 || isCtrlShiftI) {
      e.preventDefault();
      openDevtools();
    }
  });

  void listen<BackendLogRecord>("app-log", (ev) => {
    if (ev.payload) {
      pushBackendRecord(ev.payload, true);
    }
  }).catch(() => {
    /* 非 Tauri 环境下忽略 */
  });
}

/** 仅供单元测试重置内部状态。 */
export function _resetLoggerForTest() {
  debugEnabled = false;
  localSeq = 0;
  entries = [];
  seenBackendSeq.clear();
  if (emitTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(emitTimer);
    emitTimer = null;
  }
}
