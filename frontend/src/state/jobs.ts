import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { connectJobStream } from "@/api";
import { applyJobToBatches, queryKeys } from "@/data";
import type { DrawBatch, Job } from "@/data/types";

const refreshTimers = new Map<string, number>();

/** 连续完成多张图时合并刷新，避免每张都拉一次整个测试集。 */
function scheduleTestSetRefresh(qc: QueryClient, setId: string) {
  if (refreshTimers.has(setId)) return;
  const timer = window.setTimeout(() => {
    refreshTimers.delete(setId);
    void qc.invalidateQueries({ queryKey: queryKeys.items(setId) });
    void qc.invalidateQueries({ queryKey: queryKeys.albums });
  }, 250);
  refreshTimers.set(setId, timer);
}

export function useJobStream() {
  const qc = useQueryClient();
  useEffect(() => {
    return connectJobStream((payload) => {
      if (payload.type === "snapshot" && Array.isArray(payload.jobs)) {
        qc.setQueryData(queryKeys.jobs, payload.jobs as Job[]);
        return;
      }
      if (payload.type === "preview" && typeof payload.id === "string") {
        qc.setQueryData(queryKeys.jobs, (old: Job[] | undefined) =>
          (old || []).map((job) =>
            job.id === payload.id
              ? {
                  ...job,
                  previewUrl: typeof payload.url === "string" ? payload.url : job.previewUrl,
                  progress: {
                    ...job.progress,
                    step: typeof payload.step === "number" ? payload.step : job.progress?.step,
                    sample: typeof payload.sample === "number" ? payload.sample : job.progress?.sample,
                    text: typeof payload.text === "string" ? payload.text : job.progress?.text,
                  },
                }
              : job,
          ),
        );
        return;
      }
      if (payload.type === "job" && payload.job) {
        const next = payload.job as Job;
        qc.setQueryData(queryKeys.jobs, (old: Job[] | undefined) => {
          const list = old || [];
          const i = list.findIndex((j) => j.id === next.id);
          if (i >= 0) {
            const copy = list.slice();
            const prev = list[i];
            copy[i] = {
              ...prev,
              ...next,
              previewUrl: next.previewUrl || prev.previewUrl,
            };
            return copy;
          }
          return [next, ...list];
        });
        if (next.source === "lottery" && next.status === "done") {
          qc.setQueryData(queryKeys.lotteryBatches, (old: DrawBatch[] | undefined) => applyJobToBatches(old, next));
        }
        if (next.source === "gallery" && next.status === "done") {
          // 后端在任务完成前已把图绑进测试集，这里只需刷新显示。
          const setId = String(next.client?.testSetId || "");
          if (setId) scheduleTestSetRefresh(qc, setId);
        }
      }
    });
  }, [qc]);
}
