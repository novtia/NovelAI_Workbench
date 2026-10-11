import { beforeEach, describe, expect, it } from "vitest";
import { createTabScopedStore, currentTabId, disposeTab, runInTab, setActiveTab, activeTab } from "./scoped";

type S = { n: number; inc: () => void };
const make = () =>
  createTabScopedStore<S>((id) => (set) => ({
    n: id === "b" ? 100 : 0,
    inc: () => set((s) => ({ n: s.n + 1 })),
  }));

describe("tab scoped store", () => {
  beforeEach(() => setActiveTab("a"));

  it("routes getState to the active tab", () => {
    const store = make();
    store.getState().inc();
    expect(store.getState().n).toBe(1);
    setActiveTab("b");
    expect(store.getState().n).toBe(100);
    setActiveTab("a");
    expect(store.getState().n).toBe(1);
  });

  it("runInTab targets another tab and restores afterwards", () => {
    const store = make();
    setActiveTab("a");
    runInTab("b", () => {
      expect(currentTabId()).toBe("b");
      store.getState().inc();
      store.setState({ n: store.getState().n + 10 });
    });
    expect(currentTabId()).toBe("a");
    expect(activeTab()).toBe("a");
    expect(store.getState().n).toBe(0);
    expect(store.forTab("b").getState().n).toBe(111);
  });

  it("subscribe follows the active tab without firing on switch", () => {
    const store = make();
    const seen: number[] = [];
    const off = store.subscribe((s) => seen.push(s.n));
    store.getState().inc();
    setActiveTab("b");
    expect(seen).toEqual([1]);
    store.getState().inc();
    expect(seen).toEqual([1, 101]);
    // 后台标签的变化不会触发
    runInTab("a", () => store.getState().inc());
    expect(seen).toEqual([1, 101]);
    off();
    store.getState().inc();
    expect(seen).toEqual([1, 101]);
  });

  it("disposeTab drops the store", () => {
    const store = make();
    setActiveTab("c");
    store.getState().inc();
    expect(store.tabIds()).toContain("c");
    setActiveTab("a");
    disposeTab("c");
    expect(store.tabIds()).not.toContain("c");
    // 再访问已销毁的标签只得到游离的新 store，不会重新登记
    expect(runInTab("c", () => store.getState().n)).toBe(0);
    expect(store.tabIds()).not.toContain("c");
  });
});
