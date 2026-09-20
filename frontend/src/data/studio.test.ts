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
  tokenFillPercent,
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

  it("cleans quality tags and detects importable meta", () => {
    expect(cleanPromptText("cat, masterpiece, best quality")).toBe("cat");
    expect(hasImportableMeta({ prompt: "a" })).toBe(true);
    expect(hasImportableMeta({})).toBe(false);
    expect(tokenFillPercent("abc")).toBeGreaterThan(0);
  });

  it("names original and clean studio downloads", () => {
    expect(studioDownloadName("nai.png", "abc", "original")).toBe("nai.png");
    expect(studioDownloadName("nai.png", "abc", "clean")).toBe("nai-nodata.png");
    expect(studioDownloadName("", "shot-1", "original")).toBe("nai-shot-1.png");
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
    expect(hasImportableMeta({ prompt: "girl" })).toBe(true);
  });
});
