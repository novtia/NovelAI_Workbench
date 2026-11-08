import { useEffect } from "react";
import { artistText, asMeta, charCaptions, copyText, negativeText, promptText, sourceLabel } from "@/data";
import type { Artwork } from "@/data/types";
import { IconCopy, IconDownload } from "@/generation/components/icons";
import { pushToast } from "@/state";
import { ArtistHoverTrigger } from "@/ui/ArtistHover";
import { BasketAddButton } from "@/ui/BasketAddButton";
import { DownloadMenu, downloadArtwork, useDownloadPop } from "@/ui/DownloadMenu";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="album-field">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}

function TextCol({ title, text }: { title: string; text: string }) {
  return (
    <section className="album-col">
      <div className="k">{title}</div>
      <pre>{text || "—"}</pre>
    </section>
  );
}

/** 右侧参数：字段一栏、提示词左右分栏，不使用图库的图片详情。 */
export function AlbumParams({
  item,
  onGenerate,
  onDelete,
}: {
  item: Artwork | null;
  onGenerate: () => void;
  onDelete: () => void;
}) {
  const p = asMeta(item?.params);
  const download = useDownloadPop();
  useEffect(() => {
    download.close();
  }, [item?.id, download.close]);
  const size = p.width && p.height ? `${p.width} × ${p.height}` : item?.width && item?.height ? `${item.width} × ${item.height}` : "—";
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
    <aside className="album-side">
      <div className="album-side-head">
        <span className="pane-title">参数</span>
        <button className="icon-btn" type="button" title="复制画师串" aria-label="复制画师串" disabled={!item} onClick={() => void copyArtists()}>
          <IconCopy />
        </button>
      </div>
      <div className="album-side-body">
        {!item ? (
          <p className="album-side-empty">还没有选中的图片</p>
        ) : (
          <>
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
            <div className="album-fields">
              <Field label="文件" value={item.name || "—"} />
              <Field label="模型" value={p.model || "—"} />
              <Field label="分辨率" value={size} />
              <Field label="步数" value={p.steps != null ? String(p.steps) : "—"} />
              <Field label="Sampler" value={p.sampler || "—"} />
              <Field label="CFG" value={p.scale != null ? String(p.scale) : "—"} />
              <Field label="Seed" value={p.seed != null ? String(p.seed) : "—"} />
              <Field label="噪声" value={p.noiseSchedule || "—"} />
              <Field label="来源" value={p.software || "—"} />
              <Field label="解析" value={sourceLabel(p.source)} />
            </div>
            <div className="album-cols">
              <TextCol title="Prompt" text={promptText(item)} />
              <TextCol title="Negative" text={negativeText(item)} />
            </div>
            {chars.length > 0 && (
              <div className="album-cols">
                {chars.map((c, i) => {
                  const center = c.centers?.[0];
                  const pos = center ? ` (${Number(center.x).toFixed(2)}, ${Number(center.y).toFixed(2)})` : "";
                  return <TextCol key={i} title={`角色 ${i + 1}${pos}`} text={c.char_caption || ""} />;
                })}
              </div>
            )}
          </>
        )}
      </div>
      <div className="album-side-foot">
        <button className="btn" type="button" disabled={!item?.imageUrl} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => item && download.toggle(e.currentTarget)}>
          <IconDownload />
          下载
        </button>
        <button className="btn" type="button" disabled={!item} onClick={() => void copyPrompt()}>
          复制 Prompt
        </button>
        <button className="btn btn-primary" type="button" disabled={!item} onClick={onGenerate}>
          用此参数生图
        </button>
        <button className="btn btn-danger" type="button" disabled={!item} onClick={onDelete}>
          删除
        </button>
        <DownloadMenu open={download.open} left={download.pos.left} top={download.pos.top} onClose={download.close} onPick={(kind) => item && void downloadArtwork(item, kind)} />
      </div>
    </aside>
  );
}
