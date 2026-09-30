import { MODE_LABEL, MODEL_LABEL } from "@/data/studio";
import { useShallow } from "zustand/react/shallow";
import { openStudioPop, useParamSetsQuery, useStudioActions, useStudioStore } from "@/state";
import { IconChevron, IconSpark } from "./icons";

export function ModelRow() {
  const form = useStudioStore(useShallow((s) => ({ model: s.form.model, v5Mode: s.form.v5Mode })));
  const openDd = useStudioStore((s) => s.openDd);
  const currentSetId = useStudioStore((s) => s.currentSetId);
  const setOpenDd = useStudioStore((s) => s.setOpenDd);
  const patch = useStudioActions().patch;
  const currentSet = (useParamSetsQuery().data || []).find((x) => x.id === currentSetId) || null;
  return (
    <div className="model-row">
      <span className="k">模型</span>
      <div className={`dd${openDd === "model" ? " open" : ""}`} id="dd-model">
        <button className="pill" type="button" onClick={() => setOpenDd(openDd === "model" ? "" : "model")}>
          <span>{MODEL_LABEL[form.model] || "V5 完整"}</span>
          <IconChevron />
        </button>
        <div className="dd-menu">
          {Object.entries(MODEL_LABEL).map(([val, lab]) => (
            <button key={val} type="button" className={form.model === val ? "on" : ""} onClick={() => { patch({ model: val }); setOpenDd(""); }}>
              {lab}
            </button>
          ))}
        </div>
      </div>
      <span className="k">模式</span>
      <div className={`dd${openDd === "mode" ? " open" : ""}`} id="dd-mode">
        <button className="pill" type="button" onClick={() => setOpenDd(openDd === "mode" ? "" : "mode")}>
          <IconSpark />
          <span>{MODE_LABEL[form.v5Mode]}</span>
        </button>
        <div className="dd-menu">
          <button type="button" className={form.v5Mode === "anime" ? "on" : ""} onClick={() => { patch({ v5Mode: "anime" }); setOpenDd(""); }}>
            动漫
          </button>
          <button type="button" className={form.v5Mode === "furry" ? "on" : ""} onClick={() => { patch({ v5Mode: "furry" }); setOpenDd(""); }}>
            兽人
          </button>
        </div>
      </div>
      <span className="spacer" />
      <button
        className="pill"
        id="st-param-set-btn"
        type="button"
        title="参数预设"
        onClick={(e) => {
          e.stopPropagation();
          openStudioPop("paramSet", e.currentTarget);
        }}
      >
        <span>{currentSet?.name || "预设"}</span>
        <IconChevron />
      </button>
    </div>
  );
}
