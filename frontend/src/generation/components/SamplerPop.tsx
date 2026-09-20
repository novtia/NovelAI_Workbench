import { SAMPLER_LABEL } from "@/data/studio";
import { closeStudioMenus, useStudio } from "@/state";

const PRIMARY = "k_euler_ancestral";
const REST = ["k_euler", "k_dpmpp_2s_ancestral", "k_dpmpp_2m_sde", "k_dpmpp_2m", "k_dpmpp_sde"];

export function SamplerPop() {
  const { pop, popPos, form, patch } = useStudio();
  const open = pop === "sampler";
  return (
    <div
      className={`pop-panel${open ? " open" : ""}`}
      id="st-sampler-pop"
      style={open ? { left: popPos.left, top: popPos.top } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={form.sampler === PRIMARY ? "on" : ""}
        onClick={() => {
          patch({ sampler: PRIMARY });
          closeStudioMenus();
        }}
      >
        {SAMPLER_LABEL[PRIMARY]}
      </button>
      <div className="pop-h">其他</div>
      {REST.map((val) => (
        <button
          key={val}
          type="button"
          className={form.sampler === val ? "on" : ""}
          onClick={() => {
            patch({ sampler: val });
            closeStudioMenus();
          }}
        >
          {SAMPLER_LABEL[val]}
        </button>
      ))}
    </div>
  );
}
