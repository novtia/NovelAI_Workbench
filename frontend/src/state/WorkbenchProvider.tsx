import { useEffect, type ReactNode } from "react";
import { useImportGestures } from "./gestures";
import { useGallerySelectionSync } from "./gallerySelection";
import { useJobStream } from "./jobs";
import { useJobsQuery } from "./queries";
import { jobIsActive } from "@/data";
import { useLotterySync } from "./lottery";
import { useSession } from "./session";
import { useStudioSync } from "./studio";
import { getSettings, useSettingsStore } from "./settingsStore";
import { useStudioStore } from "./studioStore";
import { pushToast } from "./toast";

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  useImportGestures();
  useGallerySelectionSync();
  useJobStream();
  useLotterySync();
  useStudioSync();
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const saveError = useSettingsStore((s) => s.saveError);
  useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);
  const settingsReady = useSettingsStore((s) => s.ready);
  useEffect(() => {
    // 远端设置到达后，把持久化的面板宽度同步进工作台
    if (!settingsReady) return;
    const { layout } = getSettings();
    if (!layout.rememberWidths) return;
    const st = useStudioStore.getState();
    if (st.leftW !== layout.leftWidth) st.setLeftW(layout.leftWidth);
    if (st.histW !== layout.histWidth) st.setHistW(layout.histWidth);
  }, [settingsReady]);
  useEffect(() => {
    if (saveError) pushToast(`设置未能保存：${saveError}`, "error");
  }, [saveError]);
  const jobs = useJobsQuery().data;
  const keep = Boolean(jobs?.some((job) => jobIsActive(job)));
  useEffect(() => {
    if (!keep || !navigator.locks) return;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    void navigator.locks.request("workbench-keep", { mode: "shared" }, () => held);
    return () => release?.();
  }, [keep]);
  useEffect(() => {
    const onHash = () => {
      const raw = location.hash.replace("#", "");
      if (raw === "lottery" || raw === "studio" || raw === "gallery" || raw === "settings") {
        useSession.setState({ view: raw });
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return children;
}
