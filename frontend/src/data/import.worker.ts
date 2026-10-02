import { makeThumb, parseImageMeta, sha256Hex } from "./png";
import type { ImageMeta } from "./png";

type Req = { id: number; buffer: ArrayBuffer; name: string; type: string; thumbSize?: number; thumbQuality?: number };
type Res = {
  id: number;
  name: string;
  type: string;
  hash: string;
  params: ImageMeta | null;
  thumb: ArrayBuffer;
  width: number;
  height: number;
  error?: string;
};

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, buffer, name, type, thumbSize, thumbQuality } = e.data;
  try {
    const hash = await sha256Hex(buffer);
    const blob = new Blob([buffer], { type: type || "image/png" });
    const [params, thumb] = await Promise.all([parseImageMeta(blob, buffer), makeThumb(blob, thumbSize, thumbQuality)]);
    const thumbBuf = await thumb.blob.arrayBuffer();
    const res: Res = { id, name, type, hash, params, thumb: thumbBuf, width: thumb.width, height: thumb.height };
    self.postMessage(res, { transfer: [thumbBuf] });
  } catch (err) {
    const res: Res = { id, name, type, hash: "", params: null, thumb: new ArrayBuffer(0), width: 0, height: 0, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(res);
  }
};
