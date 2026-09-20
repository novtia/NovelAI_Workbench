import { isImageFile } from "./png";

function readEntry(entry: FileSystemEntry | null): Promise<File[]> {
  return new Promise((resolve) => {
    if (!entry) {
      resolve([]);
      return;
    }
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file(
        (file) => resolve([file]),
        () => resolve([]),
      );
      return;
    }
    if (!entry.isDirectory) {
      resolve([]);
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const all: FileSystemEntry[] = [];
    const next = () => {
      reader.readEntries(
        async (entries) => {
          if (!entries.length) {
            const nested = await Promise.all(all.map(readEntry));
            resolve(nested.flat());
            return;
          }
          all.push(...entries);
          next();
        },
        () => resolve([]),
      );
    };
    next();
  });
}

export async function filesFromDataTransfer(dt: DataTransfer | null) {
  if (!dt) return [];
  const files: File[] = [];
  if (dt.items?.length) {
    const tasks: Array<Promise<File[]>> = [];
    for (const item of [...dt.items]) {
      const entry = item.webkitGetAsEntry?.() ?? null;
      if (entry) tasks.push(readEntry(entry));
      else if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    const nested = await Promise.all(tasks);
    for (const n of nested.flat()) files.push(n);
  } else {
    files.push(...[...dt.files]);
  }
  return files.filter(isImageFile);
}

export function filesFromClipboard(dt: DataTransfer | null) {
  if (!dt) return [];
  return [...dt.files].filter(isImageFile);
}

export type StudioShotDrag = {
  id: string;
  blobHash?: string;
  url?: string;
  name?: string;
};

export const STUDIO_SHOT_DRAG = "application/x-workbench-shot";
const STUDIO_SHOT_TEXT = "workbench-shot:";

export function encodeStudioShotDrag(shot: StudioShotDrag) {
  return JSON.stringify({
    id: shot.id,
    blobHash: shot.blobHash || "",
    url: shot.url || "",
    name: shot.name || "",
  });
}

export function decodeStudioShotDrag(raw: string | null | undefined): StudioShotDrag | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const json = text.startsWith(STUDIO_SHOT_TEXT) ? text.slice(STUDIO_SHOT_TEXT.length) : text;
  try {
    const parsed = JSON.parse(json) as StudioShotDrag;
    if (parsed && typeof parsed.id === "string" && parsed.id) return parsed;
  } catch {
    return null;
  }
  return null;
}

export function writeStudioShotDrag(dt: DataTransfer, shot: StudioShotDrag) {
  const raw = encodeStudioShotDrag(shot);
  dt.effectAllowed = "copy";
  dt.setData(STUDIO_SHOT_DRAG, raw);
  dt.setData("text/plain", `${STUDIO_SHOT_TEXT}${raw}`);
}

export function readStudioShotDrag(dt: DataTransfer | null): StudioShotDrag | null {
  if (!dt) return null;
  return decodeStudioShotDrag(dt.getData(STUDIO_SHOT_DRAG) || dt.getData("text/plain"));
}

export function hasStudioShotPayload(dt: DataTransfer | null) {
  if (!dt) return false;
  return [...dt.types].includes(STUDIO_SHOT_DRAG);
}

export function hasFilePayload(e: DragEvent) {
  return Boolean(e.dataTransfer && [...e.dataTransfer.types].includes("Files"));
}

export function hasDropPayload(e: DragEvent) {
  return hasFilePayload(e) || hasStudioShotPayload(e.dataTransfer);
}

export async function fileFromShotRef(shot: StudioShotDrag): Promise<File | null> {
  const src = String(shot.url || (shot.blobHash ? `/api/blobs/${shot.blobHash}` : "")).trim();
  if (!src) return null;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size) return null;
    const name = String(shot.name || "nai.png").replace(/\.(webp|jpe?g)$/i, ".png");
    return new File([blob], /\.png$/i.test(name) ? name : `${name}.png`, { type: blob.type || "image/png" });
  } catch {
    return null;
  }
}

export async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item !== undefined) await fn(item);
      }
    }),
  );
}
