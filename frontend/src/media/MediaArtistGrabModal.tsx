import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  FolderPlus,
  ShoppingBasket,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { mediaApi } from "@/api";
import {
  buildArtistGrabMeta,
  collectMediaArtistCandidates,
  copyText,
  isSingleArtistAlbum,
  mediaProxyImageUrl,
  queryKeys,
  SINGLE_ARTIST_ALBUM_ID,
  type MediaArtistCandidate,
  type MediaPost,
} from "@/data";
import {
  pushToast,
  useAlbumsQuery,
  useBasketActions,
  useBasketQuery,
  useItemsQuery,
  useMediaStore,
} from "@/state";

export function MediaArtistGrabModal({
  posts,
  detailsById,
}: {
  posts: MediaPost[];
  detailsById: Record<string, MediaPost | undefined>;
}) {
  const open = useMediaStore((s) => s.artistGrabOpen);
  const setOpen = useMediaStore((s) => s.setArtistGrabOpen);
  const submitSearch = useMediaStore((s) => s.submitSearch);

  const albumsQ = useAlbumsQuery();
  const albums = albumsQ.data || [];
  const singleAlbum = useMemo(
    () =>
      albums.find((a) => isSingleArtistAlbum(a)) ||
      albums.find((a) => a.id === SINGLE_ARTIST_ALBUM_ID) ||
      null,
    [albums],
  );
  const singleItemsQ = useItemsQuery(singleAlbum?.id || SINGLE_ARTIST_ALBUM_ID);
  const basketQ = useBasketQuery();
  const { add: addToBasket } = useBasketActions();
  const qc = useQueryClient();

  const basketKeys = useMemo(
    () => new Set((basketQ.data || []).map((b) => b.key)),
    [basketQ.data],
  );

  const candidates = useMemo(
    () =>
      collectMediaArtistCandidates(posts, {
        detailsById,
        singleArtistItems: singleItemsQ.data || [],
        basketKeys,
      }),
    [posts, detailsById, singleItemsQ.data, basketKeys],
  );

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [chosenPostByKey, setChosenPostByKey] = useState<Record<string, string>>({});
  const [targetAlbumId, setTargetAlbumId] = useState<string>(SINGLE_ARTIST_ALBUM_ID);
  const [alsoAddBasket, setAlsoAddBasket] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (singleAlbum?.id) {
      setTargetAlbumId(singleAlbum.id);
    }
  }, [singleAlbum?.id]);

  // 每次打开弹窗时，默认自动勾选尚未在「单画师」库中的新画师
  useEffect(() => {
    if (!open) return;
    const uncollected = candidates.filter((c) => !c.inSingleAlbum).map((c) => c.key);
    setSelectedKeys(new Set(uncollected.length > 0 ? uncollected : candidates.map((c) => c.key)));
  }, [open, candidates.length]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  function toggleArtist(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllNew() {
    setSelectedKeys(new Set(candidates.filter((c) => !c.inSingleAlbum).map((c) => c.key)));
  }

  function selectAll() {
    setSelectedKeys(new Set(candidates.map((c) => c.key)));
  }

  function clearSelection() {
    setSelectedKeys(new Set());
  }

  function pickedPostFor(c: MediaArtistCandidate): MediaPost {
    const chosenId = chosenPostByKey[c.key];
    return c.posts.find((p) => p.id === chosenId) || c.posts[0];
  }

  const selectedCandidates = useMemo(
    () => candidates.filter((c) => selectedKeys.has(c.key)),
    [candidates, selectedKeys],
  );

  async function handleCopySelected() {
    if (!selectedCandidates.length) return;
    const text = selectedCandidates.map((c) => c.tagString).join(", ");
    await copyText(text);
    pushToast(`已复制 ${selectedCandidates.length} 位画师串`);
  }

  function handleBasketSelected() {
    if (!selectedCandidates.length) return;
    addToBasket(selectedCandidates.map((c) => c.name));
    pushToast(`已将 ${selectedCandidates.length} 位画师加入画师串`);
  }

  async function handleGrabSingle(c: MediaArtistCandidate) {
    if (busy) return;
    const post = pickedPostFor(c);
    const imgUrl = post.sampleUrl || post.fileUrl || post.previewUrl;
    if (!imgUrl) {
      pushToast(`画师 ${c.name} 缺少可用代表图`, "error");
      return;
    }
    const albumId = targetAlbumId || singleAlbum?.id || SINGLE_ARTIST_ALBUM_ID;
    setBusy(true);
    try {
      await mediaApi.importToAlbum({
        albumId,
        siteId: post.siteId,
        imageUrl: imgUrl,
        meta: buildArtistGrabMeta(post, c.name),
      });
      if (alsoAddBasket) {
        addToBasket([c.name]);
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.items(albumId) }),
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
      ]);
      pushToast(`已抓取画师「${c.name}」及代表图入库`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "抓取失败";
      pushToast(`${c.name}：${msg}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleGrabBatch() {
    if (busy || !selectedCandidates.length) return;
    const albumId = targetAlbumId || singleAlbum?.id || SINGLE_ARTIST_ALBUM_ID;
    setBusy(true);
    setProgress({ done: 0, total: selectedCandidates.length });

    let okCount = 0;
    let skipCount = 0;
    const grabbedNames: string[] = [];

    for (let i = 0; i < selectedCandidates.length; i++) {
      const c = selectedCandidates[i];
      setProgress({ done: i + 1, total: selectedCandidates.length });
      const post = pickedPostFor(c);
      const imgUrl = post.sampleUrl || post.fileUrl || post.previewUrl;
      if (!imgUrl) {
        skipCount += 1;
        continue;
      }
      try {
        await mediaApi.importToAlbum({
          albumId,
          siteId: post.siteId,
          imageUrl: imgUrl,
          meta: buildArtistGrabMeta(post, c.name),
        });
        okCount += 1;
        grabbedNames.push(c.name);
      } catch {
        skipCount += 1;
      }
    }

    if (alsoAddBasket && grabbedNames.length > 0) {
      addToBasket(grabbedNames);
    }

    await Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.items(albumId) }),
      qc.invalidateQueries({ queryKey: queryKeys.albums }),
    ]);

    setBusy(false);
    setProgress(null);
    if (okCount > 0) {
      pushToast(
        `成功抓取 ${okCount} 位画师（各 1 张代表图）入库${skipCount ? `，跳过 ${skipCount} 项重复或异常` : ""}`,
      );
    } else {
      pushToast("所选画师图片均已在目标收藏夹中或无法下载", "error");
    }
  }

  return (
    <dialog
      className="modal m-grab-dialog"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) setOpen(false);
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) setOpen(false);
      }}
    >
      <div className="m-grab-wrap">
        <header className="m-grab-head">
          <div className="m-grab-title-row">
            <Users className="m-grab-ico" />
            <div>
              <h3>画师提取与一键抓图入库</h3>
              <p>
                从当前页作品中自动识别出 <strong>{candidates.length}</strong> 位画师 ·
                每位画师绑定 <strong>1 张代表图 + 画师名</strong>，可直接抓入「单画师」收藏夹用于悬停预览与抽卡
              </p>
            </div>
          </div>
          <button
            type="button"
            className="m-drawer-close"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            <X />
          </button>
        </header>

        <div className="m-grab-bar">
          <div className="m-grab-bar-left">
            <button type="button" className="btn btn-sm" onClick={selectAllNew}>
              只选未入库 ({candidates.filter((c) => !c.inSingleAlbum).length})
            </button>
            <button type="button" className="btn btn-sm" onClick={selectAll}>
              全选 ({candidates.length})
            </button>
            <button type="button" className="btn btn-sm" onClick={clearSelection}>
              清空
            </button>
            <span className="m-grab-sel-stat">
              已选 <strong>{selectedCandidates.length}</strong> 位画师
            </span>
          </div>

          <div className="m-grab-bar-right">
            <label className="m-grab-album-pick">
              <span>存入：</span>
              <select
                value={targetAlbumId}
                onChange={(e) => setTargetAlbumId(e.target.value)}
              >
                {albums.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {isSingleArtistAlbum(a) ? "（推荐 · 单画师库）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="m-r18-toggle">
              <input
                type="checkbox"
                checked={alsoAddBasket}
                onChange={(e) => setAlsoAddBasket(e.target.checked)}
              />
              <span>同时加入画师串</span>
            </label>
          </div>
        </div>

        <div className="m-grab-body">
          {candidates.length === 0 ? (
            <div className="m-grab-empty">
              <p>当前页作品暂未识别到画师标签（AI TAG 作品正在后台拉取元数据或不含 artist: 词条）。</p>
            </div>
          ) : (
            <div className="m-grab-grid">
              {candidates.map((c) => {
                const checked = selectedKeys.has(c.key);
                const post = pickedPostFor(c);
                const thumb = mediaProxyImageUrl(
                  post.siteId,
                  post.previewUrl || post.sampleUrl || post.fileUrl,
                );
                return (
                  <div
                    key={c.key}
                    className={`m-grab-card${checked ? " sel" : ""}${c.inSingleAlbum ? " owned" : ""}`}
                    onClick={() => toggleArtist(c.key)}
                  >
                    <div className="m-grab-thumb">
                      {thumb ? <img src={thumb} alt={c.name} loading="lazy" /> : null}
                      <span className={`m-grab-check${checked ? " on" : ""}`}>
                        <Check />
                      </span>
                      <div className="m-grab-badges">
                        {c.inSingleAlbum ? (
                          <span className="m-grab-badge ok">已在单画师库</span>
                        ) : (
                          <span className="m-grab-badge new">新画师</span>
                        )}
                        {c.inBasket ? (
                          <span className="m-grab-badge basket">已在篮中</span>
                        ) : null}
                      </div>
                      {c.posts.length > 1 ? (
                        <div
                          className="m-grab-post-switch"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {c.posts.slice(0, 5).map((p, idx) => (
                            <button
                              key={p.id}
                              type="button"
                              className={p.id === post.id ? "on" : ""}
                              title={`切换代表图 #${p.id}`}
                              onClick={() =>
                                setChosenPostByKey((prev) => ({
                                  ...prev,
                                  [c.key]: p.id,
                                }))
                              }
                            >
                              图{idx + 1}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="m-grab-info">
                      <div className="m-grab-name" title={c.name}>
                        {c.name}
                      </div>
                      <div className="m-grab-tag" title={c.tagString}>
                        {c.tagString}
                      </div>
                      <div
                        className="m-grab-card-acts"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="btn btn-sm"
                          title="只搜这位画师的作品"
                          onClick={() => {
                            setOpen(false);
                            submitSearch(
                              post.siteKind === "danbooru"
                                ? c.name.replace(/\s+/g, "_")
                                : c.name,
                            );
                          }}
                        >
                          搜TA作品
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busy}
                          title="抓取该画师名称与当前代表图入库"
                          onClick={() => void handleGrabSingle(c)}
                        >
                          <Sparkles /> 抓入库
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <footer className="m-grab-foot">
          <div className="m-grab-foot-left">
            <button
              type="button"
              className="btn"
              disabled={!selectedCandidates.length || busy}
              onClick={() => void handleCopySelected()}
            >
              <Copy /> 复制所选画师串 ({selectedCandidates.length})
            </button>
            <button
              type="button"
              className="btn"
              disabled={!selectedCandidates.length || busy}
              onClick={handleBasketSelected}
            >
              <ShoppingBasket /> 加入画师串
            </button>
          </div>

          <div className="m-grab-foot-right">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              关闭
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!selectedCandidates.length || busy}
              onClick={() => void handleGrabBatch()}
            >
              <FolderPlus />
              <span>
                {busy && progress
                  ? `正在抓取 (${progress.done}/${progress.total})…`
                  : `一键抓取所选 ${selectedCandidates.length} 位画师 (1画师+1图)`}
              </span>
            </button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
