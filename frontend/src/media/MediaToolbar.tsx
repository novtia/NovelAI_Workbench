import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Images,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import {
  splitBuiltinAndCustomSites,
  type MediaTagCategory,
  type MediaTagSuggestion,
} from "@/data";
import {
  useMediaSitesQuery,
  useMediaStore,
  useMediaTagSuggestQuery,
  type MediaAiTypeFilter,
  type MediaRating,
  type MediaSort,
} from "@/state";

const CAT_LABEL: Record<MediaTagCategory, string> = {
  artist: "画师",
  character: "角色",
  copyright: "作品",
  general: "标签",
  meta: "元数据",
};

function currentLastToken(input: string): { prefix: string; token: string } {
  const idx = input.lastIndexOf(" ");
  if (idx < 0) return { prefix: "", token: input };
  return {
    prefix: input.slice(0, idx + 1),
    token: input.slice(idx + 1),
  };
}

export function MediaToolbar({
  total,
  hasMore,
  loading,
  onRefresh,
  onOpenVerify,
}: {
  total: number | null;
  hasMore: boolean;
  loading: boolean;
  onRefresh: () => void;
  onOpenVerify: () => void;
}) {
  const mode = useMediaStore((s) => s.mode);
  const siteId = useMediaStore((s) => s.siteId);
  const query = useMediaStore((s) => s.query);
  const promptQuery = useMediaStore((s) => s.promptQuery);
  const page = useMediaStore((s) => s.page);
  const sort = useMediaStore((s) => s.sort);
  const rating = useMediaStore((s) => s.rating);
  const aiTypeFilter = useMediaStore((s) => s.aiTypeFilter);
  const showR18 = useMediaStore((s) => s.showR18);
  const backToHome = useMediaStore((s) => s.backToHome);
  const enterSite = useMediaStore((s) => s.enterSite);
  const switchDanbooruTab = useMediaStore((s) => s.switchDanbooruTab);
  const submitSearch = useMediaStore((s) => s.submitSearch);
  const setPage = useMediaStore((s) => s.setPage);
  const setSort = useMediaStore((s) => s.setSort);
  const setRating = useMediaStore((s) => s.setRating);
  const setAiTypeFilter = useMediaStore((s) => s.setAiTypeFilter);
  const setShowR18 = useMediaStore((s) => s.setShowR18);

  const sitesQ = useMediaSitesQuery();
  const { builtins } = splitBuiltinAndCustomSites(sitesQ.data || []);
  const currentSite = builtins.find((s) => s.id === siteId);
  const isAiTag = currentSite?.kind === "aitag" || siteId === "aitag";
  const isDanbooru = !isAiTag;
  const inArtistsTab =
    isDanbooru && (mode === "artists" || mode === "artistDetail");

  const [draftQuery, setDraftQuery] = useState(query);
  const [draftPrompt, setDraftPrompt] = useState(promptQuery);
  const [suggestCategory, setSuggestCategory] = useState<"all" | "artist">("all");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [debouncedToken, setDebouncedToken] = useState("");
  const searchWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraftQuery(query);
  }, [query]);

  useEffect(() => {
    setDraftPrompt(promptQuery);
  }, [promptQuery]);

  const { prefix, token } = currentLastToken(draftQuery);

  useEffect(() => {
    const clean = token.replace(/^-/, "").trim();
    const timer = window.setTimeout(() => {
      setDebouncedToken(clean);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [token]);

  const suggestQ = useMediaTagSuggestQuery(
    siteId,
    suggestOpen ? debouncedToken : "",
    suggestCategory,
  );
  const suggestions = suggestQ.data || [];

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (
        searchWrapRef.current &&
        !searchWrapRef.current.contains(e.target as Node)
      ) {
        setSuggestOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function applySuggestion(s: MediaTagSuggestion) {
    const neg = token.startsWith("-") ? "-" : "";
    const tagVal = isAiTag ? s.label : s.name;
    const nextQuery = `${prefix}${neg}${tagVal} `;
    setDraftQuery(nextQuery);
    setSuggestOpen(false);
    submitSearch(nextQuery.trim(), isAiTag ? draftPrompt : "");
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSuggestOpen(false);
    submitSearch(draftQuery, isAiTag ? draftPrompt : "");
  }

  return (
    <div className="m-bar">
      <div className="m-bar-left">
        <button
          type="button"
          className="btn m-back-btn"
          title="返回媒体导航首页"
          onClick={backToHome}
        >
          <ArrowLeft />
          <span>导航首页</span>
        </button>

        {/* 内置站点切换 */}
        <div className="m-site-pills" role="tablist" aria-label="内置站点切换">
          {builtins.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === siteId}
              className={`m-site-pill${s.id === siteId ? " on" : ""}`}
              onClick={() => {
                if (s.id !== siteId) enterSite(s.id);
              }}
            >
              <span>{s.name}</span>
            </button>
          ))}
        </div>

        {/* Danbooru 专属一级导航切换：「作品 (Posts)」 与 独立「画师页 (Artists)」 */}
        {isDanbooru ? (
          <div
            className="m-db-subnav"
            role="tablist"
            aria-label="Danbooru 栏目切换"
          >
            <button
              type="button"
              role="tab"
              aria-selected={!inArtistsTab}
              className={`m-db-subtab${!inArtistsTab ? " on" : ""}`}
              onClick={() => switchDanbooruTab("feed")}
            >
              <Images />
              <span>作品 (Posts)</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={inArtistsTab}
              className={`m-db-subtab${inArtistsTab ? " on" : ""}`}
              onClick={() => switchDanbooruTab("artists")}
            >
              <Users />
              <span>画师页 (Artists)</span>
            </button>
          </div>
        ) : null}

        {/* 作品页搜索栏（在画师页时隐藏，画师页有专属的 Name / URL / Order 搜索栏） */}
        {mode === "feed" ? (
          <form className="m-search-form" onSubmit={onSearchSubmit}>
            <div className="m-search-box" ref={searchWrapRef}>
              <Search className="m-search-ico" aria-hidden="true" />
              <input
                type="text"
                placeholder={
                  isAiTag
                    ? "搜索作品 ID / 作者 / 标题 / 标签 / 模型…"
                    : "输入画师或标签（如 wlop / 1girl，支持实时自动补全）…"
                }
                value={draftQuery}
                onFocus={() => setSuggestOpen(true)}
                onChange={(e) => {
                  setDraftQuery(e.target.value);
                  setSuggestOpen(true);
                }}
              />
              <button
                type="button"
                className={`m-suggest-mode-btn${suggestCategory === "artist" ? " on" : ""}`}
                title="切换补全模式：只补全画师 / 全部标签"
                onClick={() => {
                  setSuggestCategory((c) => (c === "artist" ? "all" : "artist"));
                  setSuggestOpen(true);
                }}
              >
                {suggestCategory === "artist" ? "只看画师" : "全标签"}
              </button>
              {draftQuery ? (
                <button
                  type="button"
                  className="m-search-clear"
                  title="清空"
                  onClick={() => {
                    setDraftQuery("");
                    submitSearch("", isAiTag ? draftPrompt : "");
                  }}
                >
                  <X />
                </button>
              ) : null}

              {suggestOpen && debouncedToken.length >= 2 && suggestions.length > 0 ? (
                <div className="m-suggest-pop" role="listbox">
                  <div className="m-suggest-head">
                    <span>
                      {suggestCategory === "artist"
                        ? "画师补全建议"
                        : "标签 / 画师补全（点击直接检索）"}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setSuggestCategory((c) => (c === "artist" ? "all" : "artist"))
                      }
                    >
                      {suggestCategory === "artist" ? "切换全部标签" : "只筛画师"}
                    </button>
                  </div>
                  {suggestions.map((s) => (
                    <button
                      key={`${s.category}-${s.name}`}
                      type="button"
                      className="m-suggest-item"
                      onClick={() => applySuggestion(s)}
                    >
                      <span className={`m-suggest-cat cat-${s.category}`}>
                        {CAT_LABEL[s.category] || "标签"}
                      </span>
                      <span className="m-suggest-name">{s.label}</span>
                      {s.postCount > 0 ? (
                        <span className="m-suggest-count">
                          {s.postCount.toLocaleString()}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {isAiTag ? (
              <div className="m-search-box prompt">
                <input
                  type="text"
                  placeholder="搜索 NAI / SD 元数据正向咒语…"
                  value={draftPrompt}
                  onChange={(e) => setDraftPrompt(e.target.value)}
                />
                {draftPrompt ? (
                  <button
                    type="button"
                    className="m-search-clear"
                    title="清空咒语"
                    onClick={() => {
                      setDraftPrompt("");
                      submitSearch(draftQuery, "");
                    }}
                  >
                    <X />
                  </button>
                ) : null}
              </div>
            ) : null}

            <button type="submit" className="btn btn-primary m-search-submit">
              检索
            </button>
          </form>
        ) : null}
      </div>

      <div className="m-bar-right">
        {mode === "feed" ? (
          <>
            {isAiTag ? (
              <>
                <select
                  aria-label="生成器类型筛选"
                  value={aiTypeFilter}
                  onChange={(e) => setAiTypeFilter(e.target.value as MediaAiTypeFilter)}
                >
                  <option value="all">全部类型</option>
                  <option value="NAI">只看 NAI</option>
                  <option value="SD">只看 SD</option>
                  <option value="ComfyUI">只看 ComfyUI</option>
                </select>
                <select
                  aria-label="排序方式"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as MediaSort)}
                >
                  <option value="new">最新收录</option>
                  <option value="monthly">月度热度榜</option>
                </select>
                <label className="m-r18-toggle" title="是否显示 R-18 作品">
                  <input
                    type="checkbox"
                    checked={showR18}
                    onChange={(e) => setShowR18(e.target.checked)}
                  />
                  <span>R-18</span>
                </label>
              </>
            ) : (
              <>
                <select
                  aria-label="Danbooru 排序"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as MediaSort)}
                >
                  <option value="new">最新上传</option>
                  <option value="score">最高评分 (Score)</option>
                  <option value="favcount">最多收藏 (Fav)</option>
                </select>
                <select
                  aria-label="Danbooru 分级过滤"
                  value={rating}
                  onChange={(e) => setRating(e.target.value as MediaRating)}
                >
                  <option value="all">全部分级</option>
                  <option value="g">全年龄 (G)</option>
                  <option value="s">敏感 (S)</option>
                  <option value="q">成人边缘 (Q)</option>
                  <option value="e">限制级 (E)</option>
                </select>
              </>
            )}

            {total != null ? (
              <span className="m-total-count">共 {total.toLocaleString()} 件</span>
            ) : null}

            <div className="m-pager">
              <button
                type="button"
                className="btn m-page-btn"
                disabled={page <= 1 || loading}
                title="上一页"
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft />
              </button>
              <span className="m-page-num">P.{page}</span>
              <button
                type="button"
                className="btn m-page-btn"
                disabled={!hasMore || loading}
                title="下一页"
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight />
              </button>
            </div>
          </>
        ) : null}

        <button
          type="button"
          className="btn m-icon-btn"
          title="重新抓取当前页"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className={loading ? "spin" : ""} />
        </button>

        <button
          type="button"
          className="btn m-icon-btn"
          title="手动打开站点安全验证窗口"
          onClick={onOpenVerify}
        >
          <ShieldCheck />
        </button>
      </div>
    </div>
  );
}
