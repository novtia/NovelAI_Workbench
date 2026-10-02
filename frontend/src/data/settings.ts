/** 全局设置的类型与默认值。必须与 backend/contexts/settings/schema.py 保持一致（服务端会再校验一遍）。 */

export type ThemeMode = "light" | "dark" | "auto";

export type Settings = {
  appearance: {
    theme: ThemeMode;
    font: "serif" | "sans";
    liveInk: boolean;
    grain: boolean;
    reduceMotion: boolean;
    sidebarLabels: boolean;
    toastMs: number;
  };
  gallery: {
    density: "comfortable" | "compact";
    cardMinWidth: number;
    sort: "added_desc" | "added_asc";
    pageSize: 0 | 100 | 200 | 500;
    showArtists: boolean;
    hoverPreview: boolean;
    startAlbum: "last" | "default";
    confirmDelete: boolean;
    thumbSize: number;
    thumbQuality: number;
  };
  generation: {
    model: "nai-diffusion-5-full" | "nai-diffusion-5-curated";
    v5Mode: "anime" | "furry";
    quality: "off" | "official" | "gallery";
    preset: "Small" | "Normal" | "Large";
    aspect: "port" | "land" | "square";
    sampler: string;
    noiseSchedule: string;
    steps: number;
    scale: number;
    cfgRescale: number;
    nSamples: number;
    ucPreset: "heavy" | "comic" | "none";
    draftSave: boolean;
    draftDebounceMs: number;
    concurrency: number;
    timeoutSec: number;
    jobsKeep: number;
    autoOpenJobs: boolean;
    streamPreview: boolean;
    tokenWarn: boolean;
  };
  lottery: {
    min: number;
    max: number;
    draws: number;
    target: number;
    wmin: number;
    wmax: number;
    jitter: number;
    boost: number;
    confirmDelete: boolean;
  };
  basket: {
    separator: "comma" | "newline" | "space";
    underscoreToSpace: boolean;
    escapeParens: boolean;
    autoOpen: boolean;
  };
  layout: {
    leftWidth: number;
    histWidth: number;
    rememberWidths: boolean;
  };
  account: {
    quotaRefreshSec: number;
    statusTtlSec: number;
    showBattery: boolean;
  };
  system: {
    ssePingSec: number;
    importConcurrency: number;
  };
};

export type SectionId = keyof Settings;

export type SettingsPatch = { [S in SectionId]?: Partial<Settings[S]> };

export const DEFAULT_SETTINGS: Settings = {
  appearance: {
    theme: "light",
    font: "serif",
    liveInk: true,
    grain: true,
    reduceMotion: false,
    sidebarLabels: true,
    toastMs: 3200,
  },
  gallery: {
    density: "comfortable",
    cardMinWidth: 230,
    sort: "added_desc",
    pageSize: 0,
    showArtists: true,
    hoverPreview: true,
    startAlbum: "last",
    confirmDelete: true,
    thumbSize: 420,
    thumbQuality: 82,
  },
  generation: {
    model: "nai-diffusion-5-full",
    v5Mode: "anime",
    quality: "gallery",
    preset: "Normal",
    aspect: "port",
    sampler: "k_euler_ancestral",
    noiseSchedule: "karras",
    steps: 28,
    scale: 5,
    cfgRescale: 0,
    nSamples: 1,
    ucPreset: "heavy",
    draftSave: true,
    draftDebounceMs: 1200,
    concurrency: 1,
    timeoutSec: 180,
    jobsKeep: 80,
    autoOpenJobs: false,
    streamPreview: true,
    tokenWarn: true,
  },
  lottery: {
    min: 3,
    max: 5,
    draws: 8,
    target: 1,
    wmin: 0.05,
    wmax: 1,
    jitter: 0.6,
    boost: 0.4,
    confirmDelete: false,
  },
  basket: {
    separator: "comma",
    underscoreToSpace: false,
    escapeParens: false,
    autoOpen: false,
  },
  layout: {
    leftWidth: 392,
    histWidth: 268,
    rememberWidths: true,
  },
  account: {
    quotaRefreshSec: 60,
    statusTtlSec: 45,
    showBattery: true,
  },
  system: {
    ssePingSec: 15,
    importConcurrency: 2,
  },
};

export const SECTION_IDS = Object.keys(DEFAULT_SETTINGS) as SectionId[];

/** 把任意（可能缺项的）对象补全成完整设置；类型不匹配的字段回落到默认值。 */
export function mergeSettings(src: unknown): Settings {
  const out = cloneSettings(DEFAULT_SETTINGS);
  if (!src || typeof src !== "object") return out;
  const obj = src as Record<string, unknown>;
  for (const section of SECTION_IDS) {
    const part = obj[section];
    if (!part || typeof part !== "object") continue;
    const dst = out[section] as Record<string, unknown>;
    const base = DEFAULT_SETTINGS[section] as Record<string, unknown>;
    for (const key of Object.keys(base)) {
      const value = (part as Record<string, unknown>)[key];
      if (value !== undefined && typeof value === typeof base[key]) dst[key] = value;
    }
  }
  return out;
}

export function cloneSettings(s: Settings): Settings {
  return JSON.parse(JSON.stringify(s)) as Settings;
}

/** 把 patch 合并进设置，返回新对象。 */
export function applyPatch(s: Settings, patch: SettingsPatch): Settings {
  const out = cloneSettings(s);
  for (const section of Object.keys(patch) as SectionId[]) {
    const part = patch[section];
    if (part) Object.assign(out[section], part);
  }
  return out;
}

/** 把 patch 叠加到另一个 patch 上（用于防抖合并）。 */
export function mergePatch(a: SettingsPatch, b: SettingsPatch): SettingsPatch {
  const out: Record<string, Record<string, unknown>> = {};
  for (const src of [a, b] as Array<Record<string, Record<string, unknown> | undefined>>) {
    for (const section of Object.keys(src)) {
      out[section] = { ...(out[section] || {}), ...(src[section] || {}) };
    }
  }
  return out as SettingsPatch;
}

export type SystemInfo = {
  dataDir: string;
  dbBytes: number;
  events: number;
  artworks: number;
  albums: number;
  blobCount: number;
  blobBytes: number;
  port: number | null;
  version: string;
};

export function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const SETTINGS_CACHE_KEY = "wb.settings.cache";
