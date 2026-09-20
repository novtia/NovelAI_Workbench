import { chainText, drawIdOf, drawSum, resolveDrawVisual, sortedDrawRows } from "@/data";
import type { DrawBatch, DrawResult as DrawResultType, LotShot } from "@/data/types";
import { useLottery } from "@/state";
import { DrawOps } from "./DrawOps";
import { DrawResult } from "./DrawResult";
import { WeightBar } from "./WeightBar";

export function DrawCard({ batch, index, draw }: { batch: DrawBatch; index: number; draw: DrawResultType }) {
  const { enqueuing, savedShots, jobs } = useLottery();
  const drawId = drawIdOf(batch.id, draw, index);
  const resolved = resolveDrawVisual(jobs, batch.id, drawId, draw);
  const job = resolved.job;
  const busy = Boolean(resolved.active) || enqueuing.includes(`${batch.id}:${drawId}`);
  const rows = sortedDrawRows(draw);
  const { sum } = drawSum(draw, rows);
  const shots: LotShot[] = (resolved.shots.length ? resolved.shots : job?.items || []).map((it) => ({
    ...it,
    savedId: savedShots[it.blobHash || ""]?.savedId,
    albumId: savedShots[it.blobHash || ""]?.albumId,
  }));

  return (
    <div className="draw-card" data-batch={batch.id} data-draw={drawId} data-i={index}>
      <div className="draw-top">
        <span className="idx">{String(index + 1).padStart(2, "0")}</span>
        <span className="draw-n">{rows.length || draw.artistCount || 0} 人</span>
        <span className="sum">Σ {sum}</span>
        <DrawOps batch={batch} index={index} draw={draw} job={job} busy={busy} hasShots={shots.length > 0} />
      </div>
      <code>{chainText(draw.outputText)}</code>
      <WeightBar draw={draw} />
      <DrawResult batchId={batch.id} drawId={drawId} job={job} shots={shots} busy={busy} />
    </div>
  );
}
