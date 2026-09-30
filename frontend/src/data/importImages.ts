import { galleryApi } from "@/api";
import { ApiError } from "@/api/client";
import { mapPool } from "./files";
import { isImageFile, type ImageMeta } from "./png";
import { uniqueArtistKeys } from "./singleArtist";

type Prepared = { name: string; type: string; hash: string; params: ImageMeta; thumb: ArrayBuffer; width: number; height: number };

function prepareInWorker(file: File, worker: Worker, id: number) {
  return new Promise<Prepared>((resolve, reject) => {
    const onMessage = (e: MessageEvent<Prepared & { id: number; error?: string }>) => {
      if (e.data.id !== id) return;
      worker.removeEventListener("message", onMessage);
      if (e.data.error || !e.data.params) reject(new Error(e.data.error || "解析失败"));
      else resolve(e.data);
    };
    worker.addEventListener("message", onMessage);
    void file.arrayBuffer().then((buffer) => {
      worker.postMessage({ id, buffer, name: file.name, type: file.type }, [buffer]);
    });
  });
}

export type ImportResult = { added: number; dup: number; noMeta: number; rejected: number };

export async function importImageFiles(
  fileList: Iterable<File>,
  albumId: string,
  onProgress: (done: number, total: number) => void,
  opts?: { singleArtist?: boolean },
): Promise<ImportResult> {
  const files = [...fileList].filter(isImageFile);
  if (!files.length) return { added: 0, dup: 0, noMeta: 0, rejected: 0 };

  let done = 0;
  let added = 0;
  let dup = 0;
  let noMeta = 0;
  let rejected = 0;
  let seq = 0;
  onProgress(0, files.length);
  const workers = [0, 1].map(() => new Worker(new URL("./import.worker.ts", import.meta.url), { type: "module" }));

  try {
  await mapPool(files, 2, async (file) => {
    const worker = workers[seq % workers.length];
    const id = ++seq;
    try {
      const prepared = await prepareInWorker(file, worker, id);
      if (await galleryApi.hashExists(albumId, prepared.hash)) {
        dup += 1;
        return;
      }
      const blob = file;
      const params = prepared.params;
      if (opts?.singleArtist && uniqueArtistKeys(params.artists).length !== 1) {
        rejected += 1;
        return;
      }
      try {
        await galleryApi.importItem(
          albumId,
          blob,
          {
            name: file.name,
            artists: params.artists,
            artistLine: params.artistLine,
            params,
            width: prepared.width,
            height: prepared.height,
            hash: prepared.hash,
          },
          new Blob([prepared.thumb], { type: "image/webp" }),
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          dup += 1;
          return;
        }
        if (err instanceof ApiError && err.status === 400 && opts?.singleArtist) {
          rejected += 1;
          return;
        }
        throw err;
      }
      added += 1;
      if (params.source === "none") noMeta += 1;
    } catch (err) {
      console.warn(file.name, err);
    } finally {
      done += 1;
      onProgress(done, files.length);
    }
  });
  } finally {
    workers.forEach((worker) => worker.terminate());
  }

  return { added, dup, noMeta, rejected };
}
