import { useEffect } from "react";
import { PANEL, clampPanel } from "@/data/studio";
import { closeStudioMenus, useSession, useStudio } from "@/state";
import { CharacterList } from "../components/CharacterList";
import { GenderPop } from "../components/GenderPop";
import { HistoryRail } from "../components/HistoryRail";
import { I2iSection } from "../components/I2iSection";
import { ImageSettings } from "../components/ImageSettings";
import { ModelRow } from "../components/ModelRow";
import { ParamDock } from "../components/ParamDock";
import { ParamSetPop } from "../components/ParamSetPop";
import { PromptCard } from "../components/PromptCard";
import { SamplerPop } from "../components/SamplerPop";
import { SplitHandle } from "../components/SplitHandle";
import { StudioAlbumPop } from "../components/StudioAlbumPop";
import { DownloadPop } from "../components/DownloadPop";
import { StudioHeader } from "../components/StudioHeader";
import { StudioStage } from "../components/StudioStage";
import { TokenPop } from "../components/TokenPop";

export function StudioSkeleton() {
  const view = useSession((s) => s.view);
  const { leftW, histW, setLeftW, setHistW, pop } = useStudio();

  useEffect(() => {
    function clamp() {
      const root = document.getElementById("view-studio");
      const w = root?.clientWidth || Math.max(0, window.innerWidth - 64);
      const s = { leftW, histW };
      const maxLeft = Math.min(PANEL.leftMax, w - s.histW - PANEL.split - PANEL.centerMin);
      const maxHist = Math.min(PANEL.histMax, w - s.leftW - PANEL.split - PANEL.centerMin);
      setLeftW(clampPanel(s.leftW, PANEL.leftMin, maxLeft));
      setHistW(clampPanel(s.histW, PANEL.histMin, maxHist));
    }
    function onDoc(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t?.closest(
          ".dd, .pop-panel, [data-toggle], #sampler-label, #ai-sampler, .gender, #char-add, #st-account, #st-menu, #st-quota-detail, #btn-save-gallery, #btn-download, #st-param-set-btn, #act-battery, #act-quota-pop, #act-jobs, #act-jobs-pop",
        )
      ) {
        return;
      }
      closeStudioMenus();
    }
    window.addEventListener("resize", clamp);
    document.addEventListener("click", onDoc);
    if (view === "studio") clamp();
    return () => {
      window.removeEventListener("resize", clamp);
      document.removeEventListener("click", onDoc);
    };
  }, [view, leftW, histW, setLeftW, setHistW, pop]);

  return (
    <section
      className={`view${view === "studio" ? " active" : ""}`}
      id="view-studio"
      style={{ ["--st-left-w" as string]: `${leftW}px`, ["--st-hist-w" as string]: `${histW}px` }}
    >
      <div className="st-app">
        <aside className="left">
          <StudioHeader />
          <div className="left-scroll">
            <ModelRow />
            <PromptCard />
            <CharacterList />
            <I2iSection />
            <ImageSettings />
          </div>
          <ParamDock />
        </aside>
        <SplitHandle side="left" />
        <StudioStage />
        <SplitHandle side="hist" />
        <HistoryRail />
      </div>
      <TokenPop />
      <SamplerPop />
      <GenderPop />
      <StudioAlbumPop />
      <DownloadPop />
      <ParamSetPop />
    </section>
  );
}
