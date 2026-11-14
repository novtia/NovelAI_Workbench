import { SAMPLER_LABEL } from "./studio";
import type { HistoryShot } from "./history";

export type HistoryDatePreset = "all" | "today" | "7d" | "30d" | "custom";
export type HistoryModelFilter = "all" | "full" | "medium" | "curated";
export type HistoryModeFilter = "all" | "anime" | "furry";
export type HistoryAspectFilter = "all" | "port" | "land" | "square";
export type HistoryTypeFilter = "all" | "generate" | "img2img" | "infill" | "variation" | "enhance" | "upscale";

export type HistoryFilter = {
  /** 关键词：匹配提示词、负面词、画师、角色提示词与 Seed（空格分隔多词按 AND 匹配）。 */
  query: string;
  datePreset: HistoryDatePreset;
  dateFrom: string;
  dateTo: string;
  model: HistoryModelFilter;
  v5Mode: HistoryModeFilter;
  requestType: HistoryTypeFilter;
  aspect: HistoryAspectFilter;
  /** 空字符串表示全部采样器。 */
  sampler: string;
};

export const EMPTY_HISTORY_FILTER: HistoryFilter = {
  query: "",
  datePreset: "all",
  dateFrom: "",
  dateTo: "",
  model: "all",
  v5Mode: "all",
  requestType: "all",
  aspect: "all",
  sampler: "",
};

export const DATE_PRESET_LABELS: Record<HistoryDatePreset, string> = {
  all: "全部",
  today: "今天",
  "7d": "近 7 天",
  "30d": "近 30 天",
  custom: "自定义",
};

export const TYPE_FILTER_LABELS: Record<HistoryTypeFilter, string> = {
  all: "全部",
  generate: "文生图",
  img2img: "图生图",
  infill: "局部重绘",
  variation: "变体",
  enhance: "增强",
  upscale: "放大",
};

export const ASPECT_FILTER_LABELS: Record<HistoryAspectFilter, string> = {
  all: "全部",
  port: "竖图",
  land: "横图",
  square: "方图",
};

export const MODEL_FILTER_LABELS: Record<HistoryModelFilter, string> = {
  all: "全部",
  full: "V5 完整",
  medium: "V5 节约",
  curated: "V5 精选",
};

export const MODE_FILTER_LABELS: Record<HistoryModeFilter, string> = {
  all: "全部",
  anime: "动漫",
  furry: "兽人",
};

function parseLocalDate(ymd: string, endOfDay: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = endOfDay
    ? new Date(year, month, day, 23, 59, 59, 999)
    : new Date(year, month, day, 0, 0, 0, 0);
  const ts = d.getTime();
  return Number.isFinite(ts) ? ts : null;
}

function dateBounds(filter: HistoryFilter, now: number): { from: number | null; to: number | null } {
  const d = new Date(now);
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  const todayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  if (filter.datePreset === "today") return { from: todayStart, to: todayEnd };
  if (filter.datePreset === "7d") {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6, 0, 0, 0, 0).getTime();
    return { from: start, to: todayEnd };
  }
  if (filter.datePreset === "30d") {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 29, 0, 0, 0, 0).getTime();
    return { from: start, to: todayEnd };
  }
  if (filter.datePreset === "custom") {
    return {
      from: filter.dateFrom ? parseLocalDate(filter.dateFrom, false) : null,
      to: filter.dateTo ? parseLocalDate(filter.dateTo, true) : null,
    };
  }
  return { from: null, to: null };
}

function searchableText(shot: HistoryShot): string {
  const meta = shot.meta || {};
  const parts: string[] = [shot.prompt || ""];
  if (meta.uc) parts.push(String(meta.uc));
  if (meta.artistLine) parts.push(String(meta.artistLine));
  if (Array.isArray(meta.artists)) {
    for (const a of meta.artists) parts.push(String(a || ""));
  }
  if (Array.isArray(meta.characters)) {
    for (const c of meta.characters as Array<{ prompt?: unknown; uc?: unknown }>) {
      if (c?.prompt) parts.push(String(c.prompt));
      if (c?.uc) parts.push(String(c.uc));
    }
  }
  const v4 = meta.v4Prompt as { caption?: { base_caption?: unknown; char_captions?: Array<{ char_caption?: unknown }> } } | undefined;
  if (v4?.caption?.base_caption) parts.push(String(v4.caption.base_caption));
  if (Array.isArray(v4?.caption?.char_captions)) {
    for (const c of v4.caption.char_captions) {
      if (c?.char_caption) parts.push(String(c.char_caption));
    }
  }
  if (meta.seed != null && meta.seed !== "") parts.push(String(meta.seed));
  return parts.join(" ").toLowerCase();
}

function matchesModel(meta: Record<string, unknown>, target: HistoryModelFilter): boolean {
  if (target === "all") return true;
  const raw = String(meta.model || "").toLowerCase();
  const effort = String(meta.effort || "").toLowerCase();
  if (target === "curated") return raw.includes("curated");
  if (target === "medium") return !raw.includes("curated") && (raw.includes("medium") || effort === "medium");
  return raw.includes("full") && !raw.includes("medium") && effort !== "medium";
}

function matchesMode(shot: HistoryShot, target: HistoryModeFilter): boolean {
  if (target === "all") return true;
  const meta = shot.meta || {};
  const raw = meta.v5Mode;
  const mode: "anime" | "furry" =
    raw === "furry" ? "furry" : raw === "anime" ? "anime" : /\bfur dataset\b/i.test(shot.prompt) ? "furry" : "anime";
  return mode === target;
}

function matchesRequestType(meta: Record<string, unknown>, target: HistoryTypeFilter): boolean {
  if (target === "all") return true;
  const raw = String(meta.requestType || "generate");
  return raw === target;
}

function matchesAspect(shot: HistoryShot, target: HistoryAspectFilter): boolean {
  if (target === "all") return true;
  if (!shot.width || !shot.height) return false;
  if (target === "port") return shot.height > shot.width;
  if (target === "land") return shot.width > shot.height;
  return shot.width === shot.height;
}

export function shotMatchesFilter(shot: HistoryShot, filter: HistoryFilter, now = Date.now()): boolean {
  const meta = shot.meta || {};

  const q = filter.query.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    const hay = searchableText(shot);
    for (const term of terms) {
      if (!hay.includes(term)) return false;
    }
  }

  const { from, to } = dateBounds(filter, now);
  if (from != null && shot.createdAt < from) return false;
  if (to != null && shot.createdAt > to) return false;

  if (!matchesModel(meta, filter.model)) return false;
  if (!matchesMode(shot, filter.v5Mode)) return false;
  if (!matchesRequestType(meta, filter.requestType)) return false;
  if (!matchesAspect(shot, filter.aspect)) return false;

  if (filter.sampler) {
    if (String(meta.sampler || "") !== filter.sampler) return false;
  }

  return true;
}

export function filterHistoryShots(shots: HistoryShot[], filter: HistoryFilter, now = Date.now()): HistoryShot[] {
  if (!hasActiveHistoryFilter(filter)) return shots;
  return shots.filter((shot) => shotMatchesFilter(shot, filter, now));
}

function isDateActive(filter: HistoryFilter): boolean {
  if (filter.datePreset === "all") return false;
  if (filter.datePreset === "custom") return Boolean(filter.dateFrom.trim() || filter.dateTo.trim());
  return true;
}

export function countActiveHistoryFilters(filter: HistoryFilter): number {
  let n = 0;
  if (filter.query.trim()) n += 1;
  if (isDateActive(filter)) n += 1;
  if (filter.requestType !== "all") n += 1;
  if (filter.aspect !== "all") n += 1;
  if (filter.model !== "all") n += 1;
  if (filter.v5Mode !== "all") n += 1;
  if (filter.sampler) n += 1;
  return n;
}

export function hasActiveHistoryFilter(filter: HistoryFilter): boolean {
  return countActiveHistoryFilters(filter) > 0;
}

export type ActiveHistoryFilterChip = {
  id: string;
  label: string;
  clear: (f: HistoryFilter) => HistoryFilter;
};

export function describeHistoryFilters(filter: HistoryFilter): ActiveHistoryFilterChip[] {
  const chips: ActiveHistoryFilterChip[] = [];
  const q = filter.query.trim();
  if (q) {
    chips.push({
      id: "query",
      label: `关键词: ${q}`,
      clear: (f) => ({ ...f, query: "" }),
    });
  }
  if (isDateActive(filter)) {
    let label: string = DATE_PRESET_LABELS[filter.datePreset];
    if (filter.datePreset === "custom") {
      if (filter.dateFrom && filter.dateTo) label = `${filter.dateFrom} ~ ${filter.dateTo}`;
      else if (filter.dateFrom) label = `${filter.dateFrom} 起`;
      else label = `截至 ${filter.dateTo}`;
    }
    chips.push({
      id: "date",
      label,
      clear: (f) => ({ ...f, datePreset: "all", dateFrom: "", dateTo: "" }),
    });
  }
  if (filter.requestType !== "all") {
    chips.push({
      id: "requestType",
      label: TYPE_FILTER_LABELS[filter.requestType],
      clear: (f) => ({ ...f, requestType: "all" }),
    });
  }
  if (filter.aspect !== "all") {
    chips.push({
      id: "aspect",
      label: ASPECT_FILTER_LABELS[filter.aspect],
      clear: (f) => ({ ...f, aspect: "all" }),
    });
  }
  if (filter.model !== "all") {
    chips.push({
      id: "model",
      label: MODEL_FILTER_LABELS[filter.model],
      clear: (f) => ({ ...f, model: "all" }),
    });
  }
  if (filter.v5Mode !== "all") {
    chips.push({
      id: "v5Mode",
      label: MODE_FILTER_LABELS[filter.v5Mode],
      clear: (f) => ({ ...f, v5Mode: "all" }),
    });
  }
  if (filter.sampler) {
    chips.push({
      id: "sampler",
      label: SAMPLER_LABEL[filter.sampler] || filter.sampler,
      clear: (f) => ({ ...f, sampler: "" }),
    });
  }
  return chips;
}

export function collectHistorySamplers(shots: HistoryShot[]): string[] {
  const known = Object.keys(SAMPLER_LABEL);
  const found = new Set<string>();
  for (const shot of shots) {
    const s = String(shot.meta?.sampler || "").trim();
    if (s) found.add(s);
  }
  const ordered = known.filter((k) => found.has(k));
  const extras = [...found].filter((k) => !known.includes(k)).sort();
  return [...ordered, ...extras];
}
