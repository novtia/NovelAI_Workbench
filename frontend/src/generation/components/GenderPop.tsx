import type { GenderId } from "@/data/types";
import { closeStudioMenus, useStudioActions, useStudioStore } from "@/state";
import { GenderSvg } from "./icons";

const OPTIONS: Array<{ g: GenderId; label: string }> = [
  { g: "f", label: "女" },
  { g: "m", label: "男" },
  { g: "o", label: "其他" },
];

export function GenderPop() {
  const pop = useStudioStore((s) => s.pop);
  const popPos = useStudioStore((s) => s.popPos);
  const addCharacter = useStudioActions().addCharacter;
  const open = pop === "gender";
  return (
    <div
      className={`pop-panel gender-pop${open ? " open" : ""}`}
      id="st-gender-pop"
      style={open ? { left: popPos.left, top: popPos.top } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      {OPTIONS.map((o) => (
        <button
          key={o.g}
          type="button"
          data-g={o.g}
          onClick={() => {
            addCharacter(o.g);
            closeStudioMenus();
          }}
        >
          <GenderSvg g={o.g} />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
