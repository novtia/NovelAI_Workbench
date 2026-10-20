import type { ReactNode } from "react";
import { artistText, asMeta, charCaptions, copyText, negativeText, promptText, sourceLabel } from "@/data";
import type { Artwork } from "@/data/types";
import { IconCopy, IconX } from "@/generation/components/icons";
import { pushToast } from "@/state";
import { ArtistHoverTrigger } from "./ArtistHover";
import { BasketAddButton } from "./BasketAddButton";

export function ImageDetail({
  item,
  onClose,
  onGenerate,
  onDelete,
  albumId,
  album,
  id,
}: {
  item: Artwork | null;
  onClose: () => void;
  onGenerate: () => void;
  onDelete: () => void;
  /** 收藏夹下拉框的 id，给标签用。 */
  albumId?: string;
  /** 标签右边的控件。图库是移动用的下拉框，历史是下拉框加「存入」。 */
  album?: ReactNode;
  id?: string;
}) {
  const p = asMeta(item?.params);
  const size =
    p.width && p.height ? `${p.width} × ${p.height}` : item?.width && item?.height ? `${item.width} × ${item.height}` : "—";
  const chars = item ? charCaptions(item) : [];

  async function copyArtists() {
    const text = item ? artistText(item) : "";
    pushToast((await copyText(text)) ? "已复制画师串" : "没有可复制的画师", text ? "ok" : "warn");
  }

  async function copyPrompt() {
    const text = item ? promptText(item) : "";
    pushToast((await copyText(text)) ? "已复制 Prompt" : "没有 Prompt", text ? "ok" : "warn");
  }

  return (
    <aside className={`inspector${item ? " open" : ""}`} id={id} aria-hidden={!item}>
      <div className="insp-inner">
        <div className="insp-head">
          <span className="pane-title">图片详情</span>
          <button className="icon-btn" type="button" title="复制画师串" aria-label="复制画师串" onClick={() => void copyArtists()}>
            <IconCopy />
          </button>
          <button className="icon-btn" type="button" title="关闭" aria-label="关闭" onClick={onClose}>
            <IconX />
          </button>
        </div>
        <div className="insp-body">
          {item && (
            <>
              <div className="preview">
                <img src={item.imageUrl} alt="" width={item.width || undefined} height={item.height || undefined} />
              </div>
              <div className="artist-row">
                {item.artists.length ? (
                  item.artists.map((n) => (
                    <ArtistHoverTrigger className="chip" name={n} key={n}>
                      artist:{n}
                      <BasketAddButton names={[n]} />
                    </ArtistHoverTrigger>
                  ))
                ) : (
                  <span className="chip">未识别画师</span>
                )}
              </div>
              <dl className="meta-grid">
                <dt>文件</dt>
                <dd>{item.name}</dd>
                <dt>模型</dt>
                <dd>{p.model || "—"}</dd>
                <dt>来源</dt>
                <dd>{p.software || "—"}</dd>
                <dt>分辨率</dt>
                <dd>{size}</dd>
                <dt>步数</dt>
                <dd>{p.steps ?? "—"}</dd>
                <dt>Sampler</dt>
                <dd>{p.sampler || "—"}</dd>
                <dt>CFG</dt>
                <dd>{p.scale ?? "—"}</dd>
                <dt>Seed</dt>
                <dd>{p.seed ?? "—"}</dd>
                <dt>解析</dt>
                <dd>{sourceLabel(p.source)}</dd>
              </dl>
              {album != null && (
                <div className="move-row">
                  <label htmlFor={albumId}>收藏夹</label>
                  {album}
                </div>
              )}
              <div className="block">
                <div className="block-head">
                  <span>Prompt</span>
                </div>
                <pre className="prompt">{promptText(item) || "—"}</pre>
              </div>
              <div className="block">
                <div className="block-head">
                  <span>Negative</span>
                </div>
                <pre className="prompt">{negativeText(item) || "—"}</pre>
              </div>
              {chars.map((c, i) => {
                const center = c.centers?.[0];
                const pos = center ? ` · (${Number(center.x).toFixed(2)}, ${Number(center.y).toFixed(2)})` : "";
                return (
                  <div className="block" key={i}>
                    <div className="block-head">
                      <span>
                        角色 {i + 1}
                        {pos}
                      </span>
                    </div>
                    <pre className="prompt">{c.char_caption || ""}</pre>
                  </div>
                );
              })}
            </>
          )}
        </div>
        <div className="insp-foot">
          <button className="btn" type="button" onClick={() => void copyPrompt()}>
            复制 Prompt
          </button>
          <button className="btn btn-primary" type="button" onClick={onGenerate}>
            用此参数生图
          </button>
          <button className="btn btn-danger" type="button" onClick={onDelete}>
            删除
          </button>
        </div>
      </div>
    </aside>
  );
}
