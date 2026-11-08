import { useEffect, useRef } from "react";
import type { Artwork } from "@/data/types";

function isLandscape(width?: number | null, height?: number | null) {
  return Boolean(width && height && width > height);
}

export function AlbumRail({
  name,
  items,
  currentId,
  onSelect,
  empty,
}: {
  name: string;
  items: Artwork[];
  currentId: string | null;
  onSelect: (id: string) => void;
  empty: string | null;
}) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    root.current?.querySelector(".thumb.on")?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  return (
    <aside className="hist" ref={root}>
      <div className="hist-head">
        <span className="name">{name}</span>
        <span className="hist-n">{items.length}</span>
      </div>
      <div className="hist-grid">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            className={`thumb${it.id === currentId ? " on" : ""}`}
            title={it.name || "图片"}
            onClick={() => onSelect(it.id)}
          >
            <span className={`thumb-frame${isLandscape(it.width, it.height) ? " land" : ""}`}>
              <img src={it.thumbUrl || it.imageUrl} alt="" loading="lazy" decoding="async" draggable={false} />
            </span>
          </button>
        ))}
        {!items.length && empty ? <p className="album-rail-empty">{empty}</p> : null}
      </div>
    </aside>
  );
}
