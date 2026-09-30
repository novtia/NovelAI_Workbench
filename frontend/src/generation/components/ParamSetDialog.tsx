import { useEffect, useRef } from "react";
import { useStudioActions, useStudioStore } from "@/state";

export function ParamSetDialog() {
  const paramDialog = useStudioStore((s) => s.paramDialog);
  const paramName = useStudioStore((s) => s.paramName);
  const setParamDialog = useStudioStore((s) => s.setParamDialog);
  const setParamName = useStudioStore((s) => s.setParamName);
  const saveParamSet = useStudioActions().saveParamSet;
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (paramDialog && !el.open) el.showModal();
    if (!paramDialog && el.open) el.close();
    if (paramDialog) {
      queueMicrotask(() => {
        el.querySelector("input")?.focus();
        el.querySelector("input")?.select();
      });
    }
  }, [paramDialog]);

  return (
    <dialog
      className="modal"
      id="param-set-dialog"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        setParamDialog(false);
      }}
      onClick={(e) => {
        if (e.target === ref.current) setParamDialog(false);
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void saveParamSet(paramName);
        }}
      >
        <h3>保存预设</h3>
        <input
          type="text"
          maxLength={40}
          placeholder="例如：竖图动漫"
          autoComplete="off"
          required
          value={paramName}
          onChange={(e) => setParamName(e.target.value)}
        />
        <div className="modal-actions">
          <button className="btn" type="button" onClick={() => setParamDialog(false)}>
            取消
          </button>
          <button className="btn btn-primary" type="submit">
            确定
          </button>
        </div>
      </form>
    </dialog>
  );
}
