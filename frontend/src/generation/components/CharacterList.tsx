import { openStudioPop, useStudioActions, useStudioStore } from "@/state";
import { CharacterCard } from "./CharacterCard";
import { IconGrid, IconPlus } from "./icons";

export function CharacterList() {
  const characters = useStudioStore((s) => s.form.characters);
  const useCoords = useStudioStore((s) => s.form.useCoords);
  const directing = useStudioStore((s) => s.directing);
  const setCustom = useStudioActions().setCustom;
  return (
    <section className="chars-area">
      <div className="card chars-head">
        <div className="block-head">
          <div className="grow">
            <h3>角色提示</h3>
            <p>为场景中的角色单独填写提示词。空卡不会发送。</p>
          </div>
          <button
            className="add-btn lg"
            id="char-add"
            type="button"
            title="添加角色"
            onClick={(e) => {
              e.stopPropagation();
              openStudioPop("gender", e.currentTarget);
            }}
          >
            <IconPlus />
          </button>
        </div>
        <div className="pos-row">
          <span className="k">位置</span>
          <div className="seg-bar pos-bar">
            <button className={!useCoords ? "on" : ""} type="button" onClick={() => setCustom(false)}>
              自动
            </button>
            <button className={useCoords && !directing ? "on" : ""} type="button" onClick={() => setCustom(true, false)}>
              自定义
            </button>
            <button className={directing ? "on" : ""} type="button" title="构图" onClick={() => setCustom(true, true)}>
              <IconGrid />
            </button>
          </div>
        </div>
      </div>
      <div id="char-list">
        {characters.map((ch, i) => (
          <CharacterCard key={i} ch={ch} index={i} />
        ))}
      </div>
    </section>
  );
}
