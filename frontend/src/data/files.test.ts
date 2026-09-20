import { describe, expect, it } from "vitest";
import { decodeStudioShotDrag, encodeStudioShotDrag } from "./files";

describe("studio shot drag payload", () => {
  it("round-trips a history shot id and original url", () => {
    const raw = encodeStudioShotDrag({ id: "abc", blobHash: "fff", url: "/api/blobs/fff", name: "nai.png" });
    expect(decodeStudioShotDrag(raw)).toEqual({
      id: "abc",
      blobHash: "fff",
      url: "/api/blobs/fff",
      name: "nai.png",
    });
    expect(decodeStudioShotDrag(`workbench-shot:${raw}`)?.id).toBe("abc");
    expect(decodeStudioShotDrag("not-json")).toBeNull();
  });
});
