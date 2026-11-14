import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Heart,
  Images,
  ShoppingBasket,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { mediaApi } from "@/api";
import {
  buildArtistGrabMeta,
  cleanMediaErrorMessage,
  copyText,
  formatRelativeTime,
  mediaProxyImageUrl,
  queryKeys,
  tagKey,
  type MediaArtist,
  type MediaPost,
} from "@/data";
import {
  pushToast,
  useBasketActions,
  useMediaArtistPostsQuery,
  useMediaStore,
  useStudioStore,
  useTabs,
} from "@/state";

export function DanbooruArtistDetailView({
  artist,
  singleArtistKeys,
  singleAlbumId,
}: {
  artist: MediaArtist;
  singleArtistKeys: Set<string>;
  singleAlbumId: string;
}) {
  const page = useMediaStore((s) => s.artistDetailPage);
  const setPage = useMediaStore((s) => s.setArtistDetailPage);
  const goBack = useMediaStore((s) => s.goBackFromDetail);
  const openPostDetail = useMediaStore((s) => s.openPostDetail);

  const postsQ = useMediaArtistPostsQuery(artist.name, page, true);
  const posts = postsQ.data?.posts || [];
  const hasMore = Boolean(postsQ.data?.hasMore);

  const displayName = artist.name.replace(/_/g, " ");
  const artistTag = `artist:${displayName}`;
  const inSingleLib = singleArtistKeys.has(tagKey(displayName));

  const { add: addToBasket } = useBasketActions();
  const qc = useQueryClient();
  const [grabbingPostId, setGrabbingPostId] = useState<string | null>(null);

  async function handleGrabPostAsRepresentative(post: MediaPost) {
    if (grabbingPostId) return;
    const imgUrl = post.sampleUrl || post.fileUrl || post.previewUrl;
    if (!imgUrl) return;
    setGrabbingPostId(post.id);
    try {
      await mediaApi.importToAlbum({
        albumId: singleAlbumId,
        siteId: "danbooru",
        imageUrl: imgUrl,
        meta: buildArtistGrabMeta(post, displayName),
      });
      addToBasket([displayName]);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.items(singleAlbumId) }),
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
      ]);
      pushToast(`已将「${displayName}」与所选代表图存入单画师库`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "入库失败", "error");
    } finally {
      setGrabbingPostId(null);
    }
  }

  function handleSendArtistToStudio() {
    const tabId = useTabs.getState().openTab("studio");
    const store = useStudioStore.forTab(tabId);
    const curForm = store.getState().form;
    const nextPrompt = curForm.prompt.trim()
      ? `${artistTag}, ${curForm.prompt}`
      : artistTag;
    store.getState().setForm({
      ...curForm,
      prompt: nextPrompt,
    });
    pushToast(`已将 ${artistTag} 带入生图室`);
  }

  return (
    <div className="m-artist-detail-page">
      {/* 画师详细页头部信息卡 */}
      <div className="m-ad-hero">
        <div className="m-ad-hero-top">
          <button
            type="button"
            className="btn m-back-btn"
            onClick={goBack}
          >
            <ArrowLeft /> 返回画师列表
          </button>

          <div className="m-ad-hero-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                void copyText(artistTag);
                pushToast(`已复制 ${artistTag}`);
              }}
            >
              <Copy /> 复制 {artistTag}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                addToBasket([displayName]);
                pushToast(`已将 ${displayName} 加入画师串`);
              }}
            >
              <ShoppingBasket /> 加入画师串
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleSendArtistToStudio}
            >
              <Sparkles /> 带入生图室
            </button>
            {posts[0] ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={Boolean(grabbingPostId)}
                onClick={() => void handleGrabPostAsRepresentative(posts[0])}
              >
                {inSingleLib ? <Check /> : <UserPlus />}
                <span>
                  {grabbingPostId === posts[0].id
                    ? "入库中…"
                    : inSingleLib
                      ? "已在单画师库（点击追加首图）"
                      : "一键存入单画师库（画师名+首图）"}
                </span>
              </button>
            ) : null}
          </div>
        </div>

        <div className="m-ad-hero-main">
          <div className="m-ad-title-row">
            <h2 className="m-ad-name">{artist.name}</h2>
            <span className="m-ad-count-badge">
              <Images /> {artist.postCount.toLocaleString()} 张作品
            </span>
            {artist.groupName ? (
              <span className="m-ad-group-badge">社团/组合：{artist.groupName}</span>
            ) : null}
            {artist.updatedAt ? (
              <span className="m-ad-updated">
                更新于 {formatRelativeTime(artist.updatedAt)}
              </span>
            ) : null}
          </div>

          {artist.otherNames && artist.otherNames.length > 0 ? (
            <div className="m-ad-aliases">
              <span className="m-ad-label">常用名 / 别名 (Other Names)：</span>
              {artist.otherNames.map((alias) => (
                <span key={alias} className="m-db-alias-chip">
                  {alias}
                </span>
              ))}
            </div>
          ) : null}

          {artist.urls && artist.urls.length > 0 ? (
            <div className="m-ad-urls">
              <span className="m-ad-label">画师主页 / 外链 (URLs)：</span>
              <div className="m-ad-url-list">
                {artist.urls.slice(0, 8).map((u) => (
                  <button
                    key={u}
                    type="button"
                    className="m-ad-url-chip"
                    title="在工作台内置网页标签页打开"
                    onClick={() =>
                      useTabs.getState().openWebTab({
                        name: `${displayName} · 主页`,
                        baseUrl: u,
                      })
                    }
                  >
                    <ExternalLink />
                    <span>{u}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 画师作品网格 */}
      <div className="m-ad-works-sec">
        <div className="m-ad-works-head">
          <h3>
            画师作品集（共 {artist.postCount.toLocaleString()} 张 · 当前第 {page} 页）
          </h3>
          <div className="m-pager">
            <button
              type="button"
              className="btn m-page-btn"
              disabled={page <= 1 || postsQ.isFetching}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft />
            </button>
            <span className="m-page-num">P.{page}</span>
            <button
              type="button"
              className="btn m-page-btn"
              disabled={!hasMore || postsQ.isFetching}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight />
            </button>
          </div>
        </div>

        {postsQ.isLoading ? (
          <div className="m-state-card">
            <div className="m-spinner" />
            <h3>正在读取画师 {artist.name} 的作品…</h3>
          </div>
        ) : postsQ.isError ? (
          <div className="m-state-card error">
            <h3>读取画师作品失败</h3>
            <p>{cleanMediaErrorMessage(postsQ.error)}</p>
            <div className="m-state-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void postsQ.refetch()}
              >
                重试
              </button>
            </div>
          </div>
        ) : posts.length === 0 ? (
          <div className="m-state-card">
            <h3>该画师暂无作品记录</h3>
          </div>
        ) : (
          <div className="m-grid">
            {posts.map((post) => {
              const thumbSrc = mediaProxyImageUrl(
                "danbooru",
                post.previewUrl || post.sampleUrl || post.fileUrl,
              );
              const ratio = Math.max(
                0.55,
                Math.min(
                  1.85,
                  (post.width || 1000) / Math.max(1, post.height || 1200),
                ),
              );
              return (
                <div
                  key={post.id}
                  className="m-card"
                  style={{ "--r": ratio.toFixed(3) } as React.CSSProperties}
                  role="button"
                  tabIndex={0}
                  onClick={() => openPostDetail(post)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openPostDetail(post);
                    }
                  }}
                >
                  <div className="m-card-frame">
                    {thumbSrc ? (
                      <img
                        src={thumbSrc}
                        alt={post.title}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : null}
                    <div
                      className="m-card-hover-bar"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="m-hover-grab-btn"
                        disabled={grabbingPostId === post.id}
                        title="选用这张图作为该画师的代表图存入单画师库"
                        onClick={() => void handleGrabPostAsRepresentative(post)}
                      >
                        <UserPlus />
                        <span>
                          {grabbingPostId === post.id
                            ? "入库中…"
                            : "设为画师代表图入库"}
                        </span>
                      </button>
                    </div>
                  </div>
                  <div className="m-card-meta">
                    <div className="m-card-title" title={post.title}>
                      {post.title || `#${post.id}`}
                    </div>
                    <div className="m-card-sub">
                      <span className="m-card-artist">#{post.id}</span>
                      {post.favCount > 0 ? (
                        <span className="m-card-fav">
                          <Heart /> {post.favCount}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
