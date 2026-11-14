import type { MediaArtist, MediaPost, MediaSite } from "@/data/media";
import { createTabScopedStore } from "./scoped";

/**
 * 媒体视图模式：
 * - "home": 媒体网址导航首页
 * - "feed": 作品瀑布流列表页（Danbooru Posts / AI TAG Works）
 * - "artists": 独立的 Danbooru 画师页（对应 Danbooru Artists 栏目，含画师名、作品数、别名与自动抓取的 1 张代表图）
 * - "artistDetail": Danbooru 画师详细页（展示该画师的完整信息、外链、代表图与全部作品分页网格）
 * - "postDetail": 作品完整详细页（AI TAG 作品详细页 / Danbooru 作品详细页）
 */
export type MediaMode = "home" | "feed" | "artists" | "artistDetail" | "postDetail";
export type MediaSort = "new" | "monthly" | "score" | "favcount";
export type MediaRating = "all" | "g" | "s" | "q" | "e";
export type MediaAiTypeFilter = "all" | "NAI" | "SD" | "ComfyUI";
export type MediaArtistOrder = "created_at" | "updated_at" | "post_count" | "name";

export type MediaDialogState =
  | { mode: "create" }
  | { mode: "edit"; site: MediaSite };

export type MediaState = {
  /** 当前标签页的媒体视图模式 */
  mode: MediaMode;
  /** 进入详细页前的上一级模式，用于点击「← 返回」时回到原处 */
  returnMode: "home" | "feed" | "artists" | "artistDetail";
  /** 当前选中的内置站点 ID（"danbooru" | "aitag"） */
  siteId: string;
  /** 导航首页搜索框过滤词 */
  homeFilter: string;
  /** 作品列表页搜索词（标签 / 作品 ID / 作者 / 画师） */
  query: string;
  /** AI TAG 专用：元数据咒语搜索词 */
  promptQuery: string;
  /** 作品列表当前页码（从 1 开始） */
  page: number;
  /** 作品列表排序模式 */
  sort: MediaSort;
  /** Danbooru 分级过滤 */
  rating: MediaRating;
  /** AI TAG 生成器类型过滤 */
  aiTypeFilter: MediaAiTypeFilter;
  /** 是否显示 R-18 内容 */
  showR18: boolean;

  /** Danbooru 独立画师页检索条件 */
  artistQuery: string;
  artistUrlQuery: string;
  artistOrder: MediaArtistOrder;
  artistHasTag: "" | "true" | "false";
  artistDeleted: "" | "true" | "false";
  artistPage: number;

  /** 当前查看的 Danbooru 画师详细页对象与作品页码 */
  activeArtist: MediaArtist | null;
  artistDetailPage: number;

  /** 当前打开的作品 ID 与缓存快照（用于进入完整详细页 postDetail） */
  selectedPostId: string | null;
  activePostSnapshot: MediaPost | null;

  /** 是否打开「本页画师抓取工作台」弹窗 */
  artistGrabOpen: boolean;
  /** 添加/编辑站点弹窗状态 */
  dialog: MediaDialogState | null;

  /** 进入某个内置站点（默认进作品页；也可指定直接进 Danbooru 独立画师页） */
  enterSite: (siteId: string, initialQuery?: string, targetMode?: "feed" | "artists") => void;
  /** 在 Danbooru 内切换「作品 (Posts)」与「画师 (Artists)」独立页 */
  switchDanbooruTab: (tab: "feed" | "artists") => void;
  /** 打开某位画师的独立画师详细页 */
  openArtistDetail: (artist: MediaArtist) => void;
  setArtistDetailPage: (page: number) => void;
  /** 打开某个作品的完整详细页 */
  openPostDetail: (post: MediaPost) => void;
  /** 从详细页返回上一级页面 */
  goBackFromDetail: () => void;
  /** 返回媒体导航首页 */
  backToHome: () => void;

  setHomeFilter: (filter: string) => void;
  setQuery: (query: string) => void;
  setPromptQuery: (promptQuery: string) => void;
  submitSearch: (query: string, promptQuery?: string) => void;
  appendSearchTag: (tag: string) => void;
  setPage: (page: number) => void;
  setSort: (sort: MediaSort) => void;
  setRating: (rating: MediaRating) => void;
  setAiTypeFilter: (aiTypeFilter: MediaAiTypeFilter) => void;
  setShowR18: (showR18: boolean) => void;

  /** Danbooru 独立画师页动作 */
  submitArtistSearch: (params: {
    name?: string;
    url?: string;
    order?: MediaArtistOrder;
    hasTag?: "" | "true" | "false";
    isDeleted?: "" | "true" | "false";
  }) => void;
  setArtistPage: (page: number) => void;

  setSelectedPostId: (id: string | null) => void;
  setArtistGrabOpen: (open: boolean) => void;
  openCreateSiteDialog: () => void;
  openEditSiteDialog: (site: MediaSite) => void;
  closeSiteDialog: () => void;
};

export const useMediaStore = createTabScopedStore<MediaState>(() => (set, get) => ({
  mode: "home",
  returnMode: "feed",
  siteId: "danbooru",
  homeFilter: "",
  query: "",
  promptQuery: "",
  page: 1,
  sort: "new",
  rating: "all",
  aiTypeFilter: "all",
  showR18: false,

  artistQuery: "",
  artistUrlQuery: "",
  artistOrder: "created_at",
  artistHasTag: "",
  artistDeleted: "false",
  artistPage: 1,

  activeArtist: null,
  artistDetailPage: 1,

  selectedPostId: null,
  activePostSnapshot: null,

  artistGrabOpen: false,
  dialog: null,

  enterSite: (siteId, initialQuery, targetMode = "feed") => {
    const useMode = siteId === "danbooru" && targetMode === "artists" ? "artists" : "feed";
    const nextQuery =
      initialQuery !== undefined
        ? initialQuery.trim()
        : get().siteId === siteId
          ? get().query
          : "";
    set({
      mode: useMode,
      returnMode: useMode,
      siteId,
      query: useMode === "feed" ? nextQuery : get().query,
      artistQuery: useMode === "artists" && initialQuery !== undefined ? initialQuery.trim() : get().artistQuery,
      promptQuery: "",
      page: 1,
      artistPage: useMode === "artists" && initialQuery !== undefined ? 1 : get().artistPage,
      sort: "new",
      selectedPostId: null,
      activePostSnapshot: null,
    });
  },

  switchDanbooruTab: (tab) => {
    set({
      siteId: "danbooru",
      mode: tab,
      returnMode: tab,
      selectedPostId: null,
    });
  },

  openArtistDetail: (artist) => {
    const curMode = get().mode;
    set({
      siteId: "danbooru",
      mode: "artistDetail",
      returnMode: curMode === "artists" || curMode === "feed" ? curMode : "artists",
      activeArtist: artist,
      artistDetailPage: 1,
      selectedPostId: null,
    });
  },

  setArtistDetailPage: (page) => set({ artistDetailPage: Math.max(1, page) }),

  openPostDetail: (post) => {
    const curMode = get().mode;
    const ret =
      curMode === "feed" || curMode === "artists" || curMode === "artistDetail"
        ? curMode
        : get().returnMode;
    set({
      siteId: post.siteId || get().siteId,
      mode: "postDetail",
      returnMode: ret,
      selectedPostId: post.id,
      activePostSnapshot: post,
    });
  },

  goBackFromDetail: () => {
    const cur = get();
    if (cur.mode === "postDetail") {
      set({
        mode: cur.returnMode || "feed",
      });
      return;
    }
    if (cur.mode === "artistDetail") {
      set({
        mode: "artists",
      });
      return;
    }
    set({ mode: "home" });
  },

  backToHome: () => {
    set({
      mode: "home",
      selectedPostId: null,
      activePostSnapshot: null,
      artistGrabOpen: false,
    });
  },

  setHomeFilter: (homeFilter) => set({ homeFilter }),
  setQuery: (query) => set({ query }),
  setPromptQuery: (promptQuery) => set({ promptQuery }),
  submitSearch: (query, promptQuery) =>
    set((s) => ({
      mode: "feed",
      returnMode: "feed",
      query: query.trim(),
      promptQuery: promptQuery !== undefined ? promptQuery.trim() : s.promptQuery,
      page: 1,
      selectedPostId: null,
    })),
  appendSearchTag: (tag) => {
    const clean = tag.trim();
    if (!clean) return;
    const cur = get().query.trim();
    const tokens = cur ? cur.split(/\s+/).filter(Boolean) : [];
    if (!tokens.includes(clean)) {
      tokens.push(clean);
    }
    set({
      mode: "feed",
      returnMode: "feed",
      query: tokens.join(" "),
      page: 1,
      selectedPostId: null,
    });
  },
  setPage: (page) => set({ page: Math.max(1, page), selectedPostId: null }),
  setSort: (sort) => set({ sort, page: 1, selectedPostId: null }),
  setRating: (rating) => set({ rating, page: 1, selectedPostId: null }),
  setAiTypeFilter: (aiTypeFilter) => set({ aiTypeFilter, page: 1, selectedPostId: null }),
  setShowR18: (showR18) => set({ showR18, page: 1, selectedPostId: null }),

  submitArtistSearch: (params) =>
    set((s) => ({
      mode: "artists",
      returnMode: "artists",
      artistQuery: params.name !== undefined ? params.name.trim() : s.artistQuery,
      artistUrlQuery: params.url !== undefined ? params.url.trim() : s.artistUrlQuery,
      artistOrder: params.order !== undefined ? params.order : s.artistOrder,
      artistHasTag: params.hasTag !== undefined ? params.hasTag : s.artistHasTag,
      artistDeleted: params.isDeleted !== undefined ? params.isDeleted : s.artistDeleted,
      artistPage: 1,
    })),

  setArtistPage: (artistPage) => set({ artistPage: Math.max(1, artistPage) }),

  setSelectedPostId: (selectedPostId) => set({ selectedPostId }),
  setArtistGrabOpen: (artistGrabOpen) => set({ artistGrabOpen }),
  openCreateSiteDialog: () => set({ dialog: { mode: "create" } }),
  openEditSiteDialog: (site) => set({ dialog: { mode: "edit", site } }),
  closeSiteDialog: () => set({ dialog: null }),
}));
