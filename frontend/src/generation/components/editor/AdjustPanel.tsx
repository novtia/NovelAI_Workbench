import { ADJUST_ZERO, isAdjusted, type Adjust } from "@/data/imageEditor";
import { IconX } from "../icons";

const FIELDS: Array<{ key: keyof Adjust; label: string; min: number; max: number }> = [
  { key: "brightness", label: "亮度", min: -100, max: 100 },
  { key: "contrast", label: "对比度", min: -100, max: 100 },
  { key: "saturation", label: "饱和度", min: -100, max: 100 },
  { key: "hue", label: "色相", min: -180, max: 180 },
];

type Props = {
  value: Adjust;
  hasSel: boolean;
  onChange: (next: Adjust) => void;
  onApply: () => void;
  onClose: () => void;
};

/** 调整面板：拖动时画布实时预览，点「应用」才写进图里（有选区时只作用于选区）。 */
export function AdjustPanel({ value, hasSel, onChange, onApply, onClose }: Props) {
  return (
    <div className="ied-adjust" role="dialog" aria-label="调整" onClick={(e) => e.stopPropagation()}>
      <div className="ied-adjust-head">
        <b>调整</b>
        <button className="ico" type="button" title="关闭" onClick={onClose}>
          <IconX />
        </button>
      </div>
      {FIELDS.map((f) => (
        <label key={f.key} className="ied-adjust-row">
          <span>{f.label}</span>
          <input type="range" min={f.min} max={f.max} step={1} value={value[f.key]} onChange={(e) => onChange({ ...value, [f.key]: Number(e.target.value) })} />
          <em>{value[f.key]}</em>
        </label>
      ))}
      <div className="ied-adjust-foot">
        <small>{hasSel ? "只作用于选区" : "作用于整张图"}</small>
        <span>
          <button className="i2i-mini" type="button" disabled={!isAdjusted(value)} onClick={() => onChange(ADJUST_ZERO)}>
            重置
          </button>
          <button className="btn btn-primary" type="button" disabled={!isAdjusted(value)} onClick={onApply}>
            应用
          </button>
        </span>
      </div>
    </div>
  );
}
