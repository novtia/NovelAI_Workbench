import { BasketPopover } from "../basket/BasketPopover";
import { useCommands, useSession } from "@/state";
import { ConfirmDialog } from "@/ui/ConfirmDialog";

export function WorkbenchHosts() {
  const overlay = useSession((s) => s.overlay);
  const hideOverlay = useSession((s) => s.hideOverlay);
  const progress = useSession((s) => s.progress);
  const { importFiles } = useCommands();
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <>
      <input
        id="wb-file-input"
        type="file"
        hidden
        multiple
        accept="image/png,image/webp,image/jpeg"
        onChange={(e) => {
          void importFiles(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
      <div
        className={`overlay${overlay.show ? " show" : ""}`}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) hideOverlay();
        }}
      >
        <div className="overlay-card">
          <strong>{overlay.title}</strong>
          <span>{overlay.desc}</span>
        </div>
      </div>
      <BasketPopover />
      <ConfirmDialog />
      <div className={`progress${progress.show ? " show" : ""}`}>
        <span>
          正在解析 {progress.done} / {progress.total}
        </span>
        <div className="bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
    </>
  );
}
