import { Check, CopyPlus } from "lucide-react";
import { previewUrl } from "@/data";
import type { LotShot } from "@/data/types";
import { useLottery } from "@/state";

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
  const hash = item.blobHash || item.id || "";
  const saved = Boolean(item.savedId || item.albumId || (hash && savedShots[hash]));

  return (
    <div className="draw-shot">
      <a href={url || thumb} target="_blank" rel="noopener noreferrer" title={saved ? "点击查看原图" : "点击查看原图（未入库）"}>
        <img src={thumb || url} alt="" loading="lazy" decoding="async" />
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
        {saved ? <Check strokeWidth={1.8} /> : <CopyPlus strokeWidth={1.8} />}
      </button>
    </div>
  );
}
