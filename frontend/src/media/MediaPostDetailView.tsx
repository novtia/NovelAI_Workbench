import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Eye,
  FolderPlus,
  Heart,
  ShoppingBasket,
  Sparkles,
  UserPlus,
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
  type MediaPostPage,
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

type AiMetaMode = "readable" | "json" | "instruction";

function extractCharPrompts(params?: Record<string, unknown>): Array<{ prompt: string; uc: string }> {
  if (!params || typeof params !== "object") return [];
  const v4Prompt = params.v4_prompt as Record<string, unknown> | undefined;
  const v4Neg = params.v4_negative_prompt as Record<string, unknown> | undefined;
  const posChars = (v4Prompt?.caption as Record<string, unknown> | undefined)?.char_captions;
  const negChars = (v4Neg?.caption as Record<string, unknown> | undefined)?.char_captions;
  if (!Array.isArray(posChars)) return [];
  return posChars
    .map((item, idx) => {
      const p =
        item && typeof item === "object"
          ? String((item as Record<string, unknown>).char_caption || "").trim()
          : "";
      const negItem = Array.isArray(negChars) ? negChars[idx] : null;
      const u =
        negItem && typeof negItem === "object"
          ? String((negItem as Record<string, unknown>).char_caption || "").trim()
          : "";
      return { prompt: p, uc: u };
    })
    .filter((c) => c.prompt || c.uc);
}

function formatInstructionText(page: MediaPostPage, post: MediaPost): string {
  const params = page.params || post.rawParams || {};
  const lines: string[] = [];
  if (page.prompt) {
    lines.push(`Positive Prompt:\n${page.prompt}`);
  }
  const chars = extractCharPrompts(params);
  chars.forEach((c, idx) => {
    lines.push(
      `Character #${idx + 1} Prompt:\n${c.prompt}${c.uc ? `\nCharacter #${idx + 1} UC:\n${c.uc}` : ""}`,
    );
  });
  if (page.negativePrompt) {
    lines.push(`Negative Prompt (UC):\n${page.negativePrompt}`);
  }
  const metaParts: string[] = [];
  if (page.model || post.model) metaParts.push(`Model: ${page.model || post.model}`);
  if (params.steps != null) metaParts.push(`Steps: ${String(params.steps)}`);
  if (params.scale != null) metaParts.push(`CFG Scale: ${String(params.scale)}`);
  if (params.sampler) metaParts.push(`Sampler: ${String(params.sampler)}`);
  if (params.noise_schedule) metaParts.push(`Schedule: ${String(params.noise_schedule)}`);
  if (params.seed != null) metaParts.push(`Seed: ${String(params.seed)}`);
  if (params.width && params.height) {
    metaParts.push(`Size: ${String(params.width)}×${String(params.height)}`);
  }
  if (metaParts.length) {
    lines.push(metaParts.join(" | "));
  }
  return lines.join("\n\n");
}

function PageCard({
  page,
  totalCount,
  post,
  metaMode,
  targetAlbumId,
  singleAlbumId,
  albumsCount,
}: {
  page: MediaPostPage;
  totalCount: number;
  post: MediaPost;
  metaMode: AiMetaMode;
  targetAlbumId: string;
  singleAlbumId: string;
  albumsCount: number;
}) {
  const [expanded, setExpanded] = useState(totalCount === 1);
  const [importing, setImporting] = useState(false);

  const qc = useQueryClient();
  const imgUrl = mediaProxyImageUrl(
    post.siteId,
    page.fileUrl || page.previewUrl || post.fileUrl,
  );
  const params = page.params || post.rawParams || {};
  const chars = extractCharPrompts(params);
  const instructionText = formatInstructionText(page, post);

  function handleSendPageToStudio() {
    const tabId = useTabs.getState().openTab("studio");
    const store = useStudioStore.forTab(tabId);
    const curForm = store.getState().form;
    store.getState().setForm({
      ...curForm,
      prompt: page.prompt || post.prompt || curForm.prompt,
      uc: page.negativePrompt || post.negativePrompt || curForm.uc,
    });
    pushToast(`已将 P${page.index + 1} 参数带入生图室`);
  }

  async function handleImportPage() {
    const rawUrl = page.fileUrl || page.previewUrl || post.fileUrl;
    if (!rawUrl || !targetAlbumId || importing) return;
    setImporting(true);
    try {
      const isSingle = targetAlbumId === singleAlbumId;
      const meta =
        isSingle && post.artists.length >= 1
          ? buildArtistGrabMeta(
              {
                ...post,
                prompt: page.prompt || post.prompt,
                negativePrompt: page.negativePrompt || post.negativePrompt,
                model: page.model || post.model,
              },
              post.artists[0],
            )
          : {
              name: `${post.siteKind}-${post.id}-p${page.index + 1}`,
              artists: post.artists,
              artistLine: post.artists.map((a) => `artist:${a}`).join(", "),
              params: {
                prompt: page.prompt || post.prompt,
                uc: page.negativePrompt || post.negativePrompt,
                source: post.sourceUrl,
                model: page.model || post.model,
              },
            };

      await mediaApi.importToAlbum({
        albumId: targetAlbumId,
        siteId: post.siteId,
        imageUrl: rawUrl,
        meta,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.items(targetAlbumId) }),
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
      ]);
      pushToast(`已将 P${page.index + 1} 存入收藏夹`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "导入失败", "error");
    } finally {
      setImporting(false);
    }
  }

  async function handleCopyCurrentMode() {
    const text =
      metaMode === "json"
        ? page.rawJson || JSON.stringify(params, null, 2)
        : metaMode === "instruction"
          ? instructionText
          : page.prompt || post.prompt;
    if (!text) {
      pushToast("暂无可复制的元数据", "error");
      return;
    }
    await copyText(text);
    pushToast(
      metaMode === "json"
        ? "已复制原始 JSON"
        : metaMode === "instruction"
          ? "已复制完整生成指令"
          : "已复制正向提示词",
    );
  }

  return (
    <div className="m-pd-image-card">
      <div className="m-pd-image-head">
        <span className="m-pd-page-badge">
          P{page.index + 1} / {totalCount}
        </span>
        {page.model || post.model ? (
          <span className="m-pd-model-chip">{page.model || post.model}</span>
        ) : null}
        <div className="m-pd-image-acts">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleCopyCurrentMode()}
          >
            <Copy />
            <span>
              {metaMode === "json"
                ? "复制 JSON"
                : metaMode === "instruction"
                  ? "复制指令"
                  : "复制提示词"}
            </span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!(page.prompt || post.prompt)}
            onClick={handleSendPageToStudio}
          >
            <Sparkles /> 带入生图室
          </button>
          {albumsCount > 0 ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={importing}
              onClick={() => void handleImportPage()}
            >
              <FolderPlus /> {importing ? "导入中…" : "存入收藏夹"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="m-pd-image-frame">
        {imgUrl ? (
          <img src={imgUrl} alt={`${post.title} P${page.index + 1}`} loading="lazy" />
        ) : null}
      </div>

      {/* 每张图片的 AI 元数据框（对标 AI TAG 网页版的易读 / 原始 JSON / 指令三模式 + 展开折叠） */}
      {page.prompt || page.negativePrompt || page.rawJson ? (
        <div className={`m-pd-meta-box${expanded ? " expanded" : " collapsed"}`}>
          <div className="m-pd-meta-box-bar">
            <span className="m-pd-meta-box-title">
              AI 元数据 ·{" "}
              {metaMode === "readable"
                ? "易读视图"
                : metaMode === "json"
                  ? "原始 JSON"
                  : "生成指令"}
            </span>
            <div className="m-pd-meta-box-btns">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void handleCopyCurrentMode()}
              >
                <Copy /> 复制
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? (
                  <>
                    <ChevronUp /> 折叠
                  </>
                ) : (
                  <>
                    <ChevronDown /> 显示全部
                  </>
                )}
              </button>
            </div>
          </div>

          {metaMode === "readable" ? (
            <div className="m-pd-readable">
              {/* 核心生成参数指标条 */}
              <div className="m-pd-param-chips">
                {params.steps != null ? (
                  <span>Steps: {String(params.steps)}</span>
                ) : null}
                {params.scale != null ? (
                  <span>Scale: {String(params.scale)}</span>
                ) : null}
                {params.sampler ? (
                  <span>Sampler: {String(params.sampler)}</span>
                ) : null}
                {params.noise_schedule ? (
                  <span>Schedule: {String(params.noise_schedule)}</span>
                ) : null}
                {params.seed != null ? (
                  <span>Seed: {String(params.seed)}</span>
                ) : null}
                {params.width && params.height ? (
                  <span>
                    尺寸: {String(params.width)}×{String(params.height)}
                  </span>
                ) : null}
              </div>

              {page.prompt ? (
                <div className="m-pd-prompt-sec">
                  <div className="m-pd-prompt-label">
                    <span>正向提示词 (Positive Prompt)</span>
                    <button
                      type="button"
                      onClick={() => {
                        void copyText(page.prompt);
                        pushToast("已复制正向提示词");
                      }}
                    >
                      复制正向
                    </button>
                  </div>
                  <pre className="m-pd-code">{page.prompt}</pre>
                </div>
              ) : null}

              {chars.length > 0 ? (
                <div className="m-pd-prompt-sec">
                  <div className="m-pd-prompt-label">
                    <span>多角色分区提示词 (V4 Character Captions · {chars.length})</span>
                  </div>
                  <div className="m-pd-char-list">
                    {chars.map((c, idx) => (
                      <div key={idx} className="m-pd-char-item">
                        <strong>角色 #{idx + 1}：</strong> {c.prompt}
                        {c.uc ? <div className="m-pd-char-uc">UC: {c.uc}</div> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {page.negativePrompt ? (
                <div className="m-pd-prompt-sec">
                  <div className="m-pd-prompt-label">
                    <span>反向提示词 (Negative Prompt / UC)</span>
                    <button
                      type="button"
                      onClick={() => {
                        void copyText(page.negativePrompt);
                        pushToast("已复制反向提示词");
                      }}
                    >
                      复制反向
                    </button>
                  </div>
                  <pre className="m-pd-code dim">{page.negativePrompt}</pre>
                </div>
              ) : null}
            </div>
          ) : metaMode === "instruction" ? (
            <pre className="m-pd-code">{instructionText}</pre>
          ) : (
            <pre className="m-pd-code">
              {page.rawJson || JSON.stringify(params, null, 2)}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function MediaPostDetailView({
  post: initialPost,
}: {
  post: MediaPost;
}) {
  const detailQ = useMediaPostDetailQuery(initialPost.siteId, initialPost.id);
  const full = detailQ.data || initialPost;

  const goBack = useMediaStore((s) => s.goBackFromDetail);
  const submitSearch = useMediaStore((s) => s.submitSearch);
  const openArtistDetail = useMediaStore((s) => s.openArtistDetail);

  const [metaMode, setMetaMode] = useState<AiMetaMode>("readable");
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [targetAlbumId, setTargetAlbumId] = useState("");
  const [grabbingArtist, setGrabbingArtist] = useState<string | null>(null);

  const albumsQ = useAlbumsQuery();
  const sessionAlbumId = useSession((s) => s.albumId);
  const { add: addToBasket } = useBasketActions();
  const qc = useQueryClient();

  const albums = albumsQ.data || [];
  const singleAlbum =
    albums.find((a) => isSingleArtistAlbum(a)) ||
    albums.find((a) => a.id === SINGLE_ARTIST_ALBUM_ID) ||
    null;
  const singleAlbumId = singleAlbum?.id || SINGLE_ARTIST_ALBUM_ID;

  useEffect(() => {
    if (!targetAlbumId && albums.length) {
      const preferred =
        albums.find((a) => a.id === sessionAlbumId) ||
        singleAlbum ||
        albums[0];
      if (preferred) setTargetAlbumId(preferred.id);
    }
  }, [albums, sessionAlbumId, singleAlbum, targetAlbumId]);

  const artists = resolvePostArtists(initialPost, detailQ.data);
  const pages: MediaPostPage[] =
    full.pages && full.pages.length > 0
      ? full.pages
      : [
          {
            index: 0,
            previewUrl: full.previewUrl,
            fileUrl: full.sampleUrl || full.fileUrl || full.previewUrl,
            model: full.model,
            prompt: full.prompt,
            negativePrompt: full.negativePrompt,
            rawJson: "",
            params: full.rawParams,
          },
        ];

  const isAiTag = full.siteKind === "aitag";

  async function handleCopyAllImageLinks() {
    const links = pages.map((p) => p.fileUrl || p.previewUrl).filter(Boolean);
    if (!links.length) return;
    await copyText(links.join("\n"));
    pushToast(`已复制全部 ${links.length} 条图片链接`);
  }

  async function handleGrabArtist(artistName: string) {
    const rawImgUrl =
      pages[0]?.fileUrl || full.sampleUrl || full.fileUrl || full.previewUrl;
    if (!rawImgUrl || grabbingArtist) return;
    setGrabbingArtist(artistName);
    try {
      await mediaApi.importToAlbum({
        albumId: singleAlbumId,
        siteId: full.siteId,
        imageUrl: rawImgUrl,
        meta: buildArtistGrabMeta(full, artistName),
      });
      addToBasket([artistName]);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.items(singleAlbumId) }),
        qc.invalidateQueries({ queryKey: queryKeys.albums }),
      ]);
      pushToast(`已将画师「${artistName}」与代表图存入单画师库`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "抓取失败", "error");
    } finally {
      setGrabbingArtist(null);
    }
  }

  return (
    <div className="m-post-detail-page">
      {/* 详细页顶栏：返回按钮 + 作品标题 + 收藏夹选择 + 原帖跳转 */}
      <header className="m-pd-header">
        <div className="m-pd-header-left">
          <button type="button" className="btn m-back-btn" onClick={goBack}>
            <ArrowLeft /> 返回列表
          </button>
          <h2 className="m-pd-title">{full.title || `作品 #${full.id}`}</h2>
          {full.aiType ? (
            <span className={`m-card-type static kind-${full.aiType.toLowerCase()}`}>
              {full.aiType}
            </span>
          ) : null}
        </div>

        <div className="m-pd-header-right">
          {albums.length > 0 ? (
            <label className="m-grab-album-pick">
              <span>存入目标收藏夹：</span>
              <select
                value={targetAlbumId}
                onChange={(e) => setTargetAlbumId(e.target.value)}
              >
                {albums.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <button
            type="button"
            className="btn"
            onClick={() => void handleCopyAllImageLinks()}
          >
            <Copy /> 复制全部图片链接 ({pages.length})
          </button>

          {full.sourceUrl ? (
            <button
              type="button"
              className="btn"
              onClick={() =>
                useTabs.getState().openWebTab({
                  name: full.title || `#${full.id}`,
                  baseUrl: full.sourceUrl,
                })
              }
            >
              <ExternalLink /> 内置标签打开原网页
            </button>
          ) : null}
        </div>
      </header>

      <div className="m-pd-scroll">
        <div className="m-pd-container">
          {/* 作品元数据信息面板（对标 AI TAG detailMeta + Danbooru 侧栏标签） */}
          <section className="m-pd-meta-panel">
            <div className="m-pd-meta-grid">
              {isAiTag ? (
                <>
                  <div className="m-pd-row">
                    <span className="m-pd-label">Pixiv ID：</span>
                    <button
                      type="button"
                      className="m-tag"
                      onClick={() =>
                        useTabs.getState().openWebTab({
                          name: `Pixiv #${full.id}`,
                          baseUrl: `https://www.pixiv.net/artworks/${full.id}`,
                        })
                      }
                    >
                      <ExternalLink /> {full.id}
                    </button>
                  </div>

                  {full.authorName || full.authorId ? (
                    <div className="m-pd-row">
                      <span className="m-pd-label">作者 (Author)：</span>
                      <button
                        type="button"
                        className="m-tag char"
                        title="点击按该作者 ID 检索全部作品"
                        onClick={() =>
                          submitSearch(full.authorId || full.authorName)
                        }
                      >
                        {full.authorName
                          ? `${full.authorName} (${full.authorId})`
                          : full.authorId}
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="m-pd-row">
                  <span className="m-pd-label">Danbooru ID：</span>
                  <span className="m-pd-val">#{full.id}</span>
                  {full.rating ? (
                    <span className="m-tag">分级: {full.rating.toUpperCase()}</span>
                  ) : null}
                </div>
              )}

              {full.createdAt ? (
                <div className="m-pd-row">
                  <span className="m-pd-label">投稿时间：</span>
                  <span className="m-pd-val">
                    {full.createdAt.replace("T", " ").slice(0, 19)}
                  </span>
                </div>
              ) : null}

              <div className="m-pd-row">
                <span className="m-pd-label">互动数据：</span>
                <span className="m-pd-stat">
                  <Eye /> {isAiTag ? "浏览" : "评分"} {full.score.toLocaleString()}
                </span>
                <span className="m-pd-stat">
                  <Heart /> 收藏 {full.favCount.toLocaleString()}
                </span>
                <span className="m-pd-stat">共 {pages.length} 张图</span>
              </div>
            </div>

            {/* 识别出的画师栏（可一键进入画师详细页或存入单画师库） */}
            {artists.length > 0 ? (
              <div className="m-pd-artists-box">
                <div className="m-pd-row-head">
                  <span className="m-pd-label">画师 ({artists.length})：</span>
                  <div className="m-drawer-sec-btns">
                    <button
                      type="button"
                      onClick={() => {
                        const text = artists.map((a) => `artist:${a}`).join(", ");
                        void copyText(text);
                        pushToast(`已复制 ${text}`);
                      }}
                    >
                      <Copy /> 复制全部画师
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        addToBasket(artists);
                        pushToast(`已将 ${artists.length} 位画师加入画师串`);
                      }}
                    >
                      <ShoppingBasket /> 全部加入画师串
                    </button>
                  </div>
                </div>
                <div className="m-pd-artist-chips">
                  {artists.map((a) => (
                    <div key={a} className="m-pd-artist-pill">
                      <button
                        type="button"
                        className="m-tag artist"
                        title={
                          full.siteKind === "danbooru"
                            ? "点击进入该画师的独立画师详细页"
                            : "点击检索该画师作品"
                        }
                        onClick={() => {
                          if (full.siteKind === "danbooru") {
                            openArtistDetail({
                              id: a,
                              name: a.replace(/\s+/g, "_"),
                              otherNames: [],
                              groupName: "",
                              postCount: 0,
                              isDeleted: false,
                              updatedAt: "",
                              urls: [],
                            });
                          } else {
                            submitSearch(a);
                          }
                        }}
                      >
                        artist:{a}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={grabbingArtist === a}
                        onClick={() => void handleGrabArtist(a)}
                      >
                        <UserPlus />
                        <span>
                          {grabbingArtist === a ? "入库中…" : "存入单画师库"}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* 角色与版权标签（Danbooru） */}
            {full.tagsCharacter.length > 0 || full.tagsCopyright.length > 0 ? (
              <div className="m-pd-tags-block">
                <span className="m-pd-label">角色与作品版权：</span>
                <div className="m-tag-list">
                  {full.tagsCharacter.map((t) => (
                    <button
                      key={`char-${t}`}
                      type="button"
                      className="m-tag char"
                      onClick={() => submitSearch(t.replace(/\s+/g, "_"))}
                    >
                      {t}
                    </button>
                  ))}
                  {full.tagsCopyright.map((t) => (
                    <button
                      key={`copy-${t}`}
                      type="button"
                      className="m-tag copy"
                      onClick={() => submitSearch(t.replace(/\s+/g, "_"))}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* 作品标签（支持 AI TAG 中文翻译展示与点击检索） */}
            {(full.tagTranslations && full.tagTranslations.length > 0) ||
            full.tagsGeneral.length > 0 ? (
              <div className="m-pd-tags-block">
                <span className="m-pd-label">
                  作品标签 ({full.tagsGeneral.length})：
                </span>
                <div className="m-tag-list">
                  {full.tagTranslations && full.tagTranslations.length > 0
                    ? full.tagTranslations.map((item) => (
                        <button
                          key={item.name}
                          type="button"
                          className="m-tag"
                          onClick={() => submitSearch(`"${item.name}"`)}
                        >
                          <span>{item.name}</span>
                          {item.translated ? (
                            <em className="m-tag-trans">({item.translated})</em>
                          ) : null}
                        </button>
                      ))
                    : full.tagsGeneral.map((t) => (
                        <button
                          key={t}
                          type="button"
                          className="m-tag"
                          onClick={() =>
                            submitSearch(
                              isAiTag ? `"${t}"` : t.replace(/\s+/g, "_"),
                            )
                          }
                        >
                          {t}
                        </button>
                      ))}
                </div>
              </div>
            ) : null}

            {/* 作品简介（Caption，支持展开/折叠） */}
            {full.caption ? (
              <div className="m-pd-caption-block">
                <div className="m-pd-row-head">
                  <span className="m-pd-label">作品简介 (Caption)：</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setCaptionExpanded((v) => !v)}
                  >
                    {captionExpanded ? "折叠简介" : "展开全部简介"}
                  </button>
                </div>
                <div
                  className={`m-pd-caption-text${captionExpanded ? " expanded" : ""}`}
                >
                  {full.caption.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")}
                </div>
              </div>
            ) : null}

            {/* AI 元数据展示模式切换（易读 / 原始 JSON / 指令） */}
            <div className="m-pd-mode-row">
              <span className="m-pd-label">AI 元数据模式：</span>
              <div className="m-site-pills" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={metaMode === "readable"}
                  className={`m-site-pill${metaMode === "readable" ? " on" : ""}`}
                  onClick={() => setMetaMode("readable")}
                >
                  易读视图
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={metaMode === "json"}
                  className={`m-site-pill${metaMode === "json" ? " on" : ""}`}
                  onClick={() => setMetaMode("json")}
                >
                  原始 JSON
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={metaMode === "instruction"}
                  className={`m-site-pill${metaMode === "instruction" ? " on" : ""}`}
                  onClick={() => setMetaMode("instruction")}
                >
                  完整指令
                </button>
              </div>
            </div>
          </section>

          {detailQ.isLoading ? (
            <div className="m-state-card">
              <div className="m-spinner" />
              <h3>正在拉取全部图片与完整 AI 元数据…</h3>
            </div>
          ) : null}

          {/* 作品全部图片及每张图的独立 AI 元数据卡片列表 */}
          <section className="m-pd-images-list">
            {pages.map((page) => (
              <PageCard
                key={page.index}
                page={page}
                totalCount={pages.length}
                post={full}
                metaMode={metaMode}
                targetAlbumId={targetAlbumId}
                singleAlbumId={singleAlbumId}
                albumsCount={albums.length}
              />
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
