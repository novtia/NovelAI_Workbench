import { useEffect, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

/** 无边框窗口右上角的最小化 / 最大化（还原） / 关闭按钮。 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => {
      void win
        .isMaximized()
        .then((m) => alive && setMaximized(m))
        .catch(() => {});
    };
    sync();
    const off = win.onResized(sync);
    return () => {
      alive = false;
      void off.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const stop = (e: MouseEvent) => e.stopPropagation();
  const win = () => getCurrentWindow();

  return (
    <div className="wb-winctl" onMouseDown={stop} onDoubleClick={stop}>
      <button type="button" title="最小化" aria-label="最小化" tabIndex={-1} onClick={() => void win().minimize()}>
        <Minus strokeWidth={1.6} />
      </button>
      <button
        type="button"
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        tabIndex={-1}
        onClick={() => void win().toggleMaximize()}
      >
        {maximized ? <Copy strokeWidth={1.6} className="restore" /> : <Square strokeWidth={1.6} />}
      </button>
      <button type="button" className="close" title="关闭" aria-label="关闭" tabIndex={-1} onClick={() => void win().close()}>
        <X strokeWidth={1.6} />
      </button>
    </div>
  );
}
