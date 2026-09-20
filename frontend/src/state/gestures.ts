import { useEffect, useRef } from "react";
import { filesFromClipboard, filesFromDataTransfer, hasDropPayload, readStudioShotDrag } from "@/data";
import { useCollection } from "./collection";
import { useCommands } from "./commands";
import { useSession } from "./session";

export function useImportGestures() {
  const { ingestDropped } = useCommands();
  const ingestRef = useRef(ingestDropped);
  ingestRef.current = ingestDropped;
  const albumName = useCollection().album?.name;

  useEffect(() => {
    function onDragEnter(e: DragEvent) {
      if (!hasDropPayload(e)) return;
      e.preventDefault();
      const s = useSession.getState();
      if (s.view === "studio") {
        s.showOverlay("松开以载入元数据", "将解析 PNG / WEBP 中的 NAI 生成参数");
      } else {
        s.showOverlay(`松开以导入到「${albumName || "收藏夹"}」`, "PNG / WEBP，将自动解析 NAI 参数");
      }
    }
    function onDragOver(e: DragEvent) {
      if (!hasDropPayload(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
    async function onDrop(e: DragEvent) {
      e.preventDefault();
      useSession.getState().hideOverlay();
      const shot = readStudioShotDrag(e.dataTransfer);
      if (shot) {
        await ingestRef.current([], shot);
        return;
      }
      const files = await filesFromDataTransfer(e.dataTransfer);
      await ingestRef.current(files);
    }
    function onPaste(e: ClipboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      const files = filesFromClipboard(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      void ingestRef.current(files);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const s = useSession.getState();
      if (s.dialog) {
        s.closeDialog();
        return;
      }
      if (s.overlay.show) {
        s.hideOverlay();
        return;
      }
      s.setOpenId(null);
    }
    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKey);
    };
  }, [albumName]);
}
