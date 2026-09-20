import { useStudio } from "@/state";
import { PANEL, clampPanel } from "@/data/studio";

export function SplitHandle({ side }: { side: "left" | "hist" }) {
  const { leftW, histW, setLeftW, setHistW } = useStudio();

  function studioW() {
    const root = document.getElementById("view-studio");
    return root?.clientWidth || Math.max(0, window.innerWidth - 64);
  }

  return (
    <div
      className="split"
      id={side === "left" ? "st-split-left" : "st-split-hist"}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "调整左侧栏宽度" : "调整历史栏宽度"}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const start = side === "left" ? leftW : histW;
        document.body.classList.add("is-resizing");
        e.currentTarget.classList.add("is-on");
        e.currentTarget.setPointerCapture(e.pointerId);
        const el = e.currentTarget;
        const move = (ev: PointerEvent) => {
          const maxLeft = Math.min(PANEL.leftMax, studioW() - histW - PANEL.split - PANEL.centerMin);
          const maxHist = Math.min(PANEL.histMax, studioW() - leftW - PANEL.split - PANEL.centerMin);
          if (side === "left") setLeftW(clampPanel(start + (ev.clientX - startX), PANEL.leftMin, maxLeft));
          else setHistW(clampPanel(start - (ev.clientX - startX), PANEL.histMin, maxHist));
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          document.body.classList.remove("is-resizing");
          el.classList.remove("is-on");
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
      onDoubleClick={() => {
        if (side === "left") setLeftW(PANEL.leftDef);
        else setHistW(PANEL.histDef);
      }}
    />
  );
}
