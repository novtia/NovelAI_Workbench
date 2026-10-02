import { afterEach, describe, expect, it } from "vitest";
import { basketName, basketText } from "./artistBasket";
import { DEFAULT_SETTINGS, applyPatch, formatBytes, mergePatch, mergeSettings } from "./settings";
import { defaultForm, setFormDefaultsProvider } from "./studio";
import { applySettingsToDom, resolveTheme } from "../ui/applySettings";

describe("mergeSettings", () => {
  it("非对象返回默认值且不共享引用", () => {
    const a = mergeSettings(null);
    expect(a).toEqual(DEFAULT_SETTINGS);
    a.appearance.toastMs = 1;
    expect(DEFAULT_SETTINGS.appearance.toastMs).not.toBe(1);
  });

  it("补全缺项、丢弃类型不符与未知字段", () => {
    const s = mergeSettings({
      appearance: { theme: "dark", toastMs: "oops", nope: 1 },
      unknown: { a: 1 },
    });
    expect(s.appearance.theme).toBe("dark");
    expect(s.appearance.toastMs).toBe(DEFAULT_SETTINGS.appearance.toastMs);
    expect("nope" in s.appearance).toBe(false);
    expect(s.gallery).toEqual(DEFAULT_SETTINGS.gallery);
  });
});

describe("applyPatch / mergePatch", () => {
  it("applyPatch 不修改原对象", () => {
    const next = applyPatch(DEFAULT_SETTINGS, { gallery: { density: "compact" } });
    expect(next.gallery.density).toBe("compact");
    expect(DEFAULT_SETTINGS.gallery.density).not.toBe("compact");
    expect(next.gallery.sort).toBe(DEFAULT_SETTINGS.gallery.sort);
  });

  it("mergePatch 后者覆盖前者、同区段字段合并", () => {
    const m = mergePatch({ gallery: { density: "compact", pageSize: 100 } }, { gallery: { density: "comfortable" }, basket: { autoOpen: true } });
    expect(m).toEqual({ gallery: { density: "comfortable", pageSize: 100 }, basket: { autoOpen: true } });
  });
});

describe("formatBytes", () => {
  it("按量级换算", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});

describe("applySettingsToDom", () => {
  it("写入 data 属性与 CSS 变量", () => {
    const props: Record<string, string> = {};
    const root = {
      dataset: {} as Record<string, string>,
      style: { setProperty: (k: string, v: string) => void (props[k] = v) },
    } as unknown as HTMLElement;
    const s = applyPatch(DEFAULT_SETTINGS, {
      appearance: { theme: "dark", grain: false, reduceMotion: true },
      gallery: { cardMinWidth: 300, showArtists: false },
    });
    applySettingsToDom(s, root);
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.grain).toBe("off");
    expect(root.dataset.motion).toBe("reduce");
    expect(root.dataset.artists).toBe("off");
    expect(props["--card-min"]).toBe("300px");
    expect(props["--card-min-compact"]).toBe("195px");
  });

  it("resolveTheme 显式值原样返回", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });
});

describe("basketText 格式", () => {
  const list = [{ name: "foo_bar" }, { name: "x (y)" }];
  it("默认逗号分隔", () => {
    expect(basketText(list)).toBe("artist:foo_bar, artist:x (y)");
  });
  it("换行 / 空格分隔", () => {
    expect(basketText(list, { separator: "newline" })).toBe("artist:foo_bar\nartist:x (y)");
    expect(basketText(list, { separator: "space" })).toBe("artist:foo_bar artist:x (y)");
  });
  it("下划线转空格、转义括号（不重复转义）", () => {
    expect(basketName("foo_bar", { underscoreToSpace: true })).toBe("artist:foo bar");
    expect(basketName("x (y)", { escapeParens: true })).toBe("artist:x \\(y\\)");
    expect(basketName("x \\(y\\)", { escapeParens: true })).toBe("artist:x \\(y\\)");
  });
});

describe("defaultForm 读取设置", () => {
  afterEach(() => setFormDefaultsProvider(null));

  it("没有 provider 时用内置默认", () => {
    const f = defaultForm();
    expect(f.steps).toBe(DEFAULT_SETTINGS.generation.steps);
    expect(f.model).toBe(DEFAULT_SETTINGS.generation.model);
  });

  it("provider 的值进入表单", () => {
    setFormDefaultsProvider(() => ({ ...DEFAULT_SETTINGS.generation, steps: 33, scale: 7.5, nSamples: 2 }));
    const f = defaultForm();
    expect(f.steps).toBe(33);
    expect(f.scale).toBe(7.5);
    expect(f.nSamples).toBe(2);
  });
});
