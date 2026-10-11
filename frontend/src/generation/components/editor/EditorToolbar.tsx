import type { ReactNode } from "react";
import type { EditorTool } from "@/data/imageEditor";
import {
  IconAdjust,
  IconBucket,
  IconClone,
  IconDrop,
  IconEraser,
  IconEyedropper,
  IconImportImage,
  IconLasso,
  IconMarquee,
  IconPencil,
  IconRedo,
  IconTrash,
  IconUndo,
} from "../icons";

const TOOLS: Array<{ id: EditorTool; title: string; icon: ReactNode; drawOnly?: boolean }> = [
  { id: "pen", title: "画笔", icon: <IconPencil /> },
  { id: "eraser", title: "橡皮", icon: <IconEraser /> },
  { id: "fill", title: "填充：点一下填满同色区域；有选区时点选区内填满选区", icon: <IconBucket /> },
  { id: "marquee", title: "矩形选区（作用范围限制在选区内）", icon: <IconMarquee /> },
  { id: "lasso", title: "套索选区", icon: <IconLasso /> },
  { id: "eyedrop", title: "吸管", icon: <IconEyedropper />, drawOnly: true },
  { id: "blur", title: "模糊：涂抹处变柔和", icon: <IconDrop />, drawOnly: true },
  { id: "clone", title: "复制：先框选，再拖动选区复制出一份", icon: <IconClone />, drawOnly: true },
];

type Props = {
  maskMode: boolean;
  tool: EditorTool;
  onTool: (t: EditorTool) => void;
  hasSel: boolean;
  adjustOn: boolean;
  onAdjust: () => void;
  onClear: () => void;
  onImport: () => void;
  onInvert: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
};

/** 底部工具条：左边绘制与选择工具，右边调整、清空、导入图片、撤销重做。 */
export function EditorToolbar(p: Props) {
  return (
    <div className="ied-bottom">
      {TOOLS.map((t) => {
        const off = Boolean(t.drawOnly && p.maskMode);
        return (
          <button
            key={t.id}
            type="button"
            className={p.tool === t.id ? "on" : ""}
            title={off ? `${t.title}（蒙版模式不可用）` : t.title}
            disabled={off}
            onClick={() => p.onTool(t.id)}
          >
            {t.icon}
          </button>
        );
      })}
      {p.maskMode ? (
        <button type="button" className="ied-text" title="选区取反" onClick={p.onInvert}>
          反选
        </button>
      ) : null}
      <span className="ied-spacer" />
      <button type="button" className={p.adjustOn ? "on" : ""} title="调整：亮度 / 对比度 / 饱和度 / 色相" disabled={p.maskMode} onClick={p.onAdjust}>
        <IconAdjust />
      </button>
      <button type="button" title={p.hasSel ? "清空选区内的内容" : p.maskMode ? "清空蒙版" : "清空涂画"} onClick={p.onClear}>
        <IconTrash />
      </button>
      <button type="button" title="导入图片" disabled={p.maskMode} onClick={p.onImport}>
        <IconImportImage />
      </button>
      <span className="ied-sep" />
      <button type="button" title="撤销（Ctrl+Z）" disabled={!p.canUndo} onClick={p.onUndo}>
        <IconUndo />
      </button>
      <button type="button" title="重做（Ctrl+Shift+Z）" disabled={!p.canRedo} onClick={p.onRedo}>
        <IconRedo />
      </button>
    </div>
  );
}
