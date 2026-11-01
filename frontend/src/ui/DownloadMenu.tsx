import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { artworkDownloadName, downloadImageFile, placePop } from "@/data";
import type { Artwork, StudioDownloadKind } from "@/data/types";
import { pushToast } from "@/state/toast";

export async function downloadArtwork(item: Artwork, kind: StudioDownloadKind) {
  if (!item.imageUrl) {
    pushToast("没有可下载的图片", "warn");
    return;
  }
  try {
    await downloadImageFile(item.imageUrl, artworkDownloadName(item, kind), kind === "clean");
  } catch (err) {
    pushToast(err instanceof Error ? err.message : "下载失败", "warn");
  }
}

export function DownloadChoices({ onPick }: { onPick: (kind: StudioDownloadKind) => void }) {
  return (
    <>
      <div className="pop-h">下载</div>
      <button type="button" onClick={() => onPick("original")}>
        <span>原图（带原数据）</span>
        <span className="sub">完整 PNG，含生成参数</span>
      </button>
      <button type="button" onClick={() => onPick("clean")}>
        <span>图片（不带数据）</span>
        <span className="sub">去掉隐写和元数据</span>
      </button>
    </>
  );
}

export function useDownloadPop() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  function toggle(el: HTMLElement) {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = el.getBoundingClientRect();
    const height = 148;
    setPos(placePop(rect, 250, height, rect.top > height + 12, window.innerWidth, window.innerHeight));
    setOpen(true);
  }
  const close = useCallback(() => setOpen(false), []);
  return { open, pos, toggle, close };
}

export function DownloadMenu({
  open,
  left,
  top,
  onClose,
  onPick,
}: {
  open: boolean;
  left: number;
  top: number;
  onClose: () => void;
  onPick: (kind: StudioDownloadKind) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className="pop-panel album-pop download-pop open"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <DownloadChoices
        onPick={(kind) => {
          onClose();
          onPick(kind);
        }}
      />
    </div>,
    document.body,
  );
}
