import type { ReactNode } from "react";
import type { Tip } from "@/data/imageEditor";
import { IconExport, IconEyedropper, IconPencil, IconMask, IconTipRound, IconTipSlash, IconTipSoft, IconTipSquare, IconX } from "../icons";

const TIPS: Array<{ id: Tip; title: string; icon: ReactNode }> = [
  { id: "round", title: "圆形笔尖", icon: <IconTipRound /> },
  { id: "soft", title: "柔边笔尖", icon: <IconTipSoft /> },
  { id: "square", title: "方形笔尖", icon: <IconTipSquare /> },
  { id: "slash", title: "斜刷笔尖", icon: <IconTipSlash /> },
];

type Props = {
  maskMode: boolean;
  onMode: (mask: boolean) => void;
  color: string;
  onColor: (hex: string) => void;
  eyedropOn: boolean;
  onEyedrop: () => void;
  size: number;
  onSize: (n: number) => void;
  tip: Tip;
  onTip: (t: Tip) => void;
  saving: boolean;
  ready: boolean;
  onExport: () => void;
  onSave: () => void;
  onClose: () => void;
};

/** 顶部栏：模式、颜色 + 吸管、Pen Size、笔尖形状；右侧导出、保存并关闭、关闭。 */
export function EditorTopBar(p: Props) {
  return (
    <div className="ied-top">
      <div className="ied-group">
        <div className="seg-bar">
          <button type="button" className={!p.maskMode ? "on" : ""} onClick={() => p.onMode(false)} title="在图上直接涂画">
            <IconPencil />
            Draw
          </button>
          <button type="button" className={p.maskMode ? "on" : ""} onClick={() => p.onMode(true)} title="涂出要重绘的区域">
            <IconMask />
            Inpaint
          </button>
        </div>
        {!p.maskMode ? (
          <div className="ied-swatch">
            <input className="ied-color" type="color" value={p.color} onChange={(e) => p.onColor(e.target.value)} title="颜色" />
            <button type="button" className={`ied-dropper${p.eyedropOn ? " on" : ""}`} title="吸管：取画面里的颜色" onClick={p.onEyedrop}>
              <IconEyedropper />
            </button>
          </div>
        ) : null}
        <label className="ied-size">
          <span>Pen Size: {p.size}</span>
          <input type="range" min={2} max={160} step={1} value={p.size} onChange={(e) => p.onSize(Number(e.target.value))} />
        </label>
        <div className="ied-tips">
          {TIPS.map((t) => (
            <button key={t.id} type="button" className={p.tip === t.id ? "on" : ""} title={t.title} onClick={() => p.onTip(t.id)}>
              {t.icon}
            </button>
          ))}
        </div>
      </div>
      <div className="ied-group">
        <button className="ied-x" type="button" title="导出当前画面为 PNG" disabled={!p.ready} onClick={p.onExport}>
          <IconExport />
        </button>
        <button className="btn btn-primary" type="button" disabled={p.saving || !p.ready} onClick={p.onSave}>
          {p.saving ? "保存中…" : "Save & Close"}
        </button>
        <button className="ied-x" type="button" title="放弃修改（Esc）" onClick={p.onClose}>
          <IconX />
        </button>
      </div>
    </div>
  );
}
