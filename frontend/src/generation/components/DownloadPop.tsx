import { closeStudioMenus, useStudioActions, useStudioStore } from "@/state";
import { DownloadChoices } from "@/ui/DownloadMenu";

export function DownloadPop() {
  const pop = useStudioStore((s) => s.pop);
  const popPos = useStudioStore((s) => s.popPos);
  const downloadCurrent = useStudioActions().downloadCurrent;
  const open = pop === "download";
  return (
    <div
      className={`pop-panel album-pop download-pop${open ? " open" : ""}`}
      id="st-download-pop"
      style={open ? { left: popPos.left, top: popPos.top } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <DownloadChoices
        onPick={(kind) => {
          closeStudioMenus();
          void downloadCurrent(kind);
        }}
      />
    </div>
  );
}
