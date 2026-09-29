import { useEffect, useSyncExternalStore } from "react";
import { GalleryView } from "../gallery";
import { LotteryView } from "../lottery";
import { JobsDock, QuotaBattery, StudioView } from "../generation";
import { getToasts, subscribeToasts, useJobsQuery, useSession } from "@/state";
import { jobIsActive } from "@/data";
import { WorkbenchHosts } from "./hosts";
import { bindInkDrop, installInkTextures, paintBackdrop } from "@/ui/inkBackdrop";

const VIEWS = [
  { id: "gallery" as const, label: "图库", title: "图库", glyph: "藏" },
  { id: "lottery" as const, label: "抽奖", title: "抽奖台", glyph: "签" },
  { id: "studio" as const, label: "生图", title: "生图室", glyph: "绘" },
];

export function Workbench() {
  const view = useSession((s) => s.view);
  const setView = useSession((s) => s.setView);
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const jobsQ = useJobsQuery();
  const active = (jobsQ.data || []).filter((j) => jobIsActive(j));

  useEffect(() => {
    installInkTextures();
    void paintBackdrop();
    return bindInkDrop();
  }, []);

  return (
    <>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <filter id="rough" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency=".05" numOctaves="3" seed="7" />
          <feDisplacementMap in="SourceGraphic" scale="3.5" />
        </filter>
      </svg>
      <div className="bg-paper" />
      <div className="bg-ink" id="bg-ink" />
      <div className="bg-grain" />
      <div id="app" className="workbench">
        <nav className="activity" aria-label="视图切换">
          <span className="act-logo" aria-hidden="true">
            墨
          </span>
          {VIEWS.map((v) => {
            const source = v.id === "studio" ? "studio" : v.id === "lottery" ? "lottery" : "";
            const hasJob = Boolean(source && active.some((job) => job.source === source));
            return (
              <button
                key={v.id}
                className={`act-btn${view === v.id ? " active" : ""}${hasJob ? " has-job" : ""}`}
                type="button"
                title={v.title}
                data-view={v.id}
                onClick={() => setView(v.id)}
              >
                <span className="glyph">{v.glyph}</span>
                <span className="lab">{v.label}</span>
              </button>
            );
          })}
          <div className="act-foot">
            <JobsDock />
            <QuotaBattery />
          </div>
        </nav>
        <main className="views">
          <GalleryView />
          <LotteryView />
          <StudioView />
        </main>
        <WorkbenchHosts />
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
