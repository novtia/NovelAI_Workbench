import { Fragment, lazy, Suspense, useEffect, useRef, useSyncExternalStore, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { JobsDock, QuotaBattery } from "../generation";
import { getToasts, subscribeToasts, useBasketQuery, useJobsQuery, useSession, useSettings, useSettingsStore, useTabs } from "@/state";
import { jobIsActive } from "@/data";
import { WorkbenchHosts } from "./hosts";
import { TabBar } from "./TabBar";
import { bindInkDrop, installInkTextures, paintBackdrop } from "@/ui/inkBackdrop";
import { bindInkFluid } from "@/ui/inkFluid";
import { NAV_ICONS } from "@/ui/navIcons";
import { resolveTheme } from "@/ui/applySettings";
import { inkSwitchTheme, warmUpInkSwitch } from "@/ui/themeInk";

const GalleryView = lazy(() => import("../gallery").then((m) => ({ default: m.GalleryView })));
const LotteryView = lazy(() => import("../lottery").then((m) => ({ default: m.LotteryView })));
const StudioView = lazy(() => import("../generation/StudioView").then((m) => ({ default: m.StudioView })));
const SettingsView = lazy(() => import("../settings/SettingsView").then((m) => ({ default: m.SettingsView })));
const HistoryView = lazy(() => import("../history").then((m) => ({ default: m.HistoryView })));

const VIEWS = [
  { id: "gallery" as const, label: "图库", title: "图库", Icon: NAV_ICONS.gallery },
  { id: "lottery" as const, label: "抽奖", title: "抽奖台", Icon: NAV_ICONS.lottery },
  { id: "studio" as const, label: "生图", title: "生图室", Icon: NAV_ICONS.studio },
];

export function Workbench() {
  const view = useSession((s) => s.view);
  const activeTabId = useTabs((s) => s.activeId);
  const setView = useSession((s) => s.setView);
  const basketOpen = useSession((s) => s.basketOpen);
  const toggleBasket = useSession((s) => s.toggleBasket);
  const basketCount = useBasketQuery((l) => l.length).data ?? 0;
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const jobsQ = useJobsQuery();
  const active = (jobsQ.data || []).filter((j) => jobIsActive(j));

  const wantLiveInk = useSettings((s) => s.appearance.liveInk && !s.appearance.reduceMotion);
  const showBattery = useSettings((s) => s.account.showBattery);
  const themeMode = useSettings((s) => s.appearance.theme);
  const setSetting = useSettingsStore((s) => s.set);
  const isDark = resolveTheme(themeMode) === "dark";
  const ThemeIcon = isDark ? NAV_ICONS.themeToLight : NAV_ICONS.themeToDark;

  function toggleTheme(e: MouseEvent<HTMLButtonElement>) {
    inkSwitchTheme(e.currentTarget, (theme) => flushSync(() => setSetting("appearance", "theme", theme)));
  }

  const liveRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    document.documentElement.dataset.view = view;
    // 地址栏 hash 只表达激活标签的页面。
    if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  }, [view, activeTabId]);

  useEffect(() => {
    warmUpInkSwitch();
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
      <canvas className="bg-ink-live" ref={liveRef} aria-hidden="true" />      <div className="bg-grain" />
      <div id="app" className="workbench">
        <TabBar />
        <div className="wb-body">
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
                  <span className="glyph" aria-hidden="true">
                    <v.Icon />
                  </span>
                  <span className="lab">{v.label}</span>
                </button>
              );
            })}
            <span className="act-sep" role="separator" />
            <button
              className={`act-btn${view === "history" ? " active" : ""}`}
              type="button"
              title="历史记录"
              data-view="history"
              onClick={() => setView("history")}
            >
              <span className="glyph" aria-hidden="true">
                <NAV_ICONS.history />
              </span>
              <span className="lab">历史</span>
            </button>
            <div className="act-foot">
              <button
                className={`act-btn${basketOpen ? " active" : ""}`}
                type="button"
                title="画师串（收集画师，一键复制）"
                data-panel="basket"
                aria-pressed={basketOpen}
                onClick={toggleBasket}
              >
                <span className="glyph" aria-hidden="true">
                  <NAV_ICONS.basket />
                </span>
                <span className="lab">画师串</span>
                {basketCount ? <span className="act-badge">{basketCount > 99 ? "99+" : basketCount}</span> : null}
              </button>
              <JobsDock />
              {showBattery ? <QuotaBattery /> : null}
              <button
                className="act-btn act-theme"
                type="button"
                title={isDark ? "切换到浅色（宣纸）" : "切换到深色（墨夜）"}
                aria-label={isDark ? "切换到浅色模式" : "切换到深色模式"}
                onClick={toggleTheme}
              >
                <span className="glyph" aria-hidden="true">
                  <ThemeIcon />
                </span>
                <span className="lab">{isDark ? "浅色" : "深色"}</span>
              </button>
              <button
                className={`act-btn${view === "settings" ? " active" : ""}`}
                type="button"
                title="设置"
                data-view="settings"
                aria-current={view === "settings" ? "page" : undefined}
                onClick={() => setView("settings")}
              >
                <span className="glyph" aria-hidden="true">
                  <NAV_ICONS.settings />
                </span>
                <span className="lab">设置</span>
              </button>
            </div>
          </nav>
          <main className="views">
            {/* 只挂载激活标签；key 让切换标签时整页重新挂载，别的标签的 state 留在各自的 store 里 */}
            <Fragment key={activeTabId}>
              <Suspense fallback={null}>
                {view === "gallery" ? <GalleryView /> : null}
                {view === "lottery" ? <LotteryView /> : null}
                {view === "studio" ? <StudioView /> : null}
                {view === "history" ? <HistoryView /> : null}
                {view === "settings" ? <SettingsView /> : null}
              </Suspense>
            </Fragment>
          </main>
        </div>
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
