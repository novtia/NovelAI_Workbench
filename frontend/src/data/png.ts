import { tagKey } from "./hashKey";
import { ARTIST_RE } from "./singleArtist";

export const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export type CharCaption = {
  char_caption?: string;
  centers?: Array<{ x: number; y: number }>;
};

export type ImageMeta = {
  source: "png-text" | "stealth" | "none";
  software: string;
  model: string;
  title: string;
  generatedAt: string;
  prompt: string;
  uc: string;
  steps: number | null;
  sampler: string;
  scale: number | null;
  seed: number | null;
  width: number | null;
  height: number | null;
  noiseSchedule: string;
  requestType: string;
  v4Prompt: { caption?: { base_caption?: string; char_captions?: CharCaption[] } } | null;
  v4Negative: { caption?: { base_caption?: string } } | null;
  rawComment: Record<string, unknown>;
  artists: string[];
  artistLine: string;
  artistChain: string;
};

function decodeText(bytes: Uint8Array, utf8 = true) {
  return new TextDecoder(utf8 ? "utf-8" : "iso-8859-1", { fatal: false }).decode(bytes);
}

function readU32(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

async function inflate(data: Uint8Array, format: CompressionFormat) {
  const ds = new DecompressionStream(format);
  const stream = new Blob([data.slice()]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function splitNull(data: Uint8Array): [Uint8Array, Uint8Array] {
  const i = data.indexOf(0);
  if (i < 0) return [data, new Uint8Array()];
  return [data.subarray(0, i), data.subarray(i + 1)];
}

function tryJson(value: unknown) {
  if (typeof value !== "string") return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isPng(bytes: Uint8Array) {
  return bytes.length >= 8 && PNG_SIG.every((b, i) => bytes[i] === b);
}

function readChunks(bytes: Uint8Array) {
  const chunks: Array<{ type: string; data: Uint8Array }> = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = decodeText(bytes.subarray(offset + 4, offset + 8), false);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) break;
    chunks.push({ type, data: bytes.subarray(start, end) });
    offset = end + 4;
    if (type === "IEND") break;
  }
  return chunks;
}

async function decodeZtxt(data: Uint8Array) {
  const [keyBytes, rest] = splitNull(data);
  if (!rest.length || rest[0] !== 0) return null;
  const raw = await inflate(rest.subarray(1), "deflate");
  return { key: decodeText(keyBytes, false), text: decodeText(raw) };
}

function decodeTextChunk(data: Uint8Array) {
  const [keyBytes, textBytes] = splitNull(data);
  return { key: decodeText(keyBytes, false), text: decodeText(textBytes) };
}

async function decodeItxt(data: Uint8Array) {
  const [keyBytes, rest] = splitNull(data);
  if (rest.length < 2) return null;
  const compressed = rest[0] === 1;
  let p = 2;
  const skipNull = () => {
    const i = rest.indexOf(0, p);
    p = i < 0 ? rest.length : i + 1;
  };
  skipNull();
  skipNull();
  let textBytes = rest.subarray(p);
  if (compressed) textBytes = await inflate(textBytes, "deflate");
  return { key: decodeText(keyBytes, false), text: decodeText(textBytes) };
}

async function parsePngText(buffer: ArrayBuffer | Uint8Array) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (!isPng(bytes)) return null;
  const fields: Record<string, string> = {};
  for (const chunk of readChunks(bytes)) {
    let pair: { key: string; text: string } | null = null;
    try {
      if (chunk.type === "tEXt") pair = decodeTextChunk(chunk.data);
      else if (chunk.type === "zTXt") pair = await decodeZtxt(chunk.data);
      else if (chunk.type === "iTXt") pair = await decodeItxt(chunk.data);
    } catch {
      pair = null;
    }
    if (pair?.key && pair.text != null && fields[pair.key] == null) fields[pair.key] = pair.text;
  }
  return Object.keys(fields).length ? fields : null;
}

class BitReader {
  pos = 0;
  constructor(
    private readBit: (i: number) => number,
    private limit: number,
  ) {}
  readByte() {
    let byte = 0;
    for (let i = 0; i < 8; i++) {
      if (this.pos >= this.limit) return -1;
      byte = (byte << 1) | (this.readBit(this.pos++) & 1);
    }
    return byte;
  }
  readBytes(n: number) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const b = this.readByte();
      if (b < 0) return out.subarray(0, i);
      out[i] = b;
    }
    return out;
  }
  readU32() {
    const b = this.readBytes(4);
    if (b.length < 4) return null;
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }
}

function alphaBitReader(imageData: ImageData) {
  const { data, width, height } = imageData;
  return new BitReader((i) => {
    const x = Math.floor(i / height);
    const y = i % height;
    return data[(y * width + x) * 4 + 3];
  }, width * height);
}

function rgbBitReader(imageData: ImageData) {
  const { data, width, height } = imageData;
  return new BitReader((i) => {
    const pixel = Math.floor(i / 3);
    const channel = i % 3;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    return data[(y * width + x) * 4 + channel];
  }, width * height * 3);
}

async function decodeStealthPayload(reader: BitReader) {
  const magics = ["stealth_pngcomp", "stealth_pnginfo", "stealth_rgbcomp", "stealth_rgbinfo"];
  const head = reader.readBytes(16);
  if (head.length < 16) return null;
  const magic = decodeText(head, false);
  const matched = magics.find((m) => magic.startsWith(m));
  if (!matched) return null;
  const bitLen = reader.readU32();
  if (bitLen == null || bitLen === 0) return null;
  const byteLen = Math.floor(bitLen / 8);
  if (byteLen <= 0 || byteLen > 8 * 1024 * 1024) return null;
  const payload = reader.readBytes(byteLen);
  if (payload.length < byteLen) return null;
  const raw = matched.endsWith("comp") ? await inflate(payload, "gzip") : payload;
  const json = JSON.parse(decodeText(raw)) as Record<string, unknown>;
  if (typeof json.Comment === "string") {
    const inner = tryJson(json.Comment);
    if (inner) json.Comment = inner;
  }
  return json;
}

async function parseStealth(file: Blob) {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: true });
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  try {
    return await decodeStealthPayload(alphaBitReader(imageData));
  } catch {
    /* rgb */
  }
  try {
    return await decodeStealthPayload(rgbBitReader(imageData));
  } catch {
    return null;
  }
}

export function extractArtists(text: string) {
  if (!text) return { names: [] as string[], line: "", chain: "" };
  const names: string[] = [];
  const chunks: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(ARTIST_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = (m[2] || m[3] || "").trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = tagKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    const weight = (m[1] || "").trim();
    chunks.push(weight ? `${weight}artist:${name}::` : `artist:${name}`);
  }
  return {
    names,
    line: names.map((n) => `artist:${n}`).join(", "),
    chain: chunks.join(", "),
  };
}

function collectPromptText(comment: Record<string, unknown>, fields: Record<string, string>) {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) parts.push(v);
  };
  push(fields.Description);
  push(comment.prompt);
  const v4 = (comment.v4_prompt as { caption?: { base_caption?: string; char_captions?: CharCaption[] } } | undefined)?.caption;
  push(v4?.base_caption);
  if (Array.isArray(v4?.char_captions)) {
    for (const c of v4.char_captions) push(c?.char_caption);
  }
  return parts.join("\n");
}

function normalizeMeta(fields: Record<string, string> | null, stealth: Record<string, unknown> | null, source: ImageMeta["source"]): ImageMeta {
  const comment =
    tryJson(fields?.Comment) ||
    (stealth && typeof stealth.Comment === "object" ? (stealth.Comment as Record<string, unknown>) : tryJson(stealth?.Comment)) ||
    (stealth && !stealth.Comment ? stealth : null) ||
    {};

  const mergedFields = {
    Title: fields?.Title || String(stealth?.Title || ""),
    Description: fields?.Description || String(stealth?.Description || comment.prompt || ""),
    Software: fields?.Software || String(stealth?.Software || ""),
    Source: fields?.Source || String(stealth?.Source || ""),
    "Generation time": fields?.["Generation time"] || String(stealth?.["Generation time"] || ""),
  };

  const blob = collectPromptText(comment, mergedFields);
  const extracted = extractArtists(blob);
  const v4 = comment.v4_prompt as ImageMeta["v4Prompt"];
  const prompt = String(comment.prompt || v4?.caption?.base_caption || mergedFields.Description || "");
  const neg = comment.v4_negative_prompt as ImageMeta["v4Negative"];

  return {
    source,
    software: mergedFields.Software,
    model: mergedFields.Source,
    title: mergedFields.Title,
    generatedAt: mergedFields["Generation time"],
    prompt,
    uc: String(comment.uc || comment.negative_prompt || neg?.caption?.base_caption || ""),
    steps: typeof comment.steps === "number" ? comment.steps : null,
    sampler: String(comment.sampler || ""),
    scale: typeof comment.scale === "number" ? comment.scale : null,
    seed: typeof comment.seed === "number" ? comment.seed : null,
    width: typeof comment.width === "number" ? comment.width : null,
    height: typeof comment.height === "number" ? comment.height : null,
    noiseSchedule: String(comment.noise_schedule || ""),
    requestType: String(comment.request_type || ""),
    v4Prompt: v4 || null,
    v4Negative: neg || null,
    rawComment: comment,
    artists: extracted.names,
    artistLine: extracted.line,
    artistChain: extracted.chain || extracted.line,
  };
}

function isNaiFields(fields: Record<string, string> | null) {
  if (!fields) return false;
  if (fields.Software === "NovelAI") return true;
  const comment = tryJson(fields.Comment);
  return Boolean(comment && (comment.prompt != null || comment.sampler != null || comment.v4_prompt));
}

export async function parseImageMeta(file: Blob, buffer?: ArrayBuffer): Promise<ImageMeta> {
  const buf = buffer || (await file.arrayBuffer());
  const fields = await parsePngText(buf);
  if (isNaiFields(fields)) return normalizeMeta(fields, null, "png-text");
  const stealth = await parseStealth(file instanceof File ? file : new Blob([buf], { type: "image/png" }));
  if (stealth) return normalizeMeta(fields, stealth, "stealth");
  if (fields) return normalizeMeta(fields, null, "png-text");
  return normalizeMeta(null, null, "none");
}

export function isImageFile(file: File | null | undefined) {
  if (!file) return false;
  if (file.type.startsWith("image/")) return true;
  return /\.(png|webp|jpe?g)$/i.test(file.name || "");
}

export async function sha256Hex(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function makeThumb(file: Blob, max = 320, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx?.drawImage(bitmap, 0, 0, w, h);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/webp", quality });
  return { blob, width, height };
}

export async function reencodePngClean(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("无法导出图片");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!out) throw new Error("无法导出图片");
  return out;
}

export function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
