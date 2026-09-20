import { useEffect, useLayoutEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { placeLotPop } from "@/data";
import { useLottery } from "@/state";

export function AlbumSavePop() {
  const { lotSave, albums, albumId, closeLotSave, savePreviewTo, createAlbumForSave, moveLotSave } = useLottery();
  const ref = useRef<HTMLDivElement>(null);
  const open = Boolean(lotSave);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest("#lot-album-pop, .draw-save")) return;
      closeLotSave();
    }
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open, closeLotSave]);

  useLayoutEffect(() => {
    if (!open || !ref.current || !lotSave?.trigger) return;
    function place() {
      const pop = ref.current;
      const trigger = lotSave?.trigger;
      if (!pop || !trigger) return;
      const { left, top } = placeLotPop(pop.offsetWidth, pop.offsetHeight, trigger);
      moveLotSave(left, top);
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, lotSave?.trigger, lotSave?.batchId, lotSave?.drawId, lotSave?.shotIndex, albums.length, moveLotSave]);

  return (
    <div
      className={`pop-panel album-pop${open ? " open" : ""}`}
      id="lot-album-pop"
      ref={ref}
      style={open ? { left: lotSave?.left, top: lotSave?.top } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="pop-h">保存到收藏夹</div>
      <div className="album-pop-list" id="lot-album-pop-list">
        {albums.map((a) => (
          <button key={a.id} type="button" className={a.id === albumId ? "on" : ""} onClick={() => void savePreviewTo(a.id)}>
            <span className="name">{a.name}</span>
            <span className="n">{a.count ?? 0}</span>
          </button>
        ))}
      </div>
      <button type="button" className="album-pop-new" id="lot-album-pop-new" onClick={createAlbumForSave}>
        <Plus strokeWidth={1.8} />
        新建收藏夹
      </button>
    </div>
  );
}
