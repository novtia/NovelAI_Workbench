import { memo, type MouseEvent } from "react";
import { asMeta } from "@/data";
import type { Artwork } from "@/data/types";
import { useBasketActions, useBasketHas, useCommands, useSession } from "@/state";
import { IconCopy, IconDownload, IconReset, IconSparkles } from "@/generation/components/icons";
import { DownloadMenu, downloadArtwork, useDownloadPop } from "@/ui/DownloadMenu";
import { SwapImage } from "./SwapImage";

export const ArtworkCard = memo(function ArtworkCard({
  item,
  index,
  enter = true,
  onRedraw,
  picked = false,
  onPick,
  onContext,
}: {
  item: Artwork;
  index: number;
  enter?: boolean;
  /** 只有测试集里的皮肤图才有：用测试集预设重新生成这位画师的图并替换。 */
  onRedraw?: (item: Artwork) => void;
  /** 多选里选中了这张。 */
  picked?: boolean;
  onPick?: (item: Artwork, e: MouseEvent<HTMLElement>) => void;
  onContext?: (e: MouseEvent<HTMLElement>) => void;
}) {
  const selected = useSession((s) => s.openId === item.id);
  const { openItemById, copyArtists, generateFrom } = useCommands();
  const hasArtists = (item.artists || []).length > 0;
  const inBasket = useBasketHas(item.artists);
  const { toggle: toggleBasket } = useBasketActions();
  const unknown = asMeta(item.params).source === "none";
  const shown = (item.artists || []).slice(0, 3);
  const download = useDownloadPop();

  return (
    <div
      className={`card${unknown ? " unknown" : ""}${selected ? " sel" : ""}${picked ? " picked" : ""}${enter ? "" : " no-enter"}`}
      style={enter ? { animationDelay: `${Math.min(index, 12) * 30}ms` } : undefined}
      data-id={item.id}
      role="button"
      tabIndex={0}
      onClick={(e) => (onPick ? onPick(item, e) : openItemById(item.id))}
      onContextMenu={onContext}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openItemById(item.id);
        }
      }}
    >
      <div className="thumb-wrap" style={item.width && item.height ? { aspectRatio: `${item.width} / ${item.height}` } : undefined}>
        {picked && !selected && <span className="g-check" />}
        <SwapImage
          src={item.thumbUrl}
          alt={item.artistLine || item.name}
          width={item.width || undefined}
          height={item.height || undefined}
        />
        {unknown && <span className="badge">无参数</span>}
        <div className="veil">
          <div className="qa">
            <button
              type="button"
              title="复制画师串"
              onClick={(e) => {
                e.stopPropagation();
                void copyArtists(item);
              }}
            >
              <IconCopy />
              复制串
            </button>
            {hasArtists && (
              <button
                type="button"
                className={inBasket ? "in-basket" : undefined}
                title={inBasket ? "已在画师串里，再点一次移出" : "把这张图的画师加入画师串"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleBasket(item.artists);
                }}
              >
                {inBasket ? "已加入" : "加入串"}
              </button>
            )}
            <button
              type="button"
              title="用此参数生图"
              onClick={(e) => {
                e.stopPropagation();
                generateFrom(item);
              }}
            >
              <IconSparkles />
              生图
            </button>
            {onRedraw && (
              <button
                type="button"
                title="用测试集的预设重新生成这位画师的图，完成后替换这张"
                onClick={(e) => {
                  e.stopPropagation();
                  onRedraw(item);
                }}
              >
                <IconReset />
                重绘
              </button>
            )}
            <button
              type="button"
              title="下载"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                download.toggle(e.currentTarget);
              }}
            >
              <IconDownload />
              下载
            </button>
          </div>
        </div>
        <DownloadMenu
          open={download.open}
          left={download.pos.left}
          top={download.pos.top}
          onClose={download.close}
          onPick={(kind) => void downloadArtwork(item, kind)}
        />
      </div>
      <div className="artists" title={item.artistLine || ""}>
        {shown.length ? (
          <>
            {shown.map((name) => (
              <span key={name}>{`artist:${name}`}</span>
            ))}
            {item.artists.length > shown.length && (
              <span className="none">+{item.artists.length - shown.length}</span>
            )}
          </>
        ) : (
          <span className="none">未识别画师</span>
        )}
      </div>
    </div>
  );
});
