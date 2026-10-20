import { describe, expect, it } from "vitest";
import { packImport } from "./gallery";
import { ApiError } from "./client";
import { ASSET_BASE, blobUrl, isAssetUrl, itemImageUrl } from "./assets";

describe("packImport", () => {
  it("按 u32le 头长度 | 头 JSON | 缩略图 | 原图 排布", async () => {
    const file = new Blob([new Uint8Array([9, 9, 9, 9, 9])]);
    const thumb = new Blob([new Uint8Array([1, 2, 3])]);
    const out = await packImport("album-1", file, { name: "a.png", artists: ["x"] }, thumb);
    const headLen = new DataView(out.buffer).getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(out.slice(4, 4 + headLen)));
    expect(head).toEqual({ albumId: "album-1", meta: { name: "a.png", artists: ["x"] }, thumbLen: 3 });
    expect([...out.slice(4 + headLen, 4 + headLen + 3)]).toEqual([1, 2, 3]);
    expect([...out.slice(4 + headLen + 3)]).toEqual([9, 9, 9, 9, 9]);
  });

  it("没有缩略图时 thumbLen 为 0", async () => {
    const out = await packImport("a", new Blob([new Uint8Array([7])]), {});
    const headLen = new DataView(out.buffer).getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(out.slice(4, 4 + headLen)));
    expect(head.thumbLen).toBe(0);
    expect([...out.slice(4 + headLen)]).toEqual([7]);
  });

  it("头里含中文时按 UTF-8 字节计算长度", async () => {
    const out = await packImport("相册", new Blob([new Uint8Array([1])]), { name: "图" });
    const headLen = new DataView(out.buffer).getUint32(0, true);
    expect(JSON.parse(new TextDecoder().decode(out.slice(4, 4 + headLen))).albumId).toBe("相册");
    expect(out.length).toBe(4 + headLen + 1);
  });
});

describe("assets", () => {
  it("生成协议地址并能识别", () => {
    expect(blobUrl("abc")).toBe(`${ASSET_BASE}/blobs/abc`);
    expect(itemImageUrl("a b")).toBe(`${ASSET_BASE}/items/a%20b/image`);
    expect(isAssetUrl(blobUrl("abc"))).toBe(true);
    expect(isAssetUrl("/temp/x.png")).toBe(false);
  });
});

describe("ApiError", () => {
  it("保留状态码", () => {
    const e = new ApiError("没有这张图", 404);
    expect(e.status).toBe(404);
    expect(e.message).toBe("没有这张图");
  });
});
