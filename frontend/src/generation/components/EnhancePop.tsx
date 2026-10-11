import { ENHANCE_AMOUNT_LABEL, ENHANCE_STRENGTH, clampMagnitude } from "@/data";
import type { EnhanceAmount } from "@/data/types";
import { closeStudioMenus, useStudioActions, useStudioEstimate, useStudioStore } from "@/state";
import { IconBolt, IconEnhance, IconX } from "./icons";

const AMOUNTS: EnhanceAmount[] = ["1x", "1.5x", "max"];

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));

/** 官方 Enhance 面板：Upscale Amount / Magnitude / Show Advanced。 */
export function EnhancePop() {
  const pop = useStudioStore((s) => s.pop);
  const popPos = useStudioStore((s) => s.popPos);
  const enhance = useStudioStore((s) => s.enhance);
  const patchEnhance = useStudioStore((s) => s.patchEnhance);
  const { enhanceCurrent } = useStudioActions();
  const open = pop === "enhance";
  const cost = useStudioEstimate()?.enhance;

  return (
    <div
      className={`pop-panel enhance-pop${open ? " open" : ""}`}
      id="st-enhance-pop"
      style={open ? { left: popPos.left, top: popPos.top } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="enh-head">
        <span className="enh-title">
          <IconEnhance />
          增强图片
        </span>
        <button className="ico" type="button" title="关闭" onClick={() => closeStudioMenus()}>
          <IconX />
        </button>
      </div>
      <div className="enh-body">
        <div className="enh-col">
          <span className="enh-label">放大倍数</span>
          <div className="seg-bar">
            {AMOUNTS.map((a) => (
              <button key={a} type="button" className={enhance.upscaleAmount === a ? "on" : ""} onClick={() => patchEnhance({ upscaleAmount: a })}>
                {ENHANCE_AMOUNT_LABEL[a]}
              </button>
            ))}
          </div>
        </div>
        <div className="enh-col grow">
          <span className="enh-label">
            强度级别 <b>{enhance.magnitude}</b>
          </span>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={enhance.magnitude}
            disabled={enhance.advanced}
            onChange={(e) => {
              const m = clampMagnitude(Number(e.target.value));
              patchEnhance({ magnitude: m, strength: ENHANCE_STRENGTH[m], noise: 0 });
            }}
          />
        </div>
      </div>
      <button className="enh-adv" type="button" onClick={() => patchEnhance({ advanced: !enhance.advanced })}>
        {enhance.advanced ? "收起高级" : "显示高级"}
      </button>
      {enhance.advanced ? (
        <div className="enh-advanced">
          <label className="ai-field">
            强度 Strength
            <div className="ai-slide">
              <input
                className="ai-box"
                type="number"
                min={0.01}
                max={0.99}
                step={0.01}
                value={enhance.strength}
                onChange={(e) => patchEnhance({ strength: clamp(Number(e.target.value), 0.01, 0.99) })}
              />
              <input
                type="range"
                min={0.01}
                max={0.99}
                step={0.01}
                value={enhance.strength}
                onChange={(e) => patchEnhance({ strength: clamp(Number(e.target.value), 0.01, 0.99) })}
              />
            </div>
          </label>
          <label className="ai-field">
            噪声 Noise
            <div className="ai-slide">
              <input
                className="ai-box"
                type="number"
                min={0}
                max={0.99}
                step={0.01}
                value={enhance.noise}
                onChange={(e) => patchEnhance({ noise: clamp(Number(e.target.value), 0, 0.99) })}
              />
              <input
                type="range"
                min={0}
                max={0.99}
                step={0.01}
                value={enhance.noise}
                onChange={(e) => patchEnhance({ noise: clamp(Number(e.target.value), 0, 0.99) })}
              />
            </div>
          </label>
        </div>
      ) : null}
      <p className="enh-tip">会沿用当前提示词，对选中的这张图再过一遍模型。</p>
      <button className="btn btn-primary enh-go" type="button" onClick={() => void enhanceCurrent()}>
        开始增强
        {typeof cost === "number" ? (
          <span className="cost">
            {cost}
            <IconBolt />
          </span>
        ) : null}
      </button>
    </div>
  );
}
