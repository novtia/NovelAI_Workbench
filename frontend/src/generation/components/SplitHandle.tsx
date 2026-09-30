import { useStudioStore } from "@/state/studioStore";
import { PANEL, clampPanel } from "@/data/studio";
import { ACTIVITY_RAIL } from "@/ui/inkBackdrop";

/**
 * 拖拽期间不碰 React / zustand：只在 rAF 里直接改 #view-studio 上的 CSS 变量，
 * 松手时一次性写回 store（由它落到 style 属性并持久化）。
 */
export function SplitHandle({ side }: { side: "left" | "hist" }) {
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
        const el = e.currentTarget;
        const root = document.getElementById("view-studio");
        const st = useStudioStore.getState();
        // 按下时一次性读布局并缓存边界，move 里不再读 DOM
        const total = root?.clientWidth || Math.max(0, window.innerWidth - ACTIVITY_RAIL);
        const startX = e.clientX;
        const start = side === "left" ? st.leftW : st.histW;
        const other = side === "left" ? st.histW : st.leftW;
        const max = Math.min(
          side === "left" ? PANEL.leftMax : PANEL.histMax,
          total - other - PANEL.split - PANEL.centerMin,
        );
        const min = side === "left" ? PANEL.leftMin : PANEL.histMin;
        const cssVar = side === "left" ? "--st-left-w" : "--st-hist-w";

        let value = start;
        let raf = 0;
        const paint = () => {
          raf = 0;
          root?.style.setProperty(cssVar, `${value}px`);
        };

        document.body.classList.add("is-resizing");
        el.classList.add("is-on");
        el.setPointerCapture(e.pointerId);

        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          value = clampPanel(side === "left" ? start + dx : start - dx, min, max);
          if (!raf) raf = requestAnimationFrame(paint);
        };
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", finish);
          el.removeEventListener("pointercancel", finish);
          el.removeEventListener("lostpointercapture", finish);
          if (raf) cancelAnimationFrame(raf);
          root?.style.setProperty(cssVar, `${value}px`);
          document.body.classList.remove("is-resizing");
          el.classList.remove("is-on");
          const s = useStudioStore.getState();
          if (side === "left") s.setLeftW(value);
          else s.setHistW(value);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", finish);
        el.addEventListener("pointercancel", finish);
        el.addEventListener("lostpointercapture", finish);
      }}
      onDoubleClick={() => {
        const s = useStudioStore.getState();
        if (side === "left") s.setLeftW(PANEL.leftDef);
        else s.setHistW(PANEL.histDef);
      }}
    />
  );
}
