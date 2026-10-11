import { useState } from "react";
import { historyCards, previewUrl, writeStudioShotDrag } from "@/data";
import type { StudioShot } from "@/data/types";
import { pushToast, useStudioActions, useStudioStore } from "@/state";
import { IconHistPlay, IconTrash } from "./icons";

function isLandscape(width?: number | null, height?: number | null) {
  return Boolean(width && height && width > height);
}

function HistoryThumb({ item, on, badge, src, onShow }: { item: StudioShot; on: boolean; badge: string; src: string; onShow: (item: StudioShot) => void }) {
  const [land, setLand] = useState(() => isLandscape(item.width, item.height));

  return (
    <button
      type="button"
      className={`thumb${on ? " on" : ""}`}
      title={item.name || "生成结果"}
      draggable={!item.pending || Boolean(item.url || item.thumbUrl)}
      onClick={() => onShow(item)}
      onDragStart={(e) => {
        if (!e.dataTransfer) return;
        writeStudioShotDrag(e.dataTransfer, {
          id: item.id,
          blobHash: item.blobHash,
          url: item.url || previewUrl(item),
          name: item.name,
        });
      }}
    >
      <span className={`thumb-frame${land ? " land" : ""}`}>
        {item.pending && !(item.thumbUrl || item.url) ? (
          <span className="thumb-spin" aria-label="生成中">
            <i />
          </span>
        ) : (
          <img
            src={src || item.thumbUrl || previewUrl(item)}
            alt=""
            width={item.width || undefined}
            height={item.height || undefined}
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth && img.naturalHeight) setLand(img.naturalWidth > img.naturalHeight);
            }}
          />
        )}
        {badge ? <span className="thumb-x">{badge}</span> : null}
      </span>
    </button>
  );
}

export function HistoryRail() {
  const session = useStudioStore((s) => s.session);
  const currentId = useStudioStore((s) => s.currentId);
  const { showShot, clearSession } = useStudioActions();
  const current = session.find((x) => x.id === currentId) || null;
  const cards = historyCards(session);
  return (
    <aside className="hist">
      <div className="hist-head">
        历史
        <IconHistPlay />
        <span className="hist-n">{cards.length}</span>
      </div>
      <div className="hist-grid">
        {cards.map((card) => {
          const inCard = card.badge ? session.some((s) => s.jobId === card.key && s.id === currentId) : current?.id === card.item.id;
          return (
            <HistoryThumb
              key={card.key}
              item={card.item}
              badge={card.badge}
              src={card.src}
              on={inCard}
              onShow={(item) => showShot(session.find((s) => s.jobId === card.key && s.id === currentId) || item)}
            />
          );
        })}
      </div>
      <div className="hist-foot">
        <button
          className="ico danger"
          type="button"
          title="清空本次会话"
          onClick={() => {
            clearSession();
            pushToast("已清空会话历史");
          }}
        >
          <IconTrash />
        </button>
      </div>
    </aside>
  );
}
