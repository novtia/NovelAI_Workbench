import { describe, expect, it } from "vitest";
import {
  applySizeToForm,
  charactersFromParams,
  cleanPromptText,
  defaultForm,
  formFromItem,
  formToPayload,
  hasImportableMeta,
  highlight,
  inferGender,
  mergeStudioForm,
  matchSize,
  formFromMeta,
  studioDownloadName,
  artworkDownloadName,
  tokenFillPercent,
  estimateTokens,
} from "./studio";

describe("studio data", () => {
  it("infers gender from leading tags", () => {
    expect(inferGender("girl, long hair")).toBe("f");
    expect(inferGender("1boy, smile")).toBe("m");
    expect(inferGender("other, hat")).toBe("o");
    expect(inferGender("long hair, smile")).toBe("o");
  });

  it("highlights weighted tokens", () => {
    const html = highlight("0.80::artist:foo::, bar");
    expect(html).toContain('class="tok"');
    expect(html).toContain("0.80");
    expect(html).toContain("artist:foo");
  });

  it("matches official sizes and applies presets", () => {
    expect(matchSize(832, 1216)).toEqual({ preset: "Normal", aspect: "port" });
    const form = applySizeToForm(defaultForm(), "Large", "land");
    expect(form.width).toBe(1536);
    expect(form.height).toBe(1024);
  });

  it("reads character captions from v4 prompt", () => {
    const chars = charactersFromParams({
      v4Prompt: {
        caption: {
          char_captions: [{ char_caption: "girl, red hair", centers: [{ x: 0.2, y: 0.4 }] }],
        },
      },
      v4Negative: { caption: { char_captions: [{ char_caption: "bad hands" }] } },
    });
    expect(chars).toHaveLength(1);
    expect(chars[0].prompt).toBe("girl, red hair");
    expect(chars[0].uc).toBe("bad hands");
    expect(chars[0].x).toBe(0.2);
  });

  it("builds form from gallery item and drops disabled characters from payload", () => {
    const form = mergeStudioForm(
      defaultForm(),
      formFromItem({
        id: "1",
        albumId: "a",
        addedAt: 0,
        name: "n.png",
        mime: "image/png",
        size: 1,
        hash: "h",
        artists: [],
        artistLine: "",
        imageUrl: "",
        thumbUrl: "",
        width: 1024,
        height: 1024,
        params: { prompt: "cat", sampler: "k_euler", steps: 20, model: "nai-diffusion-5-curated" },
      }),
    );
    expect(form.prompt).toBe("cat");
    expect(form.quality).toBe("off");
    expect(form.model).toContain("curated");
    expect(form.aspect).toBe("square");
    form.characters = [
      { prompt: "girl", uc: "", x: 0.5, y: 0.5, enabled: true },
      { prompt: "skip", uc: "", x: 0.2, y: 0.2, enabled: false },
    ];
    const payload = formToPayload(form);
    expect(payload.characters).toHaveLength(1);
    expect(payload.characters[0].prompt).toBe("girl");
  });

  it("drops muted artists from the prompt sent to generation", () => {
    const form = defaultForm();
    form.prompt = "#!0.65::artist:aoi ogata::, 1.50::artist:nnk_(nongnong)::, 1girl";
    form.uc = "#!artist:bad, lowres";
    form.characters = [
      { prompt: "#!artist:skip, girl", uc: "#![artist:hands], bad hands", x: 0.5, y: 0.5, enabled: true },
      { prompt: "#!artist:nope, skip", uc: "", x: 0.2, y: 0.2, enabled: false },
    ];
    const payload = formToPayload(form);
    expect(payload.prompt).toBe("1.50::artist:nnk_(nongnong)::, 1girl");
    expect(payload.uc).toBe("lowres");
    expect(payload.characters).toEqual([{ prompt: "girl", uc: "bad hands", x: 0.5, y: 0.5 }]);
  });

  it("cleans quality tags and detects importable meta", () => {
    expect(cleanPromptText("cat, masterpiece, best quality")).toBe("cat");
    expect(cleanPromptText("0.8::artist:foo ::, 1girl, masterpiece")).toBe("0.8::artist:foo ::, 1girl");
    expect(cleanPromptText("1girl,  solo")).toBe("1girl,  solo");
    expect(cleanPromptText("1.5::a,  b ::, best quality")).toBe("1.5::a,  b ::");
    expect(hasImportableMeta({ prompt: "a" })).toBe(true);
    expect(hasImportableMeta({})).toBe(false);
    expect(tokenFillPercent("abc")).toBeGreaterThan(0);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(32))).toBe(10);
    expect(tokenFillPercent("a".repeat(6400))).toBe(100);
    expect(tokenFillPercent("a".repeat(3200))).toBeCloseTo((1000 / 1471) * 100, 5);
  });

  it("names original and clean studio downloads", () => {
    expect(studioDownloadName("nai.png", "abc", "original", 42)).toBe("nai-s42-abc.png");
    expect(studioDownloadName("nai.png", "abc", "clean", 42)).toBe("nai-s42-abc-nodata.png");
    expect(studioDownloadName("", "shot-1", "original")).toBe("nai-shot1.png");
    expect(studioDownloadName("scene.png", "deadbeef99", "original", -1)).toBe("scene-deadbeef.png");
    const item = { name: "scene.png", id: "deadbeef99", hash: "abc", params: { seed: 7 } };
    expect(artworkDownloadName(item, "original")).toBe("scene-s7-deadbeef.png");
    expect(artworkDownloadName(item, "clean")).toBe("scene-s7-deadbeef-nodata.png");
    expect(artworkDownloadName({ ...item, params: {} }, "original")).toBe("scene-deadbeef.png");
    expect(artworkDownloadName({ ...item, params: { seed: null } }, "original")).toBe("scene-deadbeef.png");
  });

  it("builds a form from job-shaped shot meta", () => {
    const form = formFromMeta({
      prompt: "girl",
      uc: "bad",
      sampler: "k_euler_ancestral",
      steps: 28,
      seed: 12,
      cfgRescale: 0.3,
      v4Prompt: {
        caption: {
          base_caption: "girl",
          char_captions: [{ char_caption: "red hair", centers: [{ x: 0.2, y: 0.4 }] }],
        },
      },
    });
    expect(form.prompt).toBe("girl");
    expect(form.cfgRescale).toBe(0.3);
    expect(form.characters?.[0]?.prompt).toBe("red hair");
    expect(form.effort).toBe("high");
    expect(hasImportableMeta({ prompt: "girl" })).toBe(true);
  });

  it("maps the distilled model back onto V5 Full 节约", () => {
    const form = mergeStudioForm(
      defaultForm(),
      formFromMeta({ model: "nai-diffusion-5-full-medium", prompt: "hat", uc: "lowres", steps: 14, sampler: "k_euler" }),
      { replace: true },
    );
    expect(form.model).toBe("nai-diffusion-5-full");
    expect(form.effort).toBe("medium");
    const payload = formToPayload({ ...form, uc: "lowres", sampler: "k_euler", steps: 28 });
    expect(payload.effort).toBe("medium");
    expect(payload.model).toBe("nai-diffusion-5-full");
  });
});
