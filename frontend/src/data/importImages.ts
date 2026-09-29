import { galleryApi } from "@/api";
import { ApiError } from "@/api/client";
import { mapPool } from "./files";
import { isImageFile, makeThumb, parseImageMeta, sha256Hex } from "./png";
import { uniqueArtistKeys } from "./singleArtist";

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
  onProgress(0, files.length);

  await mapPool(files, 2, async (file) => {
    try {
      const buffer = await file.arrayBuffer();
      const hash = await sha256Hex(buffer);
      if (await galleryApi.hashExists(albumId, hash)) {
        dup += 1;
        return;
      }
      const blob = new Blob([buffer], { type: file.type || "image/png" });
      const imageFile = new File([blob], file.name, { type: blob.type });
      const [params, thumb] = await Promise.all([parseImageMeta(imageFile, buffer), makeThumb(blob)]);
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
            width: thumb.width,
            height: thumb.height,
            hash,
          },
          thumb.blob,
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

  return { added, dup, noMeta, rejected };
}
