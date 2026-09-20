import { describe, expect, it } from "vitest";
import { tagKey } from "./hashKey";

describe("tag key", () => {
  it("normalizes artist names", () => {
    expect(tagKey("Artist: Foo_Bar")).toBe("foo bar");
  });
});
