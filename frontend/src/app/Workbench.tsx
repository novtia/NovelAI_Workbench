import { useSyncExternalStore } from "react";
import { GalleryView } from "../gallery";
import { LotteryView } from "../lottery";
import { JobsDock, QuotaBattery, StudioView } from "../generation";
import { getToasts, subscribeToasts, useJobsQuery, useSession } from "@/state";
import { jobIsActive } from "@/data";
import { BrandLogo, IconGalleryNav, IconLotteryNav, IconStudioNav } from "./activityIcons";
import { WorkbenchHosts } from "./hosts";

const VIEWS = [
  { id: "gallery" as const, label: "图库", title: "图库", Icon: IconGalleryNav },
  { id: "lottery" as const, label: "抽奖", title: "抽奖台", Icon: IconLotteryNav },
  { id: "studio" as const, label: "生图", title: "生图室", Icon: IconStudioNav },
];

export function Workbench() {
  const view = useSession((s) => s.view);
  const setView = useSession((s) => s.setView);
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const jobsQ = useJobsQuery();
  const active = (jobsQ.data || []).filter((j) => jobIsActive(j));

  return (
    <div id="app" className="workbench">
      <nav className="activity" aria-label="视图切换">
        <span className="act-logo" aria-hidden="true">
          <BrandLogo />
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
              <v.Icon />
              <span>{v.label}</span>
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
  );
}
