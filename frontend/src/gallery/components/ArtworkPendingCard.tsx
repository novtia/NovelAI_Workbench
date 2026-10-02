import type { CSSProperties } from "react";
import { jobProgressText, liveSrc, previewUrl } from "@/data";
import type { TestCard } from "@/data/testRun";
import { DrawLiveShot } from "@/lottery/components/DrawLiveShot";

const STATE_TEXT: Record<TestCard["state"], string> = {
  done: "完成",
  running: "生成中",
  queued: "排队中",
  error: "失败",
  cancelled: "未生成",
};

function aspectOf(card: TestCard, fallback?: { width?: number; height?: number } | null) {
  const form = (card.job?.client?.form || {}) as { width?: number; height?: number };
  const w = Number(form.width || fallback?.width || 832);
  const h = Number(form.height || fallback?.height || 1216);
  return w > 0 && h > 0 ? `${w} / ${h}` : "832 / 1216";
}

/** 测试集生图中尚未出最终图的位置：排队占位 / 流式预览 / 失败提示。 */
export function ArtworkPendingCard({
  card,
  index,
  fallbackSize,
}: {
  card: TestCard;
  index: number;
  fallbackSize?: { width?: number; height?: number } | null;
}) {
  const job = card.job;
  const active = card.state === "running" || card.state === "queued";
  const live = active ? liveSrc(job?.previewUrl) : "";
  const finalSrc = card.state === "running" && job?.status === "done" ? previewUrl(job.items?.[0]) : "";
  const src = live || finalSrc;
  const text = card.state === "error" ? job?.error || STATE_TEXT.error : job && active ? jobProgressText(job) : STATE_TEXT[card.state];
  const steps = Number(job?.progress?.steps) || 0;
  const step = Number(job?.progress?.step);
  const p = job?.status === "done" ? 0 : steps > 0 && Number.isFinite(step) ? Math.min(1, Math.max(0, 1 - step / steps)) : 1;
  const name = card.target?.name || "";

  return (
    <div
      className={`card pending no-enter is-${card.state}`}
      style={{ "--p": p } as CSSProperties}
      data-index={card.target?.index}
    >
      <div className="thumb-wrap" style={{ aspectRatio: aspectOf(card, fallbackSize) }}>
        {src ? (
          <DrawLiveShot src={src} waiting={!live && !finalSrc} text={text} />
        ) : (
          <div className="pending-ph">
            <span>{text}</span>
          </div>
        )}
      </div>
      <div className="artists" title={card.target?.artistLine || ""}>
        {name ? <span>{`artist:${name}`}</span> : <span className="none">未识别画师</span>}
      </div>
    </div>
  );
}
