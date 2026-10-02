import { useEffect, useLayoutEffect, useRef } from "react";
import { generationApi } from "@/api";
import { isSingleArtistAlbum, jobIsActive, jobProgressText, queryKeys } from "@/data";
import { closeStudioMenus, pushToast, useJobsQuery, useSession, useSettings, useStudioStore } from "@/state";
import { useQueryClient } from "@tanstack/react-query";
import type { Album, Job } from "@/data/types";

function jobTitle(job: Job) {
  if (job.source === "lottery") {
    const n = job.client?.batchN;
    const i = Number(job.client?.drawIndex);
    if (n && Number.isFinite(i) && i >= 0) return `抽奖 第${n}批 · ${i + 1}`;
    return "抽奖生图";
  }
  if (job.source === "gallery") {
    const artist = String(job.client?.artist || "").trim();
    return artist ? `图库测试生图 · ${artist}` : "图库测试生图";
  }
  return "生图室";
}

export function JobsDock() {
  const qc = useQueryClient();
  const jobsQ = useJobsQuery();
  const setView = useSession((s) => s.setView);
  const jobsOpen = useStudioStore((s) => s.jobsOpen);
  const setJobsOpen = useStudioStore((s) => s.setJobsOpen);
  const jobs = jobsQ.data || [];
  const active = jobs.filter((j) => jobIsActive(j));
  const rows = active.length ? active : jobs.slice(-6).reverse();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const autoOpen = useSettings((s) => s.generation.autoOpenJobs);
  const hadActive = useRef(false);

  // 「有新任务时自动展开后台面板」：从没有进行中的任务变成有时展开一次
  useEffect(() => {
    const has = active.length > 0;
    if (has && !hadActive.current && autoOpen) setJobsOpen(true);
    hadActive.current = has;
  }, [active.length, autoOpen, setJobsOpen]);

  useLayoutEffect(() => {
    if (!jobsOpen || !btnRef.current || !popRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    popRef.current.style.left = `${Math.round(r.right + 8)}px`;
    popRef.current.style.bottom = `${Math.round(window.innerHeight - r.bottom)}px`;
    popRef.current.style.top = "auto";
  }, [jobsOpen, rows.length]);

  const run = active.find((job) => job.status === "running");
  const title = run ? `后台生图 · ${jobProgressText(run)}` : active.length ? `后台排队 ${active.length}` : "后台生图";

  return (
    <div className="act-jobs" id="act-jobs" hidden={active.length === 0}>
      <button
        className="act-jobs-btn"
        id="act-jobs-btn"
        ref={btnRef}
        type="button"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          closeStudioMenus("jobs");
          setJobsOpen(!jobsOpen);
        }}
      >
        <span className="act-jobs-dot" aria-hidden="true" />
        <span id="act-jobs-count">{active.length}</span>
        <span>后台</span>
      </button>
      <div className={`pop-panel jobs-pop${jobsOpen ? " open" : ""}`} id="act-jobs-pop" ref={popRef} onClick={(e) => e.stopPropagation()}>
        <div className="pop-h">后台生图</div>
        <div className="jobs-pop-list" id="act-jobs-list">
          {!rows.length && <p className="jobs-pop-empty">没有后台任务</p>}
          {rows.map((job) => (
            <div className="job-row" key={job.id} data-id={job.id}>
              <button
                type="button"
                onClick={() => {
                  setJobsOpen(false);
                  if (job.source === "gallery") {
                    setView("gallery");
                    const setId = String(job.client?.testSetId || "");
                    if (setId) {
                      // 测试集属于「单画师」收藏夹，先切过去再选测试集。
                      const albums = (qc.getQueryData(queryKeys.albums) as Album[] | undefined) || [];
                      const single = albums.find((a) => isSingleArtistAlbum(a));
                      if (single) useSession.getState().setAlbumId(single.id);
                      useSession.getState().setTestSetId(setId);
                    }
                    return;
                  }
                  setView(job.source === "lottery" ? "lottery" : "studio");
                }}
              >
                <span className="ttl">{jobTitle(job)}</span>
                <span className="sub">{job.status === "done" ? "完成" : job.status === "error" ? job.error || "失败" : jobProgressText(job)}</span>
              </button>
              {jobIsActive(job) && (
                <button
                  type="button"
                  className="x"
                  title="取消"
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await generationApi.cancelJob(job.id);
                      await qc.invalidateQueries({ queryKey: queryKeys.jobs });
                    } catch (err) {
                      pushToast(err instanceof Error ? err.message : "无法取消", "warn");
                    }
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
