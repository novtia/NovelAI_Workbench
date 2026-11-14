import { beforeEach, describe, expect, it } from "vitest";
import { activeTab } from "./scoped";
import { loadTabs, useTabs } from "./tabs";

function reset() {
  useTabs.setState({ tabs: [{ id: "main", view: "gallery" }], activeId: "main" });
  useTabs.getState().activateTab("main");
}

describe("tabs", () => {
  beforeEach(reset);

  it("opens a tab next to the active one and activates it", () => {
    const { openTab } = useTabs.getState();
    const a = openTab("studio");
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(["main", a]);
    expect(useTabs.getState().activeId).toBe(a);
    expect(activeTab()).toBe(a);
    useTabs.getState().activateTab("main");
    const b = useTabs.getState().openTab("lottery");
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(["main", b, a]);
  });

  it("closing the active tab activates a neighbour", () => {
    const a = useTabs.getState().openTab("studio");
    const b = useTabs.getState().openTab("lottery");
    useTabs.getState().closeTab(b);
    expect(useTabs.getState().activeId).toBe(a);
    useTabs.getState().closeTab("main");
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([a]);
    expect(activeTab()).toBe(a);
  });

  it("closing the last tab leaves a fresh gallery tab", () => {
    useTabs.getState().closeTab("main");
    const { tabs, activeId } = useTabs.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).not.toBe("main");
    expect(tabs[0].view).toBe("gallery");
    expect(activeId).toBe(tabs[0].id);
  });

  it("moves tabs and updates views", () => {
    const a = useTabs.getState().openTab("studio");
    useTabs.getState().moveTab(a, 0);
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([a, "main"]);
    useTabs.getState().setTabView("main", "settings");
    expect(useTabs.getState().tabs.find((t) => t.id === "main")?.view).toBe("settings");
  });

  it("restores persisted tabs and rejects bad data", () => {
    const ok = loadTabs(JSON.stringify({ tabs: [{ id: "x", view: "studio" }, { id: "y", view: "lottery" }], activeId: "y" }));
    expect(ok).toEqual({ tabs: [{ id: "x", view: "studio" }, { id: "y", view: "lottery" }], activeId: "y" });
    expect(loadTabs(JSON.stringify({ tabs: [{ id: "x", view: "nope" }], activeId: "x" }), "lottery")).toEqual({
      tabs: [{ id: "main", view: "lottery" }],
      activeId: "main",
    });
    expect(loadTabs("not json").tabs).toHaveLength(1);
    expect(loadTabs(JSON.stringify({ tabs: [{ id: "x", view: "gallery" }], activeId: "zzz" })).activeId).toBe("x");
  });

  it("opens one album detail tab and focuses it again", () => {
    const a = useTabs.getState().openAlbumTab("album-a");
    expect(useTabs.getState().activeId).toBe(a);
    expect(useTabs.getState().tabs.find((t) => t.id === a)).toEqual({ id: a, view: "album", albumId: "album-a" });
    useTabs.getState().activateTab("main");
    const again = useTabs.getState().openAlbumTab("album-a");
    expect(again).toBe(a);
    expect(useTabs.getState().tabs.filter((t) => t.view === "album")).toHaveLength(1);
    expect(useTabs.getState().activeId).toBe(a);
    const b = useTabs.getState().openAlbumTab("album-b");
    expect(b).not.toBe(a);
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(["main", a, b]);
  });

  it("keeps an album tab's id and drops one without it", () => {
    const ok = loadTabs(
      JSON.stringify({
        tabs: [
          { id: "a", view: "album", albumId: "fold" },
          { id: "b", view: "album" },
          { id: "c", view: "studio", albumId: "ignored" },
        ],
        activeId: "a",
      }),
    );
    expect(ok).toEqual({
      tabs: [
        { id: "a", view: "album", albumId: "fold" },
        { id: "c", view: "studio" },
      ],
      activeId: "a",
    });
    expect(loadTabs(JSON.stringify({ tabs: [{ id: "b", view: "album" }], activeId: "b" })).tabs).toEqual([
      { id: "main", view: "gallery" },
    ]);
  });

  it("does not turn a tab into an album view without an album", () => {
    useTabs.getState().setTabView("main", "album");
    expect(useTabs.getState().tabs[0].view).toBe("gallery");
  });

  it("opens a built-in web tab and reuses it for the same site or URL", () => {
    const a = useTabs.getState().openWebTab({
      id: "web_pixiv",
      name: "Pixiv",
      baseUrl: "https://www.pixiv.net",
    });
    expect(useTabs.getState().activeId).toBe(a);
    expect(useTabs.getState().tabs.find((t) => t.id === a)).toEqual({
      id: a,
      view: "web",
      webSiteId: "web_pixiv",
      webUrl: "https://www.pixiv.net",
      webTitle: "Pixiv",
    });

    useTabs.getState().activateTab("main");
    const sameSite = useTabs.getState().openWebTab({
      id: "web_pixiv",
      name: "Pixiv 插画",
      baseUrl: "https://www.pixiv.net",
    });
    expect(sameSite).toBe(a);
    expect(useTabs.getState().activeId).toBe(a);
    expect(useTabs.getState().tabs.filter((t) => t.view === "web")).toHaveLength(1);
    expect(useTabs.getState().tabs.find((t) => t.id === a)?.webTitle).toBe("Pixiv 插画");

    const b = useTabs.getState().openWebTab({
      id: "web_civitai",
      name: "Civitai",
      baseUrl: "civitai.com",
    });
    expect(b).not.toBe(a);
    expect(useTabs.getState().tabs.find((t) => t.id === b)?.webUrl).toBe("https://civitai.com");
  });

  it("restores valid web tabs and drops web tabs without webUrl", () => {
    const restored = loadTabs(
      JSON.stringify({
        tabs: [
          { id: "w1", view: "web", webSiteId: "web_1", webUrl: "https://example.com", webTitle: "Example" },
          { id: "w2", view: "web" },
          { id: "m1", view: "media" },
        ],
        activeId: "w1",
      }),
    );
    expect(restored).toEqual({
      tabs: [
        { id: "w1", view: "web", webSiteId: "web_1", webUrl: "https://example.com", webTitle: "Example" },
        { id: "m1", view: "media" },
      ],
      activeId: "w1",
    });
    useTabs.getState().setTabView("main", "web");
    expect(useTabs.getState().tabs[0].view).toBe("gallery");
  });
});
