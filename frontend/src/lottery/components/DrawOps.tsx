import { jobProgressText } from "@/data";
import type { DrawBatch, DrawResult, Job } from "@/data/types";
import { useLottery } from "@/state";

export function DrawOps({
  batch,
  index,
  draw,
  job,
  busy,
  hasShots,
}: {
  batch: DrawBatch;
  index: number;
  draw: DrawResult;
  job?: Job | null;
  busy: boolean;
  hasShots: boolean;
}) {
  const { copyDraw, generateOne, removeDraw, editDraw } = useLottery();
  const genLabel = busy ? jobProgressText(job) || "排队中" : hasShots ? "重绘" : "生图";
  return (
    <span className="draw-ops">
      <button className="mini" type="button" onClick={() => void copyDraw(draw)}>
        复制
      </button>
      <button className="mini" type="button" onClick={() => editDraw(draw, job)}>
        编辑
      </button>
      <button className="mini mini-accent" type="button" disabled={busy} onClick={() => void generateOne(batch, draw, index)}>
        {genLabel}
      </button>
      <button className="mini mini-danger" type="button" title="删除这条" onClick={() => void removeDraw(batch, draw, index)}>
        删除
      </button>
    </span>
  );
}
