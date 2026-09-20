import { jobProgressText, liveSrc, previewUrl } from "@/data";
import type { Job, LotShot } from "@/data/types";
import { DrawLiveShot } from "./DrawLiveShot";
import { DrawShot } from "./DrawShot";

export function DrawResult({
  batchId,
  drawId,
  job,
  shots,
  busy,
}: {
  batchId: string;
  drawId: string;
  job?: Job | null;
  shots: LotShot[];
  busy?: boolean;
}) {
  const live = liveSrc(job?.previewUrl);
  const placeholder = shots[0] ? previewUrl(shots[0]) : "";
  const text = jobProgressText(job) || "排队中";

  if (busy) {
    const src = live || placeholder;
    return (
      <div className="draw-result">
        {src ? <DrawLiveShot src={src} waiting={!live} text={text} /> : <div className="draw-job">{text}</div>}
      </div>
    );
  }

  if (!shots.length) return null;

  return (
    <div className="draw-result">
      {shots.map((it, shotIndex) => (
        <DrawShot key={it.blobHash || it.id || shotIndex} batchId={batchId} drawId={drawId} shotIndex={shotIndex} item={it} />
      ))}
    </div>
  );
}
