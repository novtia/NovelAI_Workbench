import { DEFAULT_SETTINGS, type Settings } from "./settings";
import type { Artwork, Character, GenderId, StudioDownloadKind, StudioForm, StudioImportOpts, StudioShot, TokenStatus } from "./types";

export const LS_DRAFT = "nai-v5-draft";
export const LS_IMPORT_OPTS = "nai-v5-import-opts";
export const LS_SELECTED_SET = "nai-v5-selected-set";
export const MAX_CHARS = 22;

export const UC = {
  heavy:
    "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
  comic:
    "worst quality, bad quality, blurry, watermark, bad anatomy, extra fingers, ugly, fused face, cropped, jpeg artifacts, mutation, extra legs, missing fingers, poorly drawn hands, extra arms",
  none: "",
} as const;

export const SIZES = {
  Small: { land: [768, 512], port: [512, 768], square: [640, 640] },
  Normal: { land: [1216, 832], port: [832, 1216], square: [1024, 1024] },
  Large: { land: [1536, 1024], port: [1024, 1536], square: [1472, 1472] },
} as const;

export const PRESET_LABEL = { Small: "小", Normal: "标准", Large: "大" } as const;
export const QUALITY_LABEL = { off: "无", official: "轻度", gallery: "重度" } as const;
export const MODEL_LABEL: Record<string, string> = {
  "nai-diffusion-5-full": "V5 完整",
  "nai-diffusion-5-curated": "V5 精选",
};
export const MODE_LABEL = { anime: "动漫", furry: "兽人" } as const;
export const SAMPLER_LABEL: Record<string, string> = {
  k_euler_ancestral: "Euler Ancestral",
  k_euler: "Euler",
  k_dpmpp_2s_ancestral: "DPM++ 2S Ancestral",
  k_dpmpp_2m: "DPM++ 2M",
  k_dpmpp_2m_sde: "DPM++ 2M SDE",
  k_dpmpp_sde: "DPM++ SDE",
};
export const GENDER_PROMPT: Record<GenderId, string> = { f: "girl, ", m: "boy, ", o: "other, " };
export const GENDER_X: Record<GenderId, number> = { f: 0.28, m: 0.72, o: 0.5 };
export const PANEL = {
  leftMin: 300,
  leftMax: 640,
  leftDef: 392,
  histMin: 108,
  histMax: 480,
  histDef: 268,
  centerMin: 360,
  split: 12,
};

const CLEAN_TAGS = [
  "fur dataset",
  "ultra complexity",
  "very aesthetic",
  "best quality",
  "amazing quality",
  "absurdres",
  "masterpiece",
  "no text",
];

export function defaultChar(extra: Partial<Character> = {}): Character {
  return { prompt: "", uc: "", x: 0.5, y: 0.5, gender: "f", enabled: true, ...extra };
}

/** 设置里的「生图默认参数」由状态层注入；没注入（如单元测试）时用内置默认值。 */
let formPrefs: (() => Settings["generation"]) | null = null;

export function setFormDefaultsProvider(fn: (() => Settings["generation"]) | null) {
  formPrefs = fn;
}

export function defaultForm(): StudioForm {
  const g = formPrefs ? formPrefs() : DEFAULT_SETTINGS.generation;
  const [width, height] = SIZES[g.preset][g.aspect];
  return {
    prompt: "",
    uc: UC[g.ucPreset],
    characters: [],
    model: g.model,
    v5Mode: g.v5Mode,
    quality: g.quality,
    width,
    height,
    sampler: g.sampler,
    noiseSchedule: g.noiseSchedule,
    steps: g.steps,
    scale: g.scale,
    cfgRescale: g.cfgRescale,
    seed: -1,
    nSamples: g.nSamples,
    useCoords: false,
    straightAlpha: true,
    aspect: g.aspect,
    preset: g.preset,
  };
}

export function cloneForm(form: StudioForm): StudioForm {
  return {
    ...form,
    characters: (form.characters || []).map((c) => ({ ...c })),
  };
}

export function enabledCharacters(form: StudioForm) {
  return (form.characters || [])
    .filter((c) => c.enabled !== false)
    .map((c) => ({ prompt: c.prompt || "", uc: c.uc || "", x: c.x, y: c.y }));
}

export function formToPayload(form: StudioForm, extras: Record<string, unknown> = {}) {
  return {
    prompt: form.prompt,
    uc: form.uc,
    characters: enabledCharacters(form),
    model: form.model,
    width: form.width,
    height: form.height,
    sampler: form.sampler,
    noiseSchedule: form.noiseSchedule,
    steps: form.steps,
    scale: form.scale,
    cfgRescale: form.cfgRescale,
    seed: form.seed,
    nSamples: form.nSamples,
    quality: form.quality,
    v5Mode: form.v5Mode,
    useCoords: form.useCoords,
    straightAlpha: form.straightAlpha,
    ...extras,
  };
}

export function matchSize(w: number, h: number): { preset: StudioForm["preset"]; aspect: StudioForm["aspect"] } | null {
  for (const [preset, map] of Object.entries(SIZES) as Array<[StudioForm["preset"], (typeof SIZES)[StudioForm["preset"]]]>) {
    for (const [aspect, pair] of Object.entries(map) as Array<[StudioForm["aspect"], readonly [number, number]]>) {
      if (pair[0] === w && pair[1] === h) return { preset, aspect };
    }
  }
  return null;
}

export function sizePair(preset: StudioForm["preset"], aspect: StudioForm["aspect"]) {
  return SIZES[preset][aspect];
}

export function inferGender(text: string): GenderId {
  const parts = String(text || "")
    .toLowerCase()
    .split(/[,，\n]/);
  for (const part of parts) {
    const tag = part.trim();
    if (!tag) continue;
    if (/^(?:\d+\s*)?girls?$/.test(tag)) return "f";
    if (/^(?:\d+\s*)?boys?$/.test(tag)) return "m";
    if (tag === "other") return "o";
  }
  return "o";
}

export function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function lerpRgb(a: number[], b: number[], t: number) {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}

export function weightStyle(n: number) {
  if (n >= 1) {
    const t = clamp01((n - 1) / 2);
    return lerpRgb([255, 228, 222], [244, 168, 156], t);
  }
  const t = n >= 0 ? clamp01(1 - n) : 1;
  return lerpRgb([226, 238, 250], [168, 200, 236], t);
}

export function highlight(text: string) {
  return escapeHtml(text).replace(/(-?\d+(?:\.\d+)?)::([\s\S]*?)::/g, (_, w, body) => {
    const bg = weightStyle(parseFloat(w));
    return `<span class="tok" style="background:${bg}"><span class="w">${w}</span><span class="d">::</span>${body}<span class="end">::</span></span>`;
  });
}

/** NAI V5 的 token 总上限（进度条填满的位置，与官方界面的 Max total tokens 一致）。 */
export const TOKEN_LIMIT = 1471;

/** 只估算这一个输入框自己的 token 数，不含其他输入框。 */
export function estimateTokens(text: string) {
  return Math.round((text || "").length / 3.2);
}

export function tokenFillPercent(text: string) {
  return Math.min(100, (estimateTokens(text) / TOKEN_LIMIT) * 100);
}

export function clipPrompt(s: string, n = 16) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function withoutCleanTags(chunk: string, drop: Set<string>) {
  const bits = chunk.split(",");
  const kept: string[] = [];
  let droppedBefore = false;
  for (const bit of bits) {
    const tag = bit.trim().toLowerCase();
    if (tag && drop.has(tag)) {
      droppedBefore = true;
      continue;
    }
    kept.push(!kept.length && droppedBefore ? bit.replace(/^[ \t]+/, "") : bit);
    droppedBefore = false;
  }
  return kept.join(",");
}

export function cleanPromptText(text: string) {
  const drop = new Set(CLEAN_TAGS.map((t) => t.toLowerCase()));
  const src = String(text ?? "");
  const weight = /(-?\d*\.?\d+)::([\s\S]*?)::/g;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = weight.exec(src))) {
    out += withoutCleanTags(src.slice(last, match.index), drop);
    out += match[0];
    last = match.index + match[0].length;
  }
  out += withoutCleanTags(src.slice(last), drop);
  return out;
}

export function defaultImportOpts(): StudioImportOpts {
  return { prompt: true, uc: false, chars: true, append: false, settings: false, seed: false, clean: true };
}

export function loadImportOpts(): StudioImportOpts {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_IMPORT_OPTS) || "null") as Partial<StudioImportOpts> | null;
    return { ...defaultImportOpts(), ...(raw && typeof raw === "object" ? raw : {}) };
  } catch {
    return defaultImportOpts();
  }
}

export function persistImportOpts(opts: StudioImportOpts) {
  try {
    localStorage.setItem(LS_IMPORT_OPTS, JSON.stringify(opts));
  } catch {
    /* ignore */
  }
}

type CharRaw = {
  prompt?: string;
  uc?: string;
  char_caption?: string;
  x?: number;
  y?: number;
  center?: { x?: number; y?: number };
  centers?: Array<{ x?: number; y?: number }>;
};

export function charactersFromParams(src: Record<string, unknown> | null | undefined): Character[] {
  const p = src || {};
  const comment = (p.rawComment && typeof p.rawComment === "object" ? p.rawComment : {}) as Record<string, unknown>;
  const v4 = (p.v4Prompt || p.v4_prompt || comment.v4_prompt || {}) as {
    caption?: { char_captions?: Array<{ char_caption?: string; centers?: Array<{ x?: number; y?: number }> }> };
    use_coords?: boolean;
  };
  const v4neg = (p.v4Negative || p.v4_negative_prompt || comment.v4_negative_prompt || {}) as {
    caption?: { char_captions?: Array<{ char_caption?: string }> };
  };
  const lists = [p.characters, p.characterPrompts, comment.characterPrompts];
  let raw = lists.find(
    (list) => Array.isArray(list) && list.some((c: CharRaw) => String(c?.prompt || c?.char_caption || "").trim()),
  ) as CharRaw[] | undefined;
  if (!raw) {
    const caps = v4.caption?.char_captions || [];
    const negs = v4neg.caption?.char_captions || [];
    raw = caps.map((c, i) => ({
      prompt: c?.char_caption || "",
      uc: negs[i]?.char_caption || "",
      x: c?.centers?.[0]?.x ?? 0.5,
      y: c?.centers?.[0]?.y ?? 0.5,
    }));
  }
  return (raw || [])
    .map((c) =>
      defaultChar({
        prompt: c.prompt || c.char_caption || "",
        uc: c.uc || "",
        x: c.center?.x ?? c.x ?? c.centers?.[0]?.x ?? 0.5,
        y: c.center?.y ?? c.y ?? c.centers?.[0]?.y ?? 0.5,
      }),
    )
    .filter((c) => String(c.prompt || "").trim());
}

function num(v: unknown, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function formFromItem(item: Artwork): Partial<StudioForm> {
  const p = item.params || {};
  const v4 = p.v4Prompt as { caption?: { base_caption?: string }; use_coords?: boolean } | undefined;
  const v4neg = p.v4Negative as { caption?: { base_caption?: string } } | undefined;
  return {
    prompt: String(p.prompt || v4?.caption?.base_caption || ""),
    uc: String(p.uc || v4neg?.caption?.base_caption || UC.heavy),
    characters: charactersFromParams(p),
    model: String(p.model || "").includes("curated") ? "nai-diffusion-5-curated" : "nai-diffusion-5-full",
    width: num(p.width, item.width || 832),
    height: num(p.height, item.height || 1216),
    sampler: String(p.sampler || "k_euler_ancestral"),
    noiseSchedule: String(p.noiseSchedule || "karras"),
    steps: num(p.steps, 28),
    scale: num(p.scale, 5),
    seed: -1,
    quality: "off",
    v5Mode: p.v5Mode === "furry" ? "furry" : "anime",
    useCoords: Boolean(v4?.use_coords || p.useCoords),
    straightAlpha: p.straightAlpha !== false,
  };
}

export function formFromMeta(meta: Record<string, unknown> | null | undefined): Partial<StudioForm> {
  const src = meta || {};
  const comment = (src.rawComment && typeof src.rawComment === "object" ? src.rawComment : {}) as Record<string, unknown>;
  const v4 = src.v4Prompt as { caption?: { base_caption?: string }; use_coords?: boolean } | undefined;
  const prompt = String(src.prompt || v4?.caption?.base_caption || "");
  return {
    prompt,
    uc: String(src.uc || ""),
    characters: charactersFromParams(src),
    model: String(src.model || "").includes("curated") ? "nai-diffusion-5-curated" : "nai-diffusion-5-full",
    width: src.width != null ? Number(src.width) : undefined,
    height: src.height != null ? Number(src.height) : undefined,
    sampler: src.sampler ? String(src.sampler) : undefined,
    noiseSchedule: src.noiseSchedule ? String(src.noiseSchedule) : undefined,
    steps: src.steps != null ? Number(src.steps) : undefined,
    scale: src.scale != null ? Number(src.scale) : undefined,
    cfgRescale: Number.isFinite(Number(comment.cfg_rescale ?? comment.cfgRescale ?? src.cfgRescale))
      ? Number(comment.cfg_rescale ?? comment.cfgRescale ?? src.cfgRescale)
      : undefined,
    seed: src.seed != null ? Number(src.seed) : undefined,
    v5Mode: /\bfur dataset\b/i.test(prompt) ? "furry" : "anime",
    useCoords: Boolean(v4?.use_coords || comment.use_coords),
    quality: "off",
  };
}

export function hasImportableMeta(meta: Record<string, unknown> | null | undefined) {
  if (!meta) return false;
  const chars = charactersFromParams(meta);
  return Boolean(
    meta.prompt ||
      meta.uc ||
      meta.sampler ||
      meta.steps != null ||
      meta.seed != null ||
      meta.width ||
      chars.length ||
      meta.v4Prompt,
  );
}

export function applySizeToForm(
  form: StudioForm,
  preset?: StudioForm["preset"],
  aspect?: StudioForm["aspect"],
  custom?: [number, number],
): StudioForm {
  const next = { ...form };
  if (custom) {
    next.width = custom[0];
    next.height = custom[1];
    return next;
  }
  if (preset) next.preset = preset;
  if (aspect) next.aspect = aspect;
  const pair = SIZES[next.preset][next.aspect];
  next.width = pair[0];
  next.height = pair[1];
  return next;
}

export function mergeStudioForm(
  base: StudioForm,
  data: Partial<StudioForm> & { artists?: string; size?: string },
  opts: { replace?: boolean; mergeArtists?: boolean; mergeChars?: boolean } = {},
): StudioForm {
  const next = cloneForm(opts.replace ? defaultForm() : base);
  if (data.prompt != null) next.prompt = data.prompt;
  if (data.artists) {
    const chain = String(data.artists).trim();
    if (chain) {
      const cur = next.prompt.trim();
      if (opts.mergeArtists) next.prompt = cur ? `${chain}, ${cur}` : chain;
      else if (!cur.includes(chain)) next.prompt = cur ? `${chain}, ${cur}` : chain;
    }
  }
  if (data.uc != null) next.uc = data.uc;
  if (Array.isArray(data.characters)) {
    const mapped = data.characters.map((c) =>
      defaultChar({
        prompt: c.prompt || "",
        uc: c.uc || "",
        x: c.x ?? 0.5,
        y: c.y ?? 0.5,
        gender: inferGender(c.prompt || "") || c.gender || "f",
        enabled: c.enabled !== false,
      }),
    );
    next.characters = opts.mergeChars ? [...next.characters, ...mapped].slice(0, MAX_CHARS) : mapped;
  }
  if (data.model && MODEL_LABEL[data.model]) next.model = data.model;
  if (data.sampler && SAMPLER_LABEL[data.sampler]) next.sampler = data.sampler;
  if (data.noiseSchedule) next.noiseSchedule = data.noiseSchedule;
  if (data.steps != null && Number.isFinite(Number(data.steps))) next.steps = Number(data.steps);
  if (data.scale != null && Number.isFinite(Number(data.scale))) next.scale = Number(data.scale);
  if (data.cfgRescale != null && Number.isFinite(Number(data.cfgRescale))) next.cfgRescale = Number(data.cfgRescale);
  if (data.seed != null && Number.isFinite(Number(data.seed))) next.seed = Number(data.seed);
  if (data.nSamples != null) next.nSamples = Math.max(1, Math.min(4, Number(data.nSamples) || 1));
  if (data.quality && data.quality in QUALITY_LABEL) next.quality = data.quality;
  if (data.v5Mode === "anime" || data.v5Mode === "furry") next.v5Mode = data.v5Mode;
  if (data.useCoords != null) next.useCoords = Boolean(data.useCoords);
  if (data.straightAlpha != null) next.straightAlpha = Boolean(data.straightAlpha);
  let w = Number(data.width);
  let h = Number(data.height);
  if ((!w || !h) && data.size && data.size !== "custom") {
    const parts = String(data.size).split("x").map(Number);
    w = parts[0];
    h = parts[1];
  }
  if (w && h) {
    const found = matchSize(w, h);
    if (found) {
      next.preset = found.preset;
      next.aspect = found.aspect;
      next.width = w;
      next.height = h;
    } else {
      next.width = w;
      next.height = h;
    }
  }
  return next;
}

export function shotFromJobItem(
  item: { id?: string; url?: string; thumbUrl?: string; blobHash?: string; width?: number | null; height?: number | null; name?: string; albumId?: string },
  meta: Record<string, unknown>,
): StudioShot | null {
  const id = item.id || item.blobHash;
  if (!id) return null;
  return {
    id,
    url: item.url || (item.blobHash ? `/api/blobs/${item.blobHash}` : ""),
    thumbUrl: item.thumbUrl || item.url || (item.blobHash ? `/api/blobs/${item.blobHash}` : ""),
    blobHash: item.blobHash,
    width: item.width,
    height: item.height,
    name: item.name,
    meta: meta || {},
    savedId: item.albumId ? item.id : "",
  };
}

export function accountLabel(status?: TokenStatus | null) {
  const anlas = status?.subscription?.anlas;
  if (typeof anlas === "number") return `额度: ${anlas}`;
  return "额度: —";
}

export function formatTokenStatus(data?: TokenStatus | null) {
  if (!data?.configured) return "未配置 Token";
  const sub = data.subscription;
  if (sub) {
    const name = sub.tierName || (sub.opus ? "Opus" : "订阅中");
    return `${name} · Anlas ${sub.anlas} · ${data.hint || ""}`.trim();
  }
  if (data.error) return `${data.hint || "已保存"} · ${data.error}`;
  return data.hint || "已保存 Token";
}

export function tokenDotClass(data?: TokenStatus | null) {
  if (!data?.configured) return "";
  if (data.subscription) return "ok";
  if (data.error) return "err";
  return "ok";
}

export function opusLevel(over: boolean, n: number) {
  if (over || n <= 0) return "empty";
  if (n >= 50) return "high";
  if (n >= 20) return "mid";
  return "low";
}

export type OpusMeter = {
  level: string;
  fill: number;
  shown: string;
  title: string;
};

export function opusMeter(data?: TokenStatus | null): OpusMeter {
  const sub = data?.subscription;
  const opus = Boolean(sub?.opus);
  const pct = sub?.usagePercent;
  let level = "off";
  let fill = 0;
  let shown = "—";
  let title = "Opus 额度";
  if (!data) {
    shown = "!";
    title = "无法读取额度";
  } else if (!data.configured) {
    title = "未配置 Token";
  } else if (data.error && !sub) {
    shown = "!";
    title = data.error;
  } else if (opus && pct != null && Number.isFinite(Number(pct))) {
    const n = Math.max(0, Math.min(100, Number(pct)));
    const over = Boolean(sub?.usageNegative);
    level = opusLevel(over, n);
    fill = over ? 0 : n;
    shown = over ? "0" : String(Math.round(n));
    title = over ? `Opus 额度已超额（${Math.round(n)}%）` : `剩余 ${Math.round(n)}% Opus 额度`;
  } else if (sub && !opus) {
    title = `${sub.tierName || "非 Opus"} · Anlas ${sub.anlas}`;
  } else if (sub) {
    title = `${sub.tierName || "Opus"} · Anlas ${sub.anlas ?? "—"}`;
  }
  return { level, fill, shown, title };
}

export function costLabel(status?: TokenStatus | null) {
  return status?.subscription?.opus ? "0" : "—";
}

export function genLabel(nSamples: number, busy: boolean, progress: string) {
  if (busy) return progress || "生成中";
  return nSamples === 1 ? "生成 1 张" : `生成 ${nSamples} 张`;
}

export function studioDownloadName(name?: string, id?: string, kind: StudioDownloadKind = "original", seed?: number | null) {
  const raw = String(name || "")
    .trim()
    .replace(/\.(png|webp|jpe?g)$/i, "");
  const label = raw && raw !== "nai" && raw !== "生成中" ? raw : "nai";
  const seedPart = seed != null && Number.isFinite(Number(seed)) && Number(seed) >= 0 ? `s${Math.trunc(Number(seed))}` : "";
  const mark = String(id || "")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8);
  const base = [label, seedPart, mark].filter(Boolean).join("-");
  return kind === "clean" ? `${base}-nodata.png` : `${base}.png`;
}

export function placePop(trig: DOMRect, popW: number, popH: number, preferUp: boolean, vw: number, vh: number) {
  const gap = 6;
  let left = trig.left;
  if (left + popW > vw - 8) left = vw - 8 - popW;
  if (left < 8) left = 8;
  let top = preferUp ? trig.top - popH - gap : trig.bottom + gap;
  if (top + popH > vh - 8) top = trig.top - popH - gap;
  if (top < 8) top = 8;
  return { left: Math.round(left), top: Math.round(top) };
}

export function clampPanel(value: number, min: number, max: number) {
  return Math.round(Math.max(min, Math.min(max, value)));
}

export function loadDraft(): StudioForm | null {
  try {
    const raw = localStorage.getItem(LS_DRAFT);
    if (!raw) return null;
    return mergeStudioForm(defaultForm(), JSON.parse(raw) as Partial<StudioForm>, { replace: true });
  } catch {
    return null;
  }
}

export function persistDraft(form: StudioForm) {
  try {
    localStorage.setItem(LS_DRAFT, JSON.stringify(cloneForm(form)));
  } catch {
    /* ignore */
  }
}

export function loadSelectedSet() {
  try {
    return localStorage.getItem(LS_SELECTED_SET) || "";
  } catch {
    return "";
  }
}

export function persistSelectedSet(id: string) {
  try {
    if (id) localStorage.setItem(LS_SELECTED_SET, id);
    else localStorage.removeItem(LS_SELECTED_SET);
  } catch {
    /* ignore */
  }
}
