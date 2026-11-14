import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  ExternalLink,
  FolderPlus,
  ShoppingBasket,
  Sparkles,
  UserPlus,
  X,
} from "lucide-react";
import { mediaApi } from "@/api";
import {
  buildArtistGrabMeta,
  copyText,
  isSingleArtistAlbum,
  mediaProxyImageUrl,
  queryKeys,
  resolvePostArtists,
  SINGLE_ARTIST_ALBUM_ID,
  type MediaPost,
} from "@/data";
import {
  pushToast,
  useAlbumsQuery,
  useBasketActions,
  useMediaPostDetailQuery,
  useMediaStore,
  useSession,
  useStudioStore,
  useTabs,
} from "@/state";

export function MediaPostDrawer({
  post,
  onClose,
}: {
  post: MediaPost;
  onClose: () => void;
}) {
  const detailQ = useMediaPostDetailQuery(post.siteId, post.id);
  const full = detailQ.data || post;

  const [pageIdx, setPageIdx] = useState(0);
  const [targetAlbumId, setTargetAlbumId] = useState("");
  const [importing, setImporting] = useState(false);
  const [grabbingArtist, setGrabbingArtist] = useState<string | null>(null);

  const albumsQ = useAlbumsQuery();
  const sessionAlbumId = useSession((s) => s.albumId);
  const { add } = useBasketActions();
  const submitSearch = useMediaStore((s) => s.submitSearch);
  const qc = useQueryClient();

  const albums = albumsQ.data || [];
  const singleAlbum =
    albums.find((a) => isSingleArtistAlbum(a)) ||
    albums.find((a) => a.id === SINGLE_ARTIST_ALBUM_ID) ||
    null;

  useEffect(() => {
    setPageIdx(0);
  }, [post.id]);

  useEffect(() => {
    if (!targetAlbumId && albums.length) {
      const preferred =
        albums.find((a) => a.id === sessionAlbumId) ||
        singleAlbum ||
        albums[0];
      if (preferred) setTargetAlbumId(preferred.id);
    }
  }, [albums, sessionAlbumId, singleAlbum, targetAlbumId]);

  const pages = full.pages && full.pages.length > 0 ? full.pages : null;
  const activePage = pages ? pages[Math.min(pageIdx, pages.length - 1)] : null;

  const rawImgUrl =
    activePage?.fileUrl || full.sampleUrl || full.fileUrl || full.previewUrl;
  const displayImgUrl = mediaProxyImageUrl(full.siteId, rawImgUrl);

  const prompt = activePage?.prompt || full.prompt || "";
  const negativePrompt = activePage?.negativePrompt || full.negativePrompt || "";
  const model = activePage?.model || full.model || full.aiType || "";
  const artists = resolvePostArtists(post, detailQ.data);

  async function handleCopyPrompt() {
    if (!prompt.trim()) {
      pushToast("当前作品暂无可复制的正向提示词", "error");
      return;
    }
    await copyText(prompt);
    pushToast("已复制正向提示词");
  }

  async function handleCopyArtists() {
    if (!artists.length) return;
    const text = artists.map((a) => `artist:${a}`).join(", ");
    await copyText(text);
    pushToast(`已复制 ${artists.length} 位画师标签`);
  }

  function handleAddBasket() {
    if (!artists.length) return;
    add(artists);
    pushToast(`已将 ${artists.length} 位画师加入画师串`);
  }

  /**
   * 核心：一键抓取某位画师的「画师名 + 当前图片」存入「单画师」收藏夹，并顺手加入画师串。
   */
  async function handleGrabArtistWithImage(artistName: string) {
    if (!rawImgUrl || grabbingArtist) return;
    const destAlbumId = singleAlbum?.id || SINGLE_ARTIST_ALBUM_ID;
    setGrabbingArtist(artistName);
    try {
      await mediaApi.importToAlbum({
        albumId: destAlbumId,
        siteId: full.siteId,
        imageUrl: rawImgUrl,
        meta: buildArtistGrabMeta(
          { ...full, prompt, negativePrompt, model },
          artistName,
        ),
      });
      add([artistName]);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.items(destAlbumId) }),
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
      ]);
      pushToast(`已抓取画师「${artistName}」+ 代表图入单画师库，并加入画师串`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "抓取画师失败", "error");
    } finally {
      setGrabbingArtist(null);
    }
  }

  function handleSendToStudio() {
    const tabId = useTabs.getState().openTab("studio");
    const store = useStudioStore.forTab(tabId);
    const curForm = store.getState().form;
    store.getState().setForm({
      ...curForm,
      prompt: prompt || curForm.prompt,
      uc: negativePrompt || curForm.uc,
    });
    pushToast("已带入新开的生图室标签页");
  }

  async function handleImportToAlbum() {
    if (!targetAlbumId || !rawImgUrl || importing) return;
    setImporting(true);
    try {
      const targetAlbum = albums.find((a) => a.id === targetAlbumId);
      const isSingleTarget = isSingleArtistAlbum(targetAlbum);
      // 若目标是「单画师」收藏夹且作品有多位或0位画师，自动取第一位画师（或作者名）构造合规单画师元数据
      const meta =
        isSingleTarget && artists.length >= 1
          ? buildArtistGrabMeta({ ...full, prompt, negativePrompt, model }, artists[0])
          : {
              name: `${full.siteKind}-${full.id}`,
              artists,
              artistLine: artists.map((a) => `artist:${a}`).join(", "),
              width: full.width || undefined,
              height: full.height || undefined,
              params: {
                prompt,
                uc: negativePrompt,
                source: full.sourceUrl,
                model,
              },
            };

      await mediaApi.importToAlbum({
        albumId: targetAlbumId,
        siteId: full.siteId,
        imageUrl: rawImgUrl,
        meta,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.items(targetAlbumId) }),
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
      ]);
      pushToast("已导入到收藏夹");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "导入失败", "error");
    } finally {
      setImporting(false);
    }
  }

  function handleSearchTag(tag: string) {
    const q = full.siteKind === "danbooru" ? tag.replace(/\s+/g, "_") : `"${tag}"`;
    submitSearch(q);
  }

  return (
    <aside className="m-drawer" aria-label="作品详情">
      <div className="m-drawer-head">
        <div className="m-drawer-title" title={full.title}>
          {full.title || `#${full.id}`}
        </div>
        <button
          type="button"
          className="m-drawer-close"
          title="关闭详情"
          onClick={onClose}
        >
          <X />
        </button>
      </div>

      <div className="m-drawer-body">
        <div className="m-drawer-preview">
          {displayImgUrl ? (
            <img src={displayImgUrl} alt={full.title} loading="lazy" />
          ) : null}
          {pages && pages.length > 1 ? (
            <div className="m-drawer-pages">
              {pages.map((p, idx) => (
                <button
                  key={p.index}
                  type="button"
                  className={idx === pageIdx ? "on" : ""}
                  onClick={() => setPageIdx(idx)}
                >
                  P{idx + 1}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {detailQ.isLoading ? (
          <div className="m-drawer-loading">正在读取完整元数据…</div>
        ) : null}

        {/* 画师抓取核心卡片区（置顶醒目展示） */}
        {artists.length > 0 ? (
          <div className="m-drawer-artist-box">
            <div className="m-drawer-sec-head">
              <span>识别画师 ({artists.length}) · 一键抓画师与代表图</span>
              <div className="m-drawer-sec-btns">
                <button type="button" onClick={() => void handleCopyArtists()}>
                  复制画师
                </button>
                <button type="button" onClick={handleAddBasket}>
                  <ShoppingBasket /> 全入画师串
                </button>
              </div>
            </div>
            <div className="m-artist-grab-rows">
              {artists.map((a) => (
                <div key={a} className="m-artist-grab-row">
                  <button
                    type="button"
                    className="m-tag artist"
                    title="点击按该画师搜索更多作品"
                    onClick={() => handleSearchTag(a)}
                  >
                    artist:{a}
                  </button>
                  <div className="m-artist-grab-row-btns">
                    <button
                      type="button"
                      className="btn btn-sm"
                      title="复制该画师 Tag"
                      onClick={() => {
                        void copyText(`artist:${a}`);
                        pushToast(`已复制 artist:${a}`);
                      }}
                    >
                      <Copy />
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={grabbingArtist === a}
                      title="将「该画师名 + 当前图片」抓入单画师库并加入画师串"
                      onClick={() => void handleGrabArtistWithImage(a)}
                    >
                      <UserPlus />
                      <span>{grabbingArtist === a ? "抓取中…" : "抓画师+此图"}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="m-drawer-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!prompt.trim()}
            onClick={() => void handleCopyPrompt()}
          >
            <Copy />
            <span>复制提示词</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={!prompt.trim()}
            onClick={handleSendToStudio}
          >
            <Sparkles />
            <span>带入生图室</span>
          </button>
          {full.sourceUrl ? (
            <button
              type="button"
              className="btn"
              title="在内置网页标签页查看原帖"
              onClick={() =>
                useTabs.getState().openWebTab({
                  name: `${full.title || full.id}`,
                  baseUrl: full.sourceUrl,
                })
              }
            >
              <ExternalLink />
              <span>内置标签打开原帖</span>
            </button>
          ) : null}
        </div>

        {/* 导入图库收藏夹 */}
        <div className="m-drawer-import">
          <select
            aria-label="选择目标收藏夹"
            value={targetAlbumId}
            onChange={(e) => setTargetAlbumId(e.target.value)}
          >
            {albums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={!targetAlbumId || importing}
            onClick={() => void handleImportToAlbum()}
          >
            <FolderPlus />
            <span>{importing ? "导入中…" : "存入收藏夹"}</span>
          </button>
        </div>

        {/* 角色与作品版权标签 */}
        {full.tagsCharacter.length > 0 || full.tagsCopyright.length > 0 ? (
          <div className="m-drawer-sec">
            <div className="m-drawer-sec-head">
              <span>角色与出处</span>
            </div>
            <div className="m-tag-list">
              {full.tagsCharacter.map((t) => (
                <button
                  key={`char-${t}`}
                  type="button"
                  className="m-tag char"
                  onClick={() => handleSearchTag(t)}
                >
                  {t}
                </button>
              ))}
              {full.tagsCopyright.map((t) => (
                <button
                  key={`copy-${t}`}
                  type="button"
                  className="m-tag copy"
                  onClick={() => handleSearchTag(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* 正向提示词 */}
        {prompt ? (
          <div className="m-drawer-sec">
            <div className="m-drawer-sec-head">
              <span>正向提示词 (Prompt)</span>
              <button type="button" onClick={() => void handleCopyPrompt()}>
                复制
              </button>
            </div>
            <pre className="m-drawer-code">{prompt}</pre>
          </div>
        ) : null}

        {/* 反向提示词 */}
        {negativePrompt ? (
          <div className="m-drawer-sec">
            <div className="m-drawer-sec-head">
              <span>反向提示词 (UC)</span>
              <button
                type="button"
                onClick={() => {
                  void copyText(negativePrompt);
                  pushToast("已复制反向提示词");
                }}
              >
                复制
              </button>
            </div>
            <pre className="m-drawer-code dim">{negativePrompt}</pre>
          </div>
        ) : null}

        {/* 通用标签 */}
        {full.tagsGeneral.length > 0 ? (
          <div className="m-drawer-sec">
            <div className="m-drawer-sec-head">
              <span>标签 ({full.tagsGeneral.length})</span>
            </div>
            <div className="m-tag-list">
              {full.tagsGeneral.slice(0, 80).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="m-tag"
                  onClick={() => handleSearchTag(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
