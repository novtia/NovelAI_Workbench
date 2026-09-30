import { jobIsActive } from "@/data";
import type { DrawBatch } from "@/data/types";
import { useJobsQuery, useLotteryActions } from "@/state";

export function BatchHead({ batch }: { batch: DrawBatch }) {
  const { batchNumber, generateBatch, copyBatch, removeBatch, verify } = useLotteryActions();
  const lotteryJobs = (useJobsQuery().data || []).filter((j) => j.source === "lottery" && jobIsActive(j));
  const n = batchNumber(batch.id);
  const params = batch.params || {};
  const min = Number(params.nMin ?? params.n ?? "");
  const max = Number(params.nMax ?? params.n ?? "");
  const wMin = params.minWeight;
  const wMax = params.maxWeight;
  const running = lotteryJobs.filter((j) => String(j.client?.batchId || "") === batch.id && jobIsActive(j)).length;
  const range = Number.isFinite(min) && Number.isFinite(max) ? `${min}~${max} 人` : "";
  const weights = wMin != null && wMax != null ? ` · 权重 ${wMin}~${wMax}` : "";

  return (
    <div className="lot-batch-head">
      <h3>第 {n} 批</h3>
      <span className="n">
        {batch.draws.length} 条{range ? ` · ${range}` : ""}
        {weights}
      </span>
      <button className="btn btn-primary" type="button" onClick={() => void generateBatch(batch)}>
        {running ? `后台 ${running}` : "全部生图"}
      </button>
      <button className="mini" type="button" onClick={() => void copyBatch(batch, n)}>
        复制本批
      </button>
      <button className="mini" type="button" onClick={() => void verify(batch)}>
        校验
      </button>
      <button className="mini mini-danger" type="button" onClick={() => void removeBatch(batch, n)}>
        删除批次
      </button>
    </div>
  );
}
