import { stripArtist, tagKey } from "./hashKey";
import type { Artwork, DrawBatch, DrawResult, DrawRow, Job, LotteryBoard, LotteryControls, LotShot, PoolArtist } from "./types";

export const BAR_COLORS = ["#bc4a32", "#c98a3d", "#8a9a4b", "#3f8f66", "#4a7fb5", "#7c5fb0", "#b5537a", "#5a8f8a"];

export const DEFAULT_CONTROLS: LotteryControls = {
  min: 3,
  max: 5,
  draws: 8,
  target: 1,
  wmin: 0.05,
  wmax: 1,
  jitter: 0.6,
  boost: 0.4,
};

export const EMPTY_BOARD: LotteryBoard = {
  albumId: null,
  excluded: [],
  pinned: [],
  weightCaps: {},
  controls: { ...DEFAULT_CONTROLS },
  version: 0,
};

export function padNumericClosers(text: string) {
  return String(text || "").replace(/(-?\d*\.?\d+)\s*::\s*([\s\S]*?)\s*::/g, (_, w, body) => {
    const inner = String(body).replace(/\s+$/, "");
    return `${w}::${/\d$/.test(inner) ? `${inner} ` : inner}::`;
  });
}

export function chainText(text: string) {
  return padNumericClosers(text);
}

function cleanTag(raw: string) {
  return raw.replace(/^[:：\s]+/, "").replace(/[:：\s]+$/, "").trim();
}

function splitTags(chunk: string) {
  return chunk
    .split(/[,，\n\r]+/)
    .map(cleanTag)
    .filter(Boolean);
}

export function parseEntries(text: string) {
  const entries: Array<{ weight: number; tags: string[]; hadWeight: boolean }> = [];
  const block = /(-?\d*\.?\d+)\s*::\s*([\s\S]*?)\s*::/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  const src = String(text || "");

  const pushLoose = (chunk: string) => {
    chunk.split(/[,，\n\r]+/).forEach((piece) => {
      const open = piece.trim().match(/^(-?\d*\.?\d+)\s*::\s*(.+)$/);
      if (open) {
        const tag = cleanTag(open[2]);
        if (tag) entries.push({ weight: Number(open[1]), tags: [tag], hadWeight: true });
        return;
      }
      const tag = cleanTag(piece);
      if (tag) entries.push({ weight: 1, tags: [tag], hadWeight: false });
    });
  };

  while ((m = block.exec(src)) !== null) {
    pushLoose(src.slice(cursor, m.index));
    const tags = splitTags(m[2]);
    if (tags.length) entries.push({ weight: Number(m[1]), tags, hadWeight: true });
    cursor = block.lastIndex;
  }
  pushLoose(src.slice(cursor));
  return entries;
}

export function parseCapInput(raw: string): number | "" | false {
  const s = String(raw ?? "").trim().replace(",", ".");
  if (!s) return "";
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return false;
  return Math.round(n * 100) / 100;
}

function weightLookup(text: string) {
  const map = new Map<string, number>();
  for (const e of parseEntries(text)) {
    for (const tag of e.tags) {
      const key = tagKey(tag);
      if (!key) continue;
      map.set(key, Math.max(map.get(key) || 0, e.weight));
    }
  }
  return map;
}

export function collectArtistPool(items: Array<Pick<Artwork, "artists" | "artistLine" | "params">>): PoolArtist[] {
  const map = new Map<string, PoolArtist>();
  for (const item of items) {
    const weights = weightLookup(
      [String(item.params?.artistChain || ""), item.artistLine, String(item.params?.prompt || "")].filter(Boolean).join(", "),
    );
    const seen = new Set<string>();
    for (const name of item.artists || []) {
      const key = tagKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const weight = weights.get(key) || 1;
      const rec = map.get(key);
      if (!rec) map.set(key, { key, name, tag: `artist:${name}`, weight });
      else rec.weight = Math.max(rec.weight, weight);
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

export function isListed(list: string[], artist: { key: string; name?: string; tag?: string }) {
  return list.includes(artist.key) || (artist.name ? list.includes(artist.name) : false) || (artist.tag ? list.includes(artist.tag) : false);
}

export function clampControls(controls: LotteryControls, activeCount: number, pinnedCount: number): LotteryControls {
  const cap = Math.max(activeCount, 1);
  const floor = Math.max(1, pinnedCount);
  let min = Math.max(Math.round(controls.min) || 1, floor);
  let max = Math.max(Math.round(controls.max) || min, floor);
  if (min > max) [min, max] = [max, min];
  min = Math.min(min, cap);
  max = Math.min(max, cap);
  const draws = Math.min(Math.max(Math.round(controls.draws) || 8, 1), 50);
  const target = Number(controls.target);
  let wmin = Number(controls.wmin);
  let wmax = Number(controls.wmax);
  if (!Number.isFinite(wmin) || wmin < 0.01) wmin = 0.05;
  if (!Number.isFinite(wmax) || wmax < 0.01) wmax = 1;
  if (wmin > wmax) [wmin, wmax] = [wmax, wmin];
  const jitter = Math.min(Math.max(Number(controls.jitter) || 0, 0), 1);
  const boost = Number.isFinite(controls.boost) ? controls.boost : 0.4;
  return {
    min,
    max,
    draws,
    target: Number.isFinite(target) ? target : 1,
    wmin: Math.round(wmin * 100) / 100,
    wmax: Math.round(wmax * 100) / 100,
    jitter,
    boost,
    presetId: controls.presetId,
  };
}

export function normalizeBoard(raw: Record<string, unknown> | LotteryBoard | null | undefined): LotteryBoard {
  const data = (raw || {}) as Partial<LotteryBoard> & { weightCaps?: Record<string, number> };
  const controls = { ...DEFAULT_CONTROLS, ...(data.controls || {}) };
  return {
    id: data.id,
    albumId: data.albumId ?? null,
    excluded: Array.isArray(data.excluded) ? data.excluded.map(String) : [],
    pinned: Array.isArray(data.pinned) ? data.pinned.map(String) : [],
    weightCaps: data.weightCaps && typeof data.weightCaps === "object" ? { ...data.weightCaps } : {},
    controls,
    version: data.version ?? 0,
  };
}

export function boardPayload(board: Pick<LotteryBoard, "albumId" | "excluded" | "pinned" | "weightCaps" | "controls">, extra?: Partial<LotteryControls>) {
  const controls = { ...board.controls, ...extra };
  return {
    albumId: board.albumId,
    excluded: board.excluded,
    pinned: board.pinned,
    weightCaps: board.weightCaps,
    controls,
  };
}

export function sortedDrawRows(draw: DrawResult): DrawRow[] {
  return [...(draw.rows || [])].sort((a, b) => b.cents - a.cents);
}

export function drawSum(draw: DrawResult, rows = sortedDrawRows(draw)) {
  const total = rows.reduce((a, r) => a + r.cents, 0) || 1;
  const cents = draw.newCents ?? total;
  return { total, sum: (cents / 100).toFixed(2) };
}

export function rowName(row: DrawRow) {
  return stripArtist(row.tags[0] || "");
}

export function jobIsActive(job?: Job | null) {
  return Boolean(job && (job.status === "queued" || job.status === "running"));
}

export function jobProgressText(job?: Job | null) {
  if (!job) return "排队中";
  return job.progress?.text || (job.status === "queued" ? "排队中" : "生成中");
}

export function previewUrl(it?: { url?: string; id?: string; blobHash?: string } | null) {
  if (!it) return "";
  if (it.url && it.url !== "undefined") return it.url;
  if (it.blobHash) return `/api/blobs/${it.blobHash}`;
  const id = String(it.id || "");
  if (/^[a-f0-9]{32}$/i.test(id)) return `/temp/${id}.png`;
  if (id) return `/api/items/${encodeURIComponent(id)}/image`;
  return "";
}

export function liveSrc(raw?: string | null) {
  if (!raw) return "";
  const s = String(raw);
  if (s.startsWith("data:") || s.startsWith("blob:")) return s;
  if (s.startsWith("/temp/") || s.startsWith("/cache/") || s.startsWith("/api/")) return s;
  return s;
}

export function drawIdOf(batchId: string, draw?: { id?: string } | null, index?: number) {
  const id = String(draw?.id || "").trim();
  if (id) return id;
  if (index != null && Number.isFinite(index) && index >= 0) return `${batchId}:${index}`;
  return "";
}

export function lotteryJobDrawId(job?: Job | null) {
  if (!job) return "";
  const drawId = String(job.client?.drawId || "").trim();
  if (drawId) return drawId;
  const batchId = String(job.client?.batchId || "");
  const idx = job.client?.drawIndex;
  if (batchId && idx != null && Number.isFinite(Number(idx))) return `${batchId}:${Number(idx)}`;
  return "";
}

export function lotteryJobHits(jobs: Job[], batchId: string, drawId: string) {
  if (!drawId) return [];
  return jobs.filter((j) => j.source === "lottery" && String(j.client?.batchId || "") === batchId && lotteryJobDrawId(j) === drawId);
}

export function resolveDrawJob(jobs: Job[], batchId: string, drawId: string) {
  const hits = lotteryJobHits(jobs, batchId, drawId);
  const active = hits.find((j) => jobIsActive(j)) || null;
  const done = hits.find((j) => j.status === "done" && j.items?.length) || null;
  const job = active || done || hits[0] || null;
  const shots = (active?.items?.length ? active.items : done?.items) || job?.items || [];
  return { hits, active, done, job, shots };
}

export function storedDrawShots(draw?: DrawResult | null): LotShot[] {
  return Array.isArray(draw?.previews) ? draw.previews : [];
}

export function resolveDrawVisual(jobs: Job[], batchId: string, drawId: string, draw?: DrawResult | null) {
  const resolved = resolveDrawJob(jobs, batchId, drawId);
  const stored = storedDrawShots(draw);
  const shots = resolved.active
    ? resolved.active.items?.length
      ? resolved.active.items
      : stored
    : stored.length
      ? stored
      : resolved.shots;
  return { ...resolved, shots };
}

export function applyJobToBatches(batches: DrawBatch[] | undefined, job: Job): DrawBatch[] | undefined {
  if (!batches?.length) return batches;
  if (job.source !== "lottery" || job.status !== "done" || !job.items?.length) return batches;
  const batchId = String(job.client?.batchId || "");
  const drawId = lotteryJobDrawId(job);
  if (!batchId || !drawId) return batches;
  let touched = false;
  const next = batches.map((batch) => {
    if (batch.id !== batchId) return batch;
    return {
      ...batch,
      draws: batch.draws.map((draw, i) => {
        if (drawIdOf(batch.id, draw, i) !== drawId) return draw;
        touched = true;
        return { ...draw, previews: job.items, jobId: job.id };
      }),
    };
  });
  return touched ? next : batches;
}

export function matchDrawJob(jobs: Job[], batchId: string, drawId: string) {
  return resolveDrawJob(jobs, batchId, drawId).job;
}

export function triggerRect(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

export function batchIndex(batches: Array<{ id: string; createdAt: number }>, id: string) {
  const ordered = [...batches].sort((a, b) => a.createdAt - b.createdAt);
  const i = ordered.findIndex((b) => b.id === id);
  return i >= 0 ? i + 1 : 0;
}

export function placeLotPop(w: number, h: number, trigger: { left: number; top: number; right: number; bottom: number; width: number; height: number }) {
  const gap = 6;
  let left = trigger.right - w;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
  if (left < 8) left = 8;
  let top = trigger.top - h - gap;
  if (top < 8) top = trigger.bottom + gap;
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - h);
  return { left: Math.round(left), top: Math.round(top) };
}

export function lotteryPrompt(chain: string, extra: string) {
  const a = chainText(chain).trim();
  const b = String(extra || "").trim();
  if (a && b) return `${a}, ${b}`;
  return a || b;
}
