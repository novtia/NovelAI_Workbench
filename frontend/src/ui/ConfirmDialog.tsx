import { useEffect, useRef } from "react";
import { useConfirmStore } from "@/state/confirm";

/** 全局确认弹窗，挂在 WorkbenchHosts 里，由 confirmDialog() 驱动。 */
export function ConfirmDialog() {
  const pending = useConfirmStore((s) => s.pending);
  const settle = useConfirmStore((s) => s.settle);
  const ref = useRef<HTMLDialogElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const open = Boolean(pending);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      queueMicrotask(() => okRef.current?.focus());
    }
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      className="modal confirm-modal"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        settle(false);
      }}
      onClick={(e) => {
        if (e.target === ref.current) settle(false);
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          settle(true);
        }}
      >
        <h3>{pending?.title || "请确认"}</h3>
        <p className="confirm-msg">{pending?.message}</p>
        <div className="modal-actions">
          <button className="btn" type="button" onClick={() => settle(false)}>
            {pending?.cancelText || "取消"}
          </button>
          <button ref={okRef} className="btn btn-primary" type="submit">
            {pending?.confirmText || "确定"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
