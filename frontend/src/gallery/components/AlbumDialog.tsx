import { useEffect, useRef } from "react";
import { useCommands, useLotteryStore, useSession, useStudioStore } from "@/state";

export function AlbumDialog() {
  const { submitDialog } = useCommands();
  const dialog = useSession((s) => s.dialog);
  const setDialogName = useSession((s) => s.setDialogName);
  const closeDialog = useSession((s) => s.closeDialog);
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = Boolean(dialog);
  const dialogKey = dialog ? `${dialog.mode}:${dialog.albumId || ""}` : "";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
    if (!open) return;
    queueMicrotask(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [open, dialogKey]);

  return (
    <dialog
      className="modal"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        closeDialog();
        useLotteryStore.getState().setPendingSave(null);
        useStudioStore.getState().setPendingSave(false);
      }}
      onClick={(e) => {
        if (e.target === ref.current) closeDialog();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitDialog();
        }}
      >
        <h3>{dialog?.mode === "rename" ? "重命名收藏夹" : "新建收藏夹"}</h3>
        <input
          ref={inputRef}
          type="text"
          maxLength={40}
          placeholder="例如：写实 3D"
          autoComplete="off"
          required
          value={dialog?.name ?? ""}
          onChange={(e) => setDialogName(e.target.value)}
        />
        <div className="modal-actions">
          <button className="btn" type="button" onClick={() => {
            useLotteryStore.getState().setPendingSave(null);
            useStudioStore.getState().setPendingSave(false);
            closeDialog();
          }}>
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
