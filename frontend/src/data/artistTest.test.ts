import { describe, expect, it } from "vitest";
import { artistQuickPayload, artistTestForm, quickJobTarget, resolveArtistTestForm } from "./artistTest";
import { DEFAULT_SETTINGS, applyPatch, mergeSettings } from "./settings";

describe("artistTestForm", () => {
  it("把设置里的画师测试参数变成单张生图表单", () => {
    const form = artistTestForm({ ...DEFAULT_SETTINGS.artistTest, prompt: "  upper body ", preset: "Large", aspect: "land", seed: 42, steps: 30 });
    expect(form.prompt).toBe("upper body");
    expect([form.width, form.height]).toEqual([1536, 1024]);
    expect(form.seed).toBe(42);
    expect(form.steps).toBe(30);
    expect(form.nSamples).toBe(1);
    expect(form.characters).toEqual([{ prompt: "girl, solo", uc: "", x: 0.5, y: 0.5 }]);
  });

  it("角色提示词留空时不带角色", () => {
    expect(artistTestForm({ ...DEFAULT_SETTINGS.artistTest, character: "  " }).characters).toEqual([]);
  });
});

describe("resolveArtistTestForm", () => {
  const presetForm = { ...artistTestForm(DEFAULT_SETTINGS.artistTest), prompt: "from preset", steps: 40, nSamples: 4, characters: [], seed: 5 };
  const presets = [{ id: "p1", name: "我的预设", form: presetForm, createdAt: 1 }];

  it("没选预设就用自定义参数", () => {
    const { form, preset } = resolveArtistTestForm(DEFAULT_SETTINGS.artistTest, presets);
    expect(preset).toBeNull();
    expect(form.steps).toBe(DEFAULT_SETTINGS.artistTest.steps);
  });

  it("选了预设就整套套用，每位画师 1 张，预设没角色时补设置里的角色", () => {
    const { form, preset } = resolveArtistTestForm({ ...DEFAULT_SETTINGS.artistTest, presetId: "p1", steps: 1 }, presets);
    expect(preset?.id).toBe("p1");
    expect(form.prompt).toBe("from preset");
    expect(form.steps).toBe(40);
    expect(form.seed).toBe(5);
    expect(form.nSamples).toBe(1);
    expect(form.characters.map((c) => c.prompt)).toEqual(["girl, solo"]);
    expect(presets[0].form.nSamples).toBe(4); // 不改动原预设
  });

  it("预设被删除时回落到自定义参数", () => {
    const { form, preset } = resolveArtistTestForm({ ...DEFAULT_SETTINGS.artistTest, presetId: "gone" }, presets);
    expect(preset).toBeNull();
    expect(form.prompt).toBe("");
  });
});

describe("quick generation payload", () => {
  const form = artistTestForm(DEFAULT_SETTINGS.artistTest);
  const payload = artistQuickPayload(form, "single-artist", "foo bar", "artist:foo bar");

  it("任务指向单画师收藏夹，而不是某个测试集", () => {
    expect(payload.source).toBe("gallery");
    expect(payload.client.targetAlbumId).toBe("single-artist");
    expect("testSetId" in payload.client).toBe(false);
    expect(payload.client.artists).toEqual(["foo bar"]);
  });

  it("quickJobTarget 只认补图任务", () => {
    expect(quickJobTarget(payload.client)).toEqual({ albumId: "single-artist", name: "foo bar" });
    expect(quickJobTarget({ testSetId: "testset-1", artists: ["foo"] })).toBeNull();
    expect(quickJobTarget(undefined)).toBeNull();
  });
});

describe("artistTest settings", () => {
  it("缺项时补默认值，字符串字段保留字符串", () => {
    const s = mergeSettings({ artistTest: { prompt: "hello", steps: "x" } });
    expect(s.artistTest.prompt).toBe("hello");
    expect(s.artistTest.steps).toBe(DEFAULT_SETTINGS.artistTest.steps);
    expect(applyPatch(s, { artistTest: { seed: 7 } }).artistTest.seed).toBe(7);
  });
});
