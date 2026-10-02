import { lazy, Suspense, useEffect, useRef, useSyncExternalStore } from "react";
import { JobsDock, QuotaBattery } from "../generation";
import { getToasts, subscribeToasts, useBasketQuery, useJobsQuery, useSession, useSettings } from "@/state";
import { jobIsActive } from "@/data";
import { WorkbenchHosts } from "./hosts";
import { bindInkDrop, installInkTextures, paintBackdrop } from "@/ui/inkBackdrop";
import { bindInkFluid } from "@/ui/inkFluid";

const GalleryView = lazy(() => import("../gallery").then((m) => ({ default: m.GalleryView })));
const LotteryView = lazy(() => import("../lottery").then((m) => ({ default: m.LotteryView })));
const StudioView = lazy(() => import("../generation/StudioView").then((m) => ({ default: m.StudioView })));
const SettingsView = lazy(() => import("../settings/SettingsView").then((m) => ({ default: m.SettingsView })));

const VIEWS = [
  { id: "gallery" as const, label: "图库", title: "图库", glyph: "藏" },
  { id: "lottery" as const, label: "抽奖", title: "抽奖台", glyph: "签" },
  { id: "studio" as const, label: "生图", title: "生图室", glyph: "绘" },
];

export function Workbench() {
  const view = useSession((s) => s.view);
  const setView = useSession((s) => s.setView);
  const basketOpen = useSession((s) => s.basketOpen);
  const toggleBasket = useSession((s) => s.toggleBasket);
  const basketCount = useBasketQuery((l) => l.length).data ?? 0;
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const jobsQ = useJobsQuery();
  const active = (jobsQ.data || []).filter((j) => jobIsActive(j));

  const wantLiveInk = useSettings((s) => s.appearance.liveInk && !s.appearance.reduceMotion);
  const showBattery = useSettings((s) => s.account.showBattery);

  const liveRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    document.documentElement.dataset.view = view;
  }, [view]);

  useEffect(() => {
    installInkTextures();
    void paintBackdrop();
    return bindInkDrop();
  }, []);

  useEffect(() => {
    if (!wantLiveInk) return;
    const offLive = liveRef.current ? bindInkFluid(liveRef.current) : null;
    // 活墨可用时，静态泼墨层不再显示（它只是兜底）
    document.documentElement.classList.toggle("ink-gl", Boolean(offLive));
    return () => {
      document.documentElement.classList.remove("ink-gl");
      offLive?.();
    };
  }, [wantLiveInk]);

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
      <div className="bg-ink" id="bg-ink-b" />
      <canvas className="bg-ink-live" ref={liveRef} aria-hidden="true" />
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
            <button
              className={`act-btn${basketOpen ? " active" : ""}`}
              type="button"
              title="画师串（收集画师，一键复制）"
              data-panel="basket"
              aria-pressed={basketOpen}
              onClick={toggleBasket}
            >
              <span className="glyph">串</span>
              <span className="lab">画师串</span>
              {basketCount ? <span className="act-badge">{basketCount > 99 ? "99+" : basketCount}</span> : null}
            </button>
            <JobsDock />
            {showBattery ? <QuotaBattery /> : null}
            <button
              className={`act-btn${view === "settings" ? " active" : ""}`}
              type="button"
              title="设置"
              data-view="settings"
              aria-current={view === "settings" ? "page" : undefined}
              onClick={() => setView("settings")}
            >
              <span className="glyph">设</span>
              <span className="lab">设置</span>
            </button>
          </div>
        </nav>
        <main className="views">
          <Suspense fallback={null}>
            {view === "gallery" ? <GalleryView /> : null}
            {view === "lottery" ? <LotteryView /> : null}
            {view === "studio" ? <StudioView /> : null}
            {view === "settings" ? <SettingsView /> : null}
          </Suspense>
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
