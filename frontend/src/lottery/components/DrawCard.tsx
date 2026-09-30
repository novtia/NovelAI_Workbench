import { useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { chainText, drawIdOf, drawSum, matchDrawJob, queryKeys, resolveDrawVisual, sortedDrawRows, splitArtistTokens } from "@/data";
import type { DrawBatch, DrawResult as DrawResultType, Job, LotShot } from "@/data/types";
import { useLotteryStore } from "@/state";
import { ArtistHoverTrigger } from "@/ui/ArtistHover";
import { DrawOps } from "./DrawOps";
import { DrawResult } from "./DrawResult";
import { WeightBar } from "./WeightBar";

const EMPTY_JOBS: Job[] = [];

function useDrawJob(batchId: string, drawId: string) {
  const qc = useQueryClient();
  return useSyncExternalStore(
    (onChange) => qc.getQueryCache().subscribe(onChange),
    () => matchDrawJob((qc.getQueryData(queryKeys.jobs) as Job[] | undefined) || EMPTY_JOBS, batchId, drawId) || null,
  );
}

export function DrawCard({ batch, index, draw }: { batch: DrawBatch; index: number; draw: DrawResultType }) {
  const enqueuing = useLotteryStore((s) => s.enqueuing);
  const savedShots = useLotteryStore((s) => s.savedShots);
  const drawId = drawIdOf(batch.id, draw, index);
  const jobHit = useDrawJob(batch.id, drawId);
  const resolved = resolveDrawVisual(jobHit ? [jobHit] : [], batch.id, drawId, draw);
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
      <code>
        {splitArtistTokens(chainText(draw.outputText)).map((part, i) =>
          part.type === "artist" && part.name ? (
            <ArtistHoverTrigger key={`${part.name}-${i}`} name={part.name}>
              {part.value}
            </ArtistHoverTrigger>
          ) : (
            <span key={i}>{part.value}</span>
          ),
        )}
      </code>
      <WeightBar draw={draw} />
      <DrawResult batchId={batch.id} drawId={drawId} job={job} shots={shots} busy={busy} />
    </div>
  );
}
