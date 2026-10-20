/**
 * 图片地址。后端通过 Tauri 自定义协议 `wb` 直接提供文件：
 * Windows（WebView2）上协议要写成 `http://wb.localhost`，其它平台是 `wb://localhost`。
 */
const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent || "");

export const ASSET_BASE = IS_WINDOWS ? "http://wb.localhost" : "wb://localhost";

export function blobUrl(hash: string): string {
  return `${ASSET_BASE}/blobs/${hash}`;
}

export function itemImageUrl(id: string): string {
  return `${ASSET_BASE}/items/${encodeURIComponent(id)}/image`;
}

export function itemThumbUrl(id: string): string {
  return `${ASSET_BASE}/items/${encodeURIComponent(id)}/thumb`;
}

export function isAssetUrl(src: string): boolean {
  return src.startsWith(`${ASSET_BASE}/`);
}
