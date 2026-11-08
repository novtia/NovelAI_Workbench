import { describe, expect, it } from "vitest";
import type { Artwork } from "@/data/types";
import { imageBox } from "./AlbumCanvas";

function art(width?: number, height?: number): Pick<Artwork, "width" | "height"> {
  return { width, height };
}

describe("album canvas", () => {
  it("centers the selected image on its own pixel size", () => {
    const box = imageBox(art(832, 1216));
    expect(box).toEqual({ x: -416, y: -608, w: 832, h: 1216 });
  });

  it("uses a portrait fallback when the size is missing", () => {
    const box = imageBox(art());
    expect(box.w).toBe(832);
    expect(box.h).toBe(1216);
    expect(box.x).toBe(-box.w / 2);
    expect(box.y).toBe(-box.h / 2);
  });
});
