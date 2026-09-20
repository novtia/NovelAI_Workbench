import { closeStudioMenus, useStudio } from "@/state";
import { IconPlus, IconTrash } from "./icons";

export function ParamSetPop() {
  const { pop, popPos, sets, currentSetId, selectParamSet, updateParamSet, deleteParamSet, setParamDialog } = useStudio();
  const open = pop === "paramSet";
  return (
    <div
      className={`pop-panel album-pop param-set-pop${open ? " open" : ""}`}
      id="st-param-set-pop"
      style={open ? { left: popPos.left, top: popPos.top } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="pop-h">参数预设</div>
      <div className="album-pop-list">
        {!sets.length && <p className="param-set-empty">还没有预设。保存当前生图参数后，抽奖台可直接选用。</p>}
        {sets.map((item) => (
          <div className="param-set-row" key={item.id}>
            <button type="button" className={`param-set-pick${item.id === currentSetId ? " on" : ""}`} onClick={() => selectParamSet(item.id)}>
              <span className="name">{item.name}</span>
            </button>
            <button
              type="button"
              className="param-set-del"
              title="删除"
              onClick={(e) => {
                e.stopPropagation();
                void deleteParamSet(item.id);
              }}
            >
              <IconTrash />
            </button>
          </div>
        ))}
      </div>
      <div className="param-set-actions">
        <button type="button" disabled={!currentSetId} onClick={() => void updateParamSet()}>
          更新当前
        </button>
        <button
          type="button"
          id="st-param-set-save"
          onClick={(e) => {
            e.stopPropagation();
            closeStudioMenus();
            setParamDialog(true, "");
          }}
        >
          <IconPlus />
          保存为新预设
        </button>
      </div>
    </div>
  );
}
