import { describe, expect, it } from "vitest";
import {
  buildArtistGrabMeta,
  cleanMediaErrorMessage,
  collectMediaArtistCandidates,
  extractSiteHost,
  filterMediaSites,
  formatRelativeTime,
  isCfChallengeError,
  mediaProxyImageUrl,
  normalizeWebUrl,
  resolvePostArtists,
  splitBuiltinAndCustomSites,
  type MediaPost,
  type MediaSite,
} from "./media";

const SITES: MediaSite[] = [
  {
    id: "danbooru",
    name: "Danbooru",
    kind: "danbooru",
    baseUrl: "https://danbooru.donmai.us",
    builtin: true,
    defaultQuery: "",
    note: "二次元插画",
    hasCookie: false,
    hasClearance: false,
    hasUserAgent: false,
  },
  {
    id: "aitag",
    name: "AI TAG",
    kind: "aitag",
    baseUrl: "https://aitag.win",
    builtin: true,
    defaultQuery: "",
    note: "AI 绘画咒语",
    hasCookie: true,
    hasClearance: true,
    hasUserAgent: true,
  },
  {
    id: "web_1",
    name: "Pixiv",
    kind: "webpage",
    baseUrl: "https://www.pixiv.net",
    builtin: false,
    defaultQuery: "",
    note: "插画社区",
    hasCookie: false,
    hasClearance: false,
    hasUserAgent: false,
  },
];

function makeMockPost(partial: Partial<MediaPost>): MediaPost {
  return {
    id: "1001",
    siteId: "danbooru",
    siteKind: "danbooru",
    title: "Test",
    previewUrl: "https://cdn.donmai.us/preview.jpg",
    sampleUrl: "https://cdn.donmai.us/sample.jpg",
    fileUrl: "https://cdn.donmai.us/file.png",
    sourceUrl: "https://danbooru.donmai.us/posts/1001",
    width: 1000,
    height: 1400,
    artists: ["wlop"],
    tagsGeneral: ["1girl"],
    tagsCharacter: [],
    tagsCopyright: [],
    tagsMeta: [],
    prompt: "wlop, 1girl",
    negativePrompt: "",
    aiType: "Danbooru",
    model: "",
    authorName: "wlop",
    authorId: "",
    createdAt: "",
    score: 10,
    favCount: 20,
    rating: "g",
    imageCount: 1,
    pages: [],
    rawParams: {},
    ...partial,
  };
}

describe("media helpers", () => {
  it("splits builtin and custom webpage sites", () => {
    const { builtins, customs } = splitBuiltinAndCustomSites(SITES);
    expect(builtins.map((s) => s.id)).toEqual(["danbooru", "aitag"]);
    expect(customs.map((s) => s.id)).toEqual(["web_1"]);
  });

  it("filters sites by name, url or note", () => {
    expect(filterMediaSites(SITES, "pixiv").map((s) => s.id)).toEqual(["web_1"]);
    expect(filterMediaSites(SITES, "咒语").map((s) => s.id)).toEqual(["aitag"]);
    expect(filterMediaSites(SITES, "").length).toBe(3);
  });

  it("detects and cleans CF_CHALLENGE errors", () => {
    const err = new Error("CF_CHALLENGE:Danbooru 触发了 Cloudflare 安全验证");
    expect(isCfChallengeError(err)).toBe(true);
    expect(cleanMediaErrorMessage(err)).toBe("Danbooru 触发了 Cloudflare 安全验证");
    expect(isCfChallengeError(new Error("普通网络错误"))).toBe(false);
  });

  it("normalizes urls and extracts hosts", () => {
    expect(normalizeWebUrl("civitai.com")).toBe("https://civitai.com");
    expect(normalizeWebUrl("https://aitag.win")).toBe("https://aitag.win");
    expect(extractSiteHost("https://danbooru.donmai.us/posts")).toBe("danbooru.donmai.us");
    expect(mediaProxyImageUrl("aitag", "https://ai-img.10118899.xyz/NAI/1/1_p0.webp")).toContain(
      "/media/proxy?site=aitag&url=",
    );
  });

  it("extracts artists from posts and prompt text and groups candidates for 1-artist-1-image grab", () => {
    const p1 = makeMockPost({ id: "1", artists: ["wlop", "ask_(askzy)"] });
    const p2 = makeMockPost({
      id: "2",
      siteId: "aitag",
      siteKind: "aitag",
      artists: [],
      prompt: "1girl, 1.2::artist:ciloranko::, [artist:wlop], masterpiece",
    });

    expect(resolvePostArtists(p2)).toEqual(["ciloranko", "wlop"]);

    const candidates = collectMediaArtistCandidates([p1, p2], {
      basketKeys: new Set(["wlop"]),
    });
    expect(candidates.map((c) => c.key)).toEqual(["wlop", "ask (askzy)", "ciloranko"]);
    expect(candidates[0].posts.map((p) => p.id)).toEqual(["1", "2"]);
    expect(candidates[0].inBasket).toBe(true);

    const meta = buildArtistGrabMeta(p1, "wlop");
    expect(meta.artists).toEqual(["wlop"]);
    expect(meta.artistLine).toBe("artist:wlop");
    expect(formatRelativeTime("")).toBe("");
    expect(formatRelativeTime(new Date(Date.now() - 120_000).toISOString())).toContain("分钟前");
  });
});
