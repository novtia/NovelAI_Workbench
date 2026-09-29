import { previewUrl } from "@/data";
import type { LotShot } from "@/data/types";
import { useLottery } from "@/state";
import { IconCheck, IconCopyPlus } from "@/generation/components/icons";

export function DrawShot({
  batchId,
  drawId,
  shotIndex,
  item,
}: {
  batchId: string;
  drawId: string;
  shotIndex: number;
  item: LotShot;
}) {
  const { openSave, savedShots } = useLottery();
  const url = previewUrl(item);
  const thumb = item.thumbUrl || url;
  const src = url || thumb;
  const hash = item.blobHash || item.id || "";
  const saved = Boolean(item.savedId || item.albumId || (hash && savedShots[hash]));

  return (
    <div className="draw-shot">
      <a href={src} target="_blank" rel="noopener noreferrer" title={saved ? "点击查看原图" : "点击查看原图（未入库）"}>
        <img src={src} alt="" decoding="async" />
      </a>
      <button
        type="button"
        className={`draw-save${saved ? " is-saved" : ""}`}
        title={saved ? "已在图库" : "保存到图库"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (saved) return;
          openSave(e.currentTarget, { batchId, drawId, shotIndex, item });
        }}
      >
        {saved ? <IconCheck /> : <IconCopyPlus />}
      </button>
    </div>
  );
}
