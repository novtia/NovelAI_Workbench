import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Compass,
  Globe,
  Images,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { mediaApi } from "@/api";
import {
  extractSiteHost,
  filterMediaSites,
  queryKeys,
  splitBuiltinAndCustomSites,
  type MediaSite,
} from "@/data";
import {
  confirmDialog,
  pushToast,
  useMediaSitesQuery,
  useMediaStore,
  useTabs,
} from "@/state";

export function MediaHome() {
  const sitesQ = useMediaSitesQuery();
  const homeFilter = useMediaStore((s) => s.homeFilter);
  const setHomeFilter = useMediaStore((s) => s.setHomeFilter);
  const enterSite = useMediaStore((s) => s.enterSite);
  const openCreateSiteDialog = useMediaStore((s) => s.openCreateSiteDialog);
  const openEditSiteDialog = useMediaStore((s) => s.openEditSiteDialog);
  const qc = useQueryClient();

  const allSites = sitesQ.data || [];
  const filtered = filterMediaSites(allSites, homeFilter);
  const { builtins, customs } = splitBuiltinAndCustomSites(filtered);
  const allCustoms = splitBuiltinAndCustomSites(allSites).customs;

  function handleOpenCustom(site: MediaSite) {
    useTabs.getState().openWebTab({
      id: site.id,
      name: site.name,
      baseUrl: site.baseUrl,
    });
  }

  async function handleDeleteCustom(site: MediaSite) {
    const ok = await confirmDialog(`从媒体导航移除「${site.name}」？`, {
      title: "删除自定义页面",
      confirmText: "移除",
    });
    if (!ok) return;
    try {
      await mediaApi.deleteSite(site.id);
      await qc.invalidateQueries({ queryKey: queryKeys.mediaSites });
      pushToast(`已移除 ${site.name}`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "删除失败", "error");
    }
  }

  async function handleMoveCustom(site: MediaSite, dir: -1 | 1) {
    const idx = allCustoms.findIndex((s) => s.id === site.id);
    const nextIdx = idx + dir;
    if (idx < 0 || nextIdx < 0 || nextIdx >= allCustoms.length) return;
    const ids = allCustoms.map((s) => s.id);
    const [item] = ids.splice(idx, 1);
    ids.splice(nextIdx, 0, item);
    try {
      await mediaApi.reorderSites(ids);
      await qc.invalidateQueries({ queryKey: queryKeys.mediaSites });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "排序失败", "error");
    }
  }

  return (
    <div className="m-home">
      <div className="m-home-inner">
        <header className="m-home-hero">
          <div className="m-home-brand">
            <span className="m-home-seal" aria-hidden="true">
              媒
            </span>
            <div>
              <h1 className="m-home-title">媒体网址导航</h1>
              <p className="m-home-sub">
                内置图库与独立画师页免配置直连排版、自动过盾 · 自定义页面在顶部工作台标签栏内一键打开
              </p>
            </div>
          </div>

          <div className="m-home-search">
            <Search className="m-home-search-ico" aria-hidden="true" />
            <input
              type="text"
              placeholder="筛选导航卡片，或输入画师 / 标签后按回车直接检索…"
              value={homeFilter}
              onChange={(e) => setHomeFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && homeFilter.trim()) {
                  e.preventDefault();
                  enterSite("danbooru", homeFilter.trim(), "artists");
                }
              }}
            />
            {homeFilter ? (
              <button
                type="button"
                className="m-home-search-clear"
                title="清空"
                onClick={() => setHomeFilter("")}
              >
                <X />
              </button>
            ) : null}
            {homeFilter.trim() ? (
              <div className="m-home-search-quick">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    enterSite("danbooru", homeFilter.trim(), "artists")
                  }
                >
                  搜 Danbooru 画师
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    enterSite("danbooru", homeFilter.trim(), "feed")
                  }
                >
                  搜 Danbooru 作品
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => enterSite("aitag", homeFilter.trim(), "feed")}
                >
                  搜 AI TAG
                </button>
              </div>
            ) : null}
          </div>
        </header>

        {/* 内置精选 · 本地排版 */}
        <section className="m-home-sec" aria-label="内置精选站点">
          <div className="m-sec-head">
            <span className="m-sec-title">
              <Sparkles />
              内置精选 · 本地数据排版
            </span>
            <span className="m-sec-hint">
              点击卡片进入本地排版；Danbooru 支持「作品 (Posts)」与独立「画师页 (Artists，自动加载画师代表图与作品数)」
            </span>
          </div>

          <div className="m-builtin-grid">
            {builtins.map((site) => {
              const isDanbooru = site.kind === "danbooru";
              const host = extractSiteHost(site.baseUrl);
              return (
                <div
                  key={site.id}
                  className={`m-builtin-card kind-${site.kind}`}
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    enterSite(site.id, undefined, isDanbooru ? "artists" : "feed")
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      enterSite(
                        site.id,
                        undefined,
                        isDanbooru ? "artists" : "feed",
                      );
                    }
                  }}
                >
                  <div className="m-builtin-top">
                    <div className="m-builtin-glyph" aria-hidden="true">
                      {isDanbooru ? "D" : "AI"}
                    </div>
                    <div className="m-builtin-meta">
                      <div className="m-builtin-name-row">
                        <span className="m-builtin-name">{site.name}</span>
                        <span className="m-builtin-badge">内置排版</span>
                        {site.hasClearance || site.hasCookie ? (
                          <span className="m-builtin-cf ok" title="已保存验证凭据">
                            <ShieldCheck /> 已就绪
                          </span>
                        ) : (
                          <span className="m-builtin-cf" title="无需手动配置，遇验证自动过盾">
                            自动过盾
                          </span>
                        )}
                      </div>
                      <div className="m-builtin-host">{host}</div>
                    </div>
                    <button
                      type="button"
                      className="m-card-act"
                      title="站点设置"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditSiteDialog(site);
                      }}
                    >
                      <Pencil />
                    </button>
                  </div>
                  <p className="m-builtin-desc">
                    {site.note ||
                      (isDanbooru
                        ? "二次元插画与独立画师数据库：画师页自动抓取每位画师 1 张代表图与作品总数，点进画师详细页浏览全部作品"
                        : "NovelAI / SD / ComfyUI 作品与咒语参数检索，点击作品进入完整详细页查看多图与元数据")}
                  </p>
                  <div
                    className="m-builtin-foot"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {isDanbooru ? (
                      <div className="m-builtin-subbtns">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => enterSite(site.id, undefined, "artists")}
                        >
                          <Users /> 进入画师页 (Artists)
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => enterSite(site.id, undefined, "feed")}
                        >
                          <Images /> 进入作品页 (Posts)
                        </button>
                      </div>
                    ) : (
                      <span
                        className="m-builtin-enter"
                        onClick={() => enterSite(site.id, undefined, "feed")}
                      >
                        进入 AI TAG 浏览 →
                      </span>
                    )}
                    {site.defaultQuery ? (
                      <span className="m-builtin-defq">
                        默认检索：{site.defaultQuery}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 我的导航 · 自定义页面 */}
        <section className="m-home-sec" aria-label="自定义网页导航">
          <div className="m-sec-head">
            <span className="m-sec-title">
              <Compass />
              我的导航 · 自定义页面
            </span>
            <span className="m-sec-hint">点击卡片在顶部标签栏新开内置网页标签页</span>
          </div>

          <div className="m-dial-grid">
            {customs.map((site) => {
              const host = extractSiteHost(site.baseUrl);
              const initial = (site.name || host || "W").trim().charAt(0).toUpperCase();
              const orderIdx = allCustoms.findIndex((s) => s.id === site.id);
              return (
                <div
                  key={site.id}
                  className="m-dial-card"
                  role="button"
                  tabIndex={0}
                  title={`${site.name} (${site.baseUrl}) — 点击在顶部标签栏打开`}
                  onClick={() => handleOpenCustom(site)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleOpenCustom(site);
                    }
                  }}
                >
                  <div className="m-dial-actions" onClick={(e) => e.stopPropagation()}>
                    {allCustoms.length > 1 ? (
                      <>
                        <button
                          type="button"
                          className="m-card-act"
                          title="前移"
                          disabled={orderIdx <= 0}
                          onClick={() => void handleMoveCustom(site, -1)}
                        >
                          <ArrowLeft />
                        </button>
                        <button
                          type="button"
                          className="m-card-act"
                          title="后移"
                          disabled={orderIdx < 0 || orderIdx >= allCustoms.length - 1}
                          onClick={() => void handleMoveCustom(site, 1)}
                        >
                          <ArrowRight />
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="m-card-act"
                      title="编辑页面"
                      onClick={() => openEditSiteDialog(site)}
                    >
                      <Pencil />
                    </button>
                    <button
                      type="button"
                      className="m-card-act danger"
                      title="移除页面"
                      onClick={() => void handleDeleteCustom(site)}
                    >
                      <Trash2 />
                    </button>
                  </div>

                  <div className="m-dial-icon" aria-hidden="true">
                    <span>{initial}</span>
                    <Globe className="m-dial-globe" />
                  </div>
                  <div className="m-dial-name">{site.name}</div>
                  <div className="m-dial-host">{host}</div>
                  {site.note ? <div className="m-dial-note">{site.note}</div> : null}
                </div>
              );
            })}

            <button
              type="button"
              className="m-dial-card m-dial-add"
              onClick={openCreateSiteDialog}
            >
              <div className="m-dial-add-ico" aria-hidden="true">
                <Plus />
              </div>
              <div className="m-dial-name">+ 添加页面</div>
              <div className="m-dial-host">添加常用网址到导航宫格</div>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
