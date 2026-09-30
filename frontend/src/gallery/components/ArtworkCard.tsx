import { memo } from "react";
import { asMeta } from "@/data";
import type { Artwork } from "@/data/types";
import { useBasketActions, useBasketHas, useCommands, useSession } from "@/state";
import { IconCopy, IconSparkles } from "@/generation/components/icons";

export const ArtworkCard = memo(function ArtworkCard({ item, index }: { item: Artwork; index: number }) {
  const selected = useSession((s) => s.openId === item.id);
  const { openItemById, copyArtists, generateFrom } = useCommands();
  const hasArtists = (item.artists || []).length > 0;
  const inBasket = useBasketHas(item.artists);
  const { toggle: toggleBasket } = useBasketActions();
  const unknown = asMeta(item.params).source === "none";
  const shown = (item.artists || []).slice(0, 3);

  return (
    <div
      className={`card${unknown ? " unknown" : ""}${selected ? " sel" : ""}`}
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      data-id={item.id}
      role="button"
      tabIndex={0}
      onClick={() => openItemById(item.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openItemById(item.id);
        }
      }}
    >
      <div className="thumb-wrap" style={item.width && item.height ? { aspectRatio: `${item.width} / ${item.height}` } : undefined}>
        <img
          src={item.thumbUrl}
          alt={item.artistLine || item.name}
          loading="lazy"
          decoding="async"
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
          </div>
        </div>
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
