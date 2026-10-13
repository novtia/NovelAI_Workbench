import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, applyClick, applyContext, pickSelected, prune, selectAll } from "./historySelection";

const order = ["a", "b", "c", "d", "e", "f"];
const keys = (s: { keys: ReadonlySet<string> }) => [...s.keys].sort();

describe("history selection", () => {
  it("plain click selects only that one and sets the anchor", () => {
    const s = applyClick(applyClick(EMPTY_SELECTION, order, "b"), order, "d");
    expect(keys(s)).toEqual(["d"]);
    expect(s.anchor).toBe("d");
  });

  it("ctrl click toggles without touching the rest", () => {
    let s = applyClick(EMPTY_SELECTION, order, "a");
    s = applyClick(s, order, "c", { ctrl: true });
    s = applyClick(s, order, "e", { ctrl: true });
    expect(keys(s)).toEqual(["a", "c", "e"]);
    s = applyClick(s, order, "c", { ctrl: true });
    expect(keys(s)).toEqual(["a", "e"]);
    expect(s.anchor).toBe("c");
  });

  it("shift click selects the span from the anchor, in either direction", () => {
    let s = applyClick(EMPTY_SELECTION, order, "b");
    s = applyClick(s, order, "e", { shift: true });
    expect(keys(s)).toEqual(["b", "c", "d", "e"]);
    s = applyClick(s, order, "a", { shift: true });
    expect(keys(s)).toEqual(["a", "b"]);
    expect(s.anchor).toBe("b");
  });

  it("ctrl+shift adds the span to what is already selected", () => {
    let s = applyClick(EMPTY_SELECTION, order, "a");
    s = applyClick(s, order, "d", { ctrl: true });
    s = applyClick(s, order, "f", { shift: true, ctrl: true });
    expect(keys(s)).toEqual(["a", "d", "e", "f"]);
  });

  it("shift without an anchor just selects the clicked one", () => {
    expect(keys(applyClick(EMPTY_SELECTION, order, "c", { shift: true }))).toEqual(["c"]);
  });

  it("right click keeps a multi selection when it lands on a selected card", () => {
    const multi = applyClick(applyClick(EMPTY_SELECTION, order, "a"), order, "c", { ctrl: true });
    expect(applyContext(multi, order, "c")).toBe(multi);
    expect(keys(applyContext(multi, order, "e"))).toEqual(["e"]);
  });

  it("ignores keys that are not on screen", () => {
    const s = applyClick(EMPTY_SELECTION, order, "a");
    expect(applyClick(s, order, "zzz")).toBe(s);
    expect(applyContext(s, order, "zzz")).toBe(s);
  });

  it("select all, prune, and ordered pick", () => {
    const all = selectAll(order);
    expect(keys(all)).toEqual(order);
    const after = prune(all, ["a", "c"]);
    expect(keys(after)).toEqual(["a", "c"]);
    expect(prune(after, ["a", "c", "x"])).toBe(after);
    const items = order.map((key) => ({ key }));
    const sel = applyClick(applyClick(EMPTY_SELECTION, order, "e"), order, "b", { ctrl: true });
    expect(pickSelected(items, sel).map((i) => i.key)).toEqual(["b", "e"]);
  });
});
