import { beforeEach, describe, expect, it, vi } from "vitest";
import { childrenOf, isSeparator, registerMenu, resetMenus, resolveMenu, tidy, type MenuEntry } from "./registry";

const labels = (entries: MenuEntry[]) => entries.map((e) => (isSeparator(e) ? "-" : e.label));

describe("context menu registry", () => {
  beforeEach(resetMenus);

  it("collects items from several sources and sorts by group then order", () => {
    registerMenu("s", { id: "late", group: 2, build: () => [{ label: "删除" }] });
    registerMenu("s", { id: "b", group: 1, order: 2, build: () => [{ label: "B" }] });
    registerMenu("s", { id: "a", group: 1, order: 1, build: () => [{ label: "A1" }, { label: "A2" }] });
    expect(labels(resolveMenu("s", null))).toEqual(["A1", "A2", "B", "-", "删除"]);
  });

  it("keeps registration order when group and order tie", () => {
    registerMenu("s", { id: "x", build: () => [{ label: "X" }] });
    registerMenu("s", { id: "y", build: () => [{ label: "Y" }] });
    expect(labels(resolveMenu("s", null))).toEqual(["X", "Y"]);
  });

  it("skips sources with nothing to show, without leaving a stray separator", () => {
    registerMenu("s", { id: "a", group: 1, build: () => [{ label: "A" }] });
    registerMenu("s", { id: "empty", group: 2, build: () => [] });
    registerMenu("s", { id: "none", group: 3, build: () => null });
    registerMenu("s", { id: "z", group: 4, build: () => [{ label: "Z" }] });
    expect(labels(resolveMenu("s", null))).toEqual(["A", "-", "Z"]);
  });

  it("passes the context to build and isolates scopes", () => {
    registerMenu<{ n: number }>("one", { id: "c", build: (ctx) => [{ label: `选中 ${ctx.n} 张` }] });
    registerMenu("two", { id: "d", build: () => [{ label: "别处" }] });
    expect(labels(resolveMenu("one", { n: 3 }))).toEqual(["选中 3 张"]);
    expect(resolveMenu("missing", null)).toEqual([]);
  });

  it("unregisters, and a stale unregister does not remove a replacement", () => {
    const off = registerMenu("s", { id: "same", build: () => [{ label: "old" }] });
    registerMenu("s", { id: "same", build: () => [{ label: "new" }] });
    off();
    expect(labels(resolveMenu("s", null))).toEqual(["new"]);
    const offNew = registerMenu("s", { id: "tmp", build: () => [{ label: "tmp" }] });
    offNew();
    expect(labels(resolveMenu("s", null))).toEqual(["new"]);
  });

  it("evaluates lazy children only when asked", () => {
    const lazy = vi.fn(() => [{ label: "收藏夹 1" }, { separator: true } as const, { label: "收藏夹 2" }]);
    registerMenu("s", { id: "save", build: () => [{ label: "保存", children: lazy }] });
    const [item] = resolveMenu("s", null);
    expect(lazy).not.toHaveBeenCalled();
    if (isSeparator(item)) throw new Error("expected item");
    expect(labels(childrenOf(item))).toEqual(["收藏夹 1", "-", "收藏夹 2"]);
    expect(lazy).toHaveBeenCalledTimes(1);
    expect(childrenOf({ label: "plain" })).toEqual([]);
  });

  it("tidy removes leading, trailing, and doubled separators", () => {
    const sep = { separator: true } as const;
    expect(labels(tidy([sep, { label: "A" }, sep, sep, { label: "B" }, sep]))).toEqual(["A", "-", "B"]);
  });
});
