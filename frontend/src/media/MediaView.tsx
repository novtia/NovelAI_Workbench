import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Copy,
  Heart,
  Layers,
  RefreshCw,
  ShieldAlert,
  ShoppingBasket,
  UserPlus,
} from "lucide-react";
import { mediaApi } from "@/api";
import {
  buildArtistGrabMeta,
  cleanMediaErrorMessage,
  copyText,
  isCfChallengeError,
  isSingleArtistAlbum,
  mediaProxyImageUrl,
  queryKeys,
  resolvePostArtists,
  SINGLE_ARTIST_ALBUM_ID,
  tagKey,
  type MediaPost,
} from "@/data";
import {
  pushToast,
  useAlbumsQuery,
  useBasketActions,
  useItemsQuery,
  useMediaArtistsQuery,
  useMediaFeedQuery,
  useMediaPostDetailQuery,
  useMediaStore,
  useSession,
} from "@/state";
import { DanbooruArtistDetailView } from "./DanbooruArtistDetailView";
import { DanbooruArtistsView } from "./DanbooruArtistsView";
import { MediaHome } from "./MediaHome";
import { MediaPostDetailView } from "./MediaPostDetailView";
import { MediaToolbar } from "./MediaToolbar";
import { SiteDialog } from "./SiteDialog";

function MediaPostCard({
  post,
  singleArtistKeys,
  singleAlbumId,
  onOpenDetail,
}: {
  post: MediaPost;
  singleArtistKeys: Set<string>;
  singleAlbumId: string;
  onOpenDetail: (mergedPost: MediaPost) => void;
}) {
  const isAiTag = post.siteKind === "aitag";
  // AI TAG 列表项自动拉取详情缓存，修正首图缩略图地址
  const detailQ = useMediaPostDetailQuery(
    isAiTag ? post.siteId : "",
    isAiTag ? post.id : null,
  );

  const qc = useQueryClient();
  const { add: addToBasket } = useBasketActions();
  const openArtistDetail = useMediaStore((s) => s.openArtistDetail);
  const submitSearch = useMediaStore((s) => s.submitSearch);
  const [grabbing, setGrabbing] = useState(false);

  const merged = detailQ.data ? { ...post, ...detailQ.data } : post;
  const resolvedPreview =
    merged.previewUrl || merged.sampleUrl || merged.fileUrl;
  const thumbSrc = mediaProxyImageUrl(post.siteId, resolvedPreview);
  const ratio = Math.max(
    0.55,
    Math.min(1.85, (merged.width || 1000) / Math.max(1, merged.height || 1200)),
  );

  const artists = resolvePostArtists(post, detailQ.data);
  const primaryArtist = artists[0] || "";
  const inSingleLib = primaryArtist
    ? singleArtistKeys.has(tagKey(primaryArtist))
    : false;
  const artistLine =
    artists.length > 0 ? artists.join(", ") : merged.authorName || "";

  async function handleQuickGrabArtist(e: React.MouseEvent) {
    e.stopPropagation();
    if (!primaryArtist || grabbing) return;
    const imgUrl = merged.sampleUrl || merged.fileUrl || merged.previewUrl;
    if (!imgUrl) {
      pushToast("缺少可用图片地址", "error");
      return;
    }
    setGrabbing(true);
    try {
      await mediaApi.importToAlbum({
        albumId: singleAlbumId,
        siteId: merged.siteId,
        imageUrl: imgUrl,
        meta: buildArtistGrabMeta(merged, primaryArtist),
      });
      addToBasket([primaryArtist]);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.items(singleAlbumId) }),
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
      ]);
      pushToast(`已将画师「${primaryArtist}」与代表图存入单画师库`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "入库失败", "error");
    } finally {
      setGrabbing(false);
    }
  }

  return (
    <div
      className="m-card"
      style={{ "--r": ratio.toFixed(3) } as React.CSSProperties}
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(merged)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail(merged);
        }
      }}
    >
      <div className="m-card-frame">
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={merged.title}
            loading="lazy"
            decoding="async"
          />
        ) : null}
        {merged.aiType ? (
          <span className={`m-card-type kind-${merged.aiType.toLowerCase()}`}>
            {merged.aiType}
          </span>
        ) : null}
        {merged.imageCount > 1 ? (
          <span className="m-card-count">
            <Layers /> {merged.imageCount}
          </span>
        ) : null}

        {primaryArtist ? (
          <div className="m-card-hover-bar" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={`m-hover-grab-btn${inSingleLib ? " owned" : ""}`}
              disabled={grabbing}
              title="将画师名与当前图片存入本地单画师库"
              onClick={(e) => void handleQuickGrabArtist(e)}
            >
              {inSingleLib ? <Check /> : <UserPlus />}
              <span>
                {grabbing
                  ? "入库中…"
                  : inSingleLib
                    ? "已在画师库"
                    : "存入单画师库"}
              </span>
            </button>
            <button
              type="button"
              className="m-hover-ico-btn"
              title={`将 ${artists.join(", ")} 加入画师串`}
              onClick={(e) => {
                e.stopPropagation();
                addToBasket(artists);
                pushToast(`已将 ${artists.join(", ")} 加入画师串`);
              }}
            >
              <ShoppingBasket />
            </button>
            <button
              type="button"
              className="m-hover-ico-btn"
              title={`复制 artist:${primaryArtist}`}
              onClick={(e) => {
                e.stopPropagation();
                void copyText(`artist:${primaryArtist}`);
                pushToast(`已复制 artist:${primaryArtist}`);
              }}
            >
              <Copy />
            </button>
          </div>
        ) : null}
      </div>

      <div className="m-card-meta">
        <div className="m-card-title" title={merged.title}>
          {merged.title || `#${merged.id}`}
        </div>
        <div className="m-card-sub">
          {primaryArtist ? (
            <button
              type="button"
              className={`m-card-artist-pill${inSingleLib ? " owned" : ""}`}
              title={
                post.siteKind === "danbooru"
                  ? `点击进入画师 ${primaryArtist} 的独立画师详细页`
                  : `点击搜索画师 ${primaryArtist} 的作品`
              }
              onClick={(e) => {
                e.stopPropagation();
                if (post.siteKind === "danbooru") {
                  openArtistDetail({
                    id: primaryArtist,
                    name: primaryArtist.replace(/\s+/g, "_"),
                    otherNames: [],
                    groupName: "",
                    postCount: 0,
                    isDeleted: false,
                    updatedAt: "",
                    urls: [],
                    previewPost: merged,
                  });
                } else {
                  submitSearch(primaryArtist);
                }
              }}
            >
              <span>artist:{primaryArtist}</span>
              {artists.length > 1 ? <em>+{artists.length - 1}</em> : null}
            </button>
          ) : (
            <span className="m-card-artist" title={artistLine}>
              {artistLine || `#${merged.id}`}
            </span>
          )}
          {merged.favCount > 0 ? (
            <span className="m-card-fav">
              <Heart /> {merged.favCount}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function MediaView() {
  const view = useSession((s) => s.view);
  const mode = useMediaStore((s) => s.mode);
  const siteId = useMediaStore((s) => s.siteId);
  const query = useMediaStore((s) => s.query);
  const promptQuery = useMediaStore((s) => s.promptQuery);
  const page = useMediaStore((s) => s.page);
  const sort = useMediaStore((s) => s.sort);
  const rating = useMediaStore((s) => s.rating);
  const artistQuery = useMediaStore((s) => s.artistQuery);
  const artistPage = useMediaStore((s) => s.artistPage);
  const activeArtist = useMediaStore((s) => s.activeArtist);
  const activePostSnapshot = useMediaStore((s) => s.activePostSnapshot);
  const openPostDetail = useMediaStore((s) => s.openPostDetail);
  const backToHome = useMediaStore((s) => s.backToHome);

  const feedQ = useMediaFeedQuery(view === "media" && mode === "feed");
  const artistsQ = useMediaArtistsQuery(view === "media" && mode === "artists");

  const albumsQ = useAlbumsQuery();
  const singleAlbum = useMemo(() => {
    const list = albumsQ.data || [];
    return (
      list.find((a) => isSingleArtistAlbum(a)) ||
      list.find((a) => a.id === SINGLE_ARTIST_ALBUM_ID) ||
      null
    );
  }, [albumsQ.data]);
  const singleAlbumId = singleAlbum?.id || SINGLE_ARTIST_ALBUM_ID;
  const singleItemsQ = useItemsQuery(singleAlbumId);

  const singleArtistKeys = useMemo(() => {
    const s = new Set<string>();
    for (const item of singleItemsQ.data || []) {
      for (const a of item.artists || []) {
        const k = tagKey(a);
        if (k) s.add(k);
      }
    }
    return s;
  }, [singleItemsQ.data]);

  const qc = useQueryClient();

  const activeError =
    mode === "artists"
      ? artistsQ.isError
        ? artistsQ.error
        : null
      : mode === "feed"
        ? feedQ.isError
          ? feedQ.error
          : null
        : null;
  const isCfError = Boolean(activeError && isCfChallengeError(activeError));
  const autoOpenedKeyRef = useRef<string>("");

  // 遇到 CF_CHALLENGE 时自动弹出内置验证窗口，并轮询 checkCfStatus；一旦验证完成自动收起并刷新
  useEffect(() => {
    if (view !== "media" || mode === "home" || !isCfError) {
      autoOpenedKeyRef.current = "";
      return;
    }
    const triggerKey = `${siteId}:${mode}:${query}:${artistQuery}:${page}:${artistPage}`;
    if (autoOpenedKeyRef.current !== triggerKey) {
      autoOpenedKeyRef.current = triggerKey;
      void mediaApi.openCfVerify(siteId).catch(() => undefined);
    }

    let stopped = false;
    const timer = window.setInterval(async () => {
      if (stopped) return;
      try {
        const res = await mediaApi.checkCfStatus(siteId);
        if (stopped) return;
        if (res.verified) {
          window.clearInterval(timer);
          await qc.invalidateQueries({ queryKey: queryKeys.mediaSites });
          pushToast("安全验证已通过，正在加载数据…");
          if (mode === "artists") {
            void artistsQ.refetch();
          } else {
            void feedQ.refetch();
          }
        }
      } catch {
        /* ignore polling error */
      }
    }, 1200);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [
    view,
    mode,
    isCfError,
    siteId,
    query,
    promptQuery,
    artistQuery,
    page,
    artistPage,
    sort,
    rating,
    qc,
    feedQ,
    artistsQ,
  ]);

  const posts = feedQ.data?.posts || [];
  const artists = artistsQ.data?.artists || [];

  async function handleManualOpenVerify() {
    try {
      await mediaApi.openCfVerify(siteId);
      pushToast("已打开站点验证窗口，验证完成后将自动同步");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "无法打开验证窗口", "error");
    }
  }

  function handleRefreshCurrent() {
    if (mode === "artists") {
      void artistsQ.refetch();
    } else {
      void feedQ.refetch();
    }
  }

  return (
    <section
      className={`view${view === "media" ? " active" : ""}`}
      id="view-media"
    >
      {mode === "home" ? (
        <MediaHome />
      ) : mode === "postDetail" && activePostSnapshot ? (
        <div className="m-feed-layout">
          <MediaToolbar
            total={null}
            hasMore={false}
            loading={false}
            onRefresh={() => undefined}
            onOpenVerify={() => void handleManualOpenVerify()}
          />
          <MediaPostDetailView post={activePostSnapshot} />
        </div>
      ) : mode === "artistDetail" && activeArtist ? (
        <div className="m-feed-layout">
          <MediaToolbar
            total={null}
            hasMore={false}
            loading={false}
            onRefresh={() => undefined}
            onOpenVerify={() => void handleManualOpenVerify()}
          />
          <div className="m-feed-body">
            <div className="m-feed-scroll">
              <DanbooruArtistDetailView
                artist={activeArtist}
                singleArtistKeys={singleArtistKeys}
                singleAlbumId={singleAlbumId}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="m-feed-layout">
          <MediaToolbar
            total={mode === "feed" ? (feedQ.data?.total ?? null) : null}
            hasMore={
              mode === "artists"
                ? Boolean(artistsQ.data?.hasMore)
                : Boolean(feedQ.data?.hasMore)
            }
            loading={
              mode === "artists" ? artistsQ.isFetching : feedQ.isFetching
            }
            onRefresh={handleRefreshCurrent}
            onOpenVerify={() => void handleManualOpenVerify()}
          />

          <div className="m-feed-body">
            <div className="m-feed-scroll">
              {isCfError ? (
                <div className="m-state-card cf">
                  <ShieldAlert className="m-cf-ico" />
                  <h3>正在等待安全验证通过…</h3>
                  <p>
                    {cleanMediaErrorMessage(activeError)}
                    <br />
                    系统已自动为您弹出内置安全验证窗口，完成人机验证后将
                    <strong>自动隐藏窗口并立即加载数据</strong>。
                  </p>
                  <div className="m-state-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void handleManualOpenVerify()}
                    >
                      重新弹出验证窗口
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={handleRefreshCurrent}
                    >
                      <RefreshCw /> 我已完成验证，立即刷新
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={backToHome}
                    >
                      <ArrowLeft /> 返回导航首页
                    </button>
                  </div>
                </div>
              ) : mode === "artists" ? (
                <DanbooruArtistsView
                  artists={artists}
                  hasMore={Boolean(artistsQ.data?.hasMore)}
                  loading={artistsQ.isLoading || artistsQ.isFetching}
                  error={artistsQ.isError ? artistsQ.error : null}
                  singleArtistKeys={singleArtistKeys}
                  singleAlbumId={singleAlbumId}
                  onRetry={() => void artistsQ.refetch()}
                />
              ) : feedQ.isLoading ? (
                <div className="m-state-card">
                  <div className="m-spinner" aria-hidden="true" />
                  <h3>正在连接并排版站点作品…</h3>
                  <p>
                    正在从 {siteId === "aitag" ? "AI TAG" : "Danbooru"} 拉取数据，请稍候
                  </p>
                </div>
              ) : feedQ.isError ? (
                <div className="m-state-card error">
                  <h3>读取站点数据失败</h3>
                  <p>{cleanMediaErrorMessage(feedQ.error)}</p>
                  <div className="m-state-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void feedQ.refetch()}
                    >
                      <RefreshCw /> 重试
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void handleManualOpenVerify()}
                    >
                      打开站点验证窗口
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={backToHome}
                    >
                      <ArrowLeft /> 返回导航首页
                    </button>
                  </div>
                </div>
              ) : posts.length === 0 ? (
                <div className="m-state-card">
                  <h3>没有找到匹配的作品</h3>
                  <p>试试更换检索关键词，或返回导航首页切换其它站点。</p>
                </div>
              ) : (
                <div className="m-grid">
                  {posts.map((post) => (
                    <MediaPostCard
                      key={`${post.siteId}-${post.id}`}
                      post={post}
                      singleArtistKeys={singleArtistKeys}
                      singleAlbumId={singleAlbumId}
                      onOpenDetail={(merged) => openPostDetail(merged)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <SiteDialog />
    </section>
  );
}

export { MediaView as default };
