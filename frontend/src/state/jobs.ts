import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectJobStream } from "@/api";
import { applyJobToBatches, queryKeys } from "@/data";
import type { DrawBatch, Job } from "@/data/types";

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
      }
    });
  }, [qc]);
}
