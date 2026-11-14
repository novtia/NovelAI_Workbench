import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Images,
  Search,
  ShoppingBasket,
  UserPlus,
  X,
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
} from "@/data";
import {
  pushToast,
  useBasketActions,
  useMediaArtistPreviewQuery,
  useMediaStore,
  type MediaArtistOrder,
} from "@/state";

function ArtistCard({
  artist,
  inSingleLib,
  singleAlbumId,
  onOpenDetail,
}: {
  artist: MediaArtist;
  inSingleLib: boolean;
  singleAlbumId: string;
  onOpenDetail: () => void;
}) {
  // 自动为该画师抓取 1 张代表作品图（解决原版 Danbooru 画师列表无图痛点）
  const previewQ = useMediaArtistPreviewQuery(artist.name, artist.postCount > 0);
  const previewPost = previewQ.data?.post || artist.previewPost || null;
  const thumbUrl = previewPost
    ? mediaProxyImageUrl(
        "danbooru",
        previewPost.previewUrl || previewPost.sampleUrl || previewPost.fileUrl,
      )
    : "";

  const displayName = artist.name.replace(/_/g, " ");
  const { add: addToBasket } = useBasketActions();
  const qc = useQueryClient();
  const [grabbing, setGrabbing] = useState(false);

  async function handleSaveToSingleAlbum(e: React.MouseEvent) {
    e.stopPropagation();
    if (!previewPost || grabbing) return;
    const imgUrl =
      previewPost.sampleUrl || previewPost.fileUrl || previewPost.previewUrl;
    if (!imgUrl) return;
    setGrabbing(true);
    try {
      await mediaApi.importToAlbum({
        albumId: singleAlbumId,
        siteId: "danbooru",
        imageUrl: imgUrl,
        meta: buildArtistGrabMeta(previewPost, displayName),
      });
      addToBasket([displayName]);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.items(singleAlbumId) }),
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
      ]);
      pushToast(`已将画师「${displayName}」及代表图存入单画师库`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "入库失败", "error");
    } finally {
      setGrabbing(false);
    }
  }

  return (
    <div
      className="m-db-artist-card"
      role="button"
      tabIndex={0}
      onClick={onOpenDetail}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail();
        }
      }}
    >
      {/* 代表作品缩略图区域 */}
      <div className="m-db-artist-thumb">
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={artist.name}
            loading="lazy"
            decoding="async"
          />
        ) : previewQ.isLoading && artist.postCount > 0 ? (
          <div className="m-db-artist-placeholder">
            <div className="m-spinner" />
            <span>正在抓取代表图…</span>
          </div>
        ) : (
          <div className="m-db-artist-placeholder dim">
            <Images />
            <span>{artist.postCount > 0 ? "暂无预览图" : "0 张作品"}</span>
          </div>
        )}

        {/* 左上角作品数量徽标（显示有多少图） */}
        <span className="m-db-artist-count" title={`共 ${artist.postCount} 张作品`}>
          <Images />
          <strong>{artist.postCount.toLocaleString()}</strong> 张图
        </span>

        {/* 悬停快捷操作栏 */}
        <div
          className="m-card-hover-bar"
          onClick={(e) => e.stopPropagation()}
        >
          {previewPost ? (
            <button
              type="button"
              className={`m-hover-grab-btn${inSingleLib ? " owned" : ""}`}
              disabled={grabbing}
              title="将画师名与这张代表图存入本地「单画师」收藏夹"
              onClick={(e) => void handleSaveToSingleAlbum(e)}
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
          ) : null}
          <button
            type="button"
            className="m-hover-ico-btn"
            title={`将 ${displayName} 加入画师串`}
            onClick={() => {
              addToBasket([displayName]);
              pushToast(`已将 ${displayName} 加入画师串`);
            }}
          >
            <ShoppingBasket />
          </button>
          <button
            type="button"
            className="m-hover-ico-btn"
            title={`复制 artist:${displayName}`}
            onClick={() => {
              void copyText(`artist:${displayName}`);
              pushToast(`已复制 artist:${displayName}`);
            }}
          >
            <Copy />
          </button>
        </div>
      </div>

      {/* 画师信息区（对照原版 Danbooru Artists 列表：Name + 数量、Other Names、Updated） */}
      <div className="m-db-artist-body">
        <div className="m-db-artist-head">
          <span className="m-db-artist-name" title={artist.name}>
            {artist.name}
          </span>
          <span className="m-db-artist-num">{artist.postCount}</span>
        </div>

        {artist.otherNames && artist.otherNames.length > 0 ? (
          <div className="m-db-artist-others">
            {artist.otherNames.slice(0, 6).map((alias) => (
              <span key={alias} className="m-db-alias-chip" title={alias}>
                {alias}
              </span>
            ))}
            {artist.otherNames.length > 6 ? (
              <span className="m-db-alias-more">
                +{artist.otherNames.length - 6}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="m-db-artist-others empty">无其他别名</div>
        )}

        <div className="m-db-artist-foot">
          <span className="m-db-artist-time">
            {formatRelativeTime(artist.updatedAt)}
          </span>
          <span className="m-db-artist-link">查看画师详情 →</span>
        </div>
      </div>
    </div>
  );
}

export function DanbooruArtistsView({
  artists,
  hasMore,
  loading,
  error,
  singleArtistKeys,
  singleAlbumId,
  onRetry,
}: {
  artists: MediaArtist[];
  hasMore: boolean;
  loading: boolean;
  error: unknown;
  singleArtistKeys: Set<string>;
  singleAlbumId: string;
  onRetry: () => void;
}) {
  const artistQuery = useMediaStore((s) => s.artistQuery);
  const artistUrlQuery = useMediaStore((s) => s.artistUrlQuery);
  const artistOrder = useMediaStore((s) => s.artistOrder);
  const artistHasTag = useMediaStore((s) => s.artistHasTag);
  const artistDeleted = useMediaStore((s) => s.artistDeleted);
  const artistPage = useMediaStore((s) => s.artistPage);
  const submitArtistSearch = useMediaStore((s) => s.submitArtistSearch);
  const setArtistPage = useMediaStore((s) => s.setArtistPage);
  const openArtistDetail = useMediaStore((s) => s.openArtistDetail);

  const [draftName, setDraftName] = useState(artistQuery);
  const [draftUrl, setDraftUrl] = useState(artistUrlQuery);
  const [draftOrder, setDraftOrder] = useState<MediaArtistOrder>(artistOrder);
  const [draftHasTag, setDraftHasTag] = useState<"" | "true" | "false">(artistHasTag);
  const [draftDeleted, setDraftDeleted] = useState<"" | "true" | "false">(artistDeleted);

  useEffect(() => {
    setDraftName(artistQuery);
    setDraftUrl(artistUrlQuery);
    setDraftOrder(artistOrder);
    setDraftHasTag(artistHasTag);
    setDraftDeleted(artistDeleted);
  }, [artistQuery, artistUrlQuery, artistOrder, artistHasTag, artistDeleted]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitArtistSearch({
      name: draftName,
      url: draftUrl,
      order: draftOrder,
      hasTag: draftHasTag,
      isDeleted: draftDeleted,
    });
  }

  return (
    <div className="m-artists-page">
      {/* 顶部 Danbooru Artists 搜索筛选面板（还原并强化截图中的 Name / URL / Deleted? / Has tag? / Order） */}
      <form className="m-artists-filter-bar" onSubmit={onSubmit}>
        <div className="m-af-field">
          <label>画师名 / 别名 (Name)</label>
          <div className="m-af-input-wrap">
            <Search className="m-af-ico" />
            <input
              type="text"
              placeholder="输入画师罗马音、日文或中文名（如 wlop / 双柑）…"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
            />
            {draftName ? (
              <button
                type="button"
                className="m-search-clear"
                onClick={() => {
                  setDraftName("");
                  submitArtistSearch({ name: "" });
                }}
              >
                <X />
              </button>
            ) : null}
          </div>
        </div>

        <div className="m-af-field url">
          <label>关联网址 (URL)</label>
          <div className="m-af-input-wrap">
            <ExternalLink className="m-af-ico" />
            <input
              type="text"
              placeholder="Pixiv / Twitter / 个人主页链接…"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
            />
            {draftUrl ? (
              <button
                type="button"
                className="m-search-clear"
                onClick={() => {
                  setDraftUrl("");
                  submitArtistSearch({ url: "" });
                }}
              >
                <X />
              </button>
            ) : null}
          </div>
        </div>

        <div className="m-af-field small">
          <label>排序 (Order)</label>
          <select
            value={draftOrder}
            onChange={(e) => {
              const v = e.target.value as MediaArtistOrder;
              setDraftOrder(v);
              submitArtistSearch({ order: v });
            }}
          >
            <option value="created_at">最新收录 (Recently created)</option>
            <option value="updated_at">最近更新 (Last updated)</option>
            <option value="post_count">作品最多 (Most posts)</option>
            <option value="name">按名称 (Name)</option>
          </select>
        </div>

        <div className="m-af-field small">
          <label>有作品 (Has tag?)</label>
          <select
            value={draftHasTag}
            onChange={(e) => {
              const v = e.target.value as "" | "true" | "false";
              setDraftHasTag(v);
              submitArtistSearch({ hasTag: v });
            }}
          >
            <option value="">全部</option>
            <option value="true">有作品 (&gt;0)</option>
            <option value="false">无作品 (0)</option>
          </select>
        </div>

        <div className="m-af-field small">
          <label>状态 (Deleted?)</label>
          <select
            value={draftDeleted}
            onChange={(e) => {
              const v = e.target.value as "" | "true" | "false";
              setDraftDeleted(v);
              submitArtistSearch({ isDeleted: v });
            }}
          >
            <option value="false">正常</option>
            <option value="">全部</option>
            <option value="true">已删除</option>
          </select>
        </div>

        <button type="submit" className="btn btn-primary m-af-submit">
          搜索画师
        </button>
      </form>

      {/* 画师卡片宫格列表（每位画师自动抓取 1 张代表作品图 + 作品数 + 别名） */}
      {loading && artists.length === 0 ? (
        <div className="m-state-card">
          <div className="m-spinner" />
          <h3>正在读取 Danbooru 画师列表…</h3>
          <p>正在同步画师名、作品数、别名与代表作品图</p>
        </div>
      ) : error ? (
        <div className="m-state-card error">
          <h3>读取画师列表失败</h3>
          <p>{cleanMediaErrorMessage(error)}</p>
          <div className="m-state-actions">
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              重试
            </button>
          </div>
        </div>
      ) : artists.length === 0 ? (
        <div className="m-state-card">
          <h3>没有找到匹配的画师</h3>
          <p>试试更换画师名称、别名或清空筛选条件。</p>
        </div>
      ) : (
        <>
          <div className="m-db-artists-grid">
            {artists.map((artist) => (
              <ArtistCard
                key={artist.id}
                artist={artist}
                inSingleLib={singleArtistKeys.has(tagKey(artist.name))}
                singleAlbumId={singleAlbumId}
                onOpenDetail={() => openArtistDetail(artist)}
              />
            ))}
          </div>

          <div className="m-bottom-pager">
            <button
              type="button"
              className="btn"
              disabled={artistPage <= 1 || loading}
              onClick={() => setArtistPage(artistPage - 1)}
            >
              <ChevronLeft /> 上一页
            </button>
            <span className="m-page-num">第 {artistPage} 页</span>
            <button
              type="button"
              className="btn"
              disabled={!hasMore || loading}
              onClick={() => setArtistPage(artistPage + 1)}
            >
              下一页 <ChevronRight />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
