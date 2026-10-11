import { useRef, type DragEvent } from "react";
import { useStudioActions, useStudioStore, useUiStore } from "@/state";
import { IconImage, IconPencil, IconX } from "./icons";

function Slide({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="ai-field i2i-field">
      {label}
      <div className="ai-slide">
        <input className="ai-box" type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      </div>
    </label>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));

export function I2iSection() {
  const i2i = useStudioStore((s) => s.i2i);
  const patchI2i = useStudioStore((s) => s.patchI2i);
  const busy = useStudioStore((s) => s.busy);
  const hasShot = useStudioStore((s) => s.session.some((x) => x.id === s.currentId && !x.pending && x.blobHash));
  const { setI2iFromFile, setI2iFromShot, clearI2i, openEditor } = useStudioActions();
  const fileRef = useRef<HTMLInputElement>(null);

  function onDrop(e: DragEvent) {
    const file = [...(e.dataTransfer?.files || [])][0];
    if (!file) return;
    // 全局拖入会弹元数据窗；落在这块区域上则直接当底图。
    e.preventDefault();
    e.stopPropagation();
    useUiStore.getState().hideOverlay();
    void setI2iFromFile(file);
  }

  const input = (
    <input
      ref={fileRef}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) void setI2iFromFile(file);
      }}
    />
  );

  if (!i2i) {
    return (
      <section>
        <div className="sec-label">参考图</div>
        <div className="i2i" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <button className="i2i-main" type="button" onClick={() => fileRef.current?.click()}>
            <span className="i2i-ico">
              <IconImage />
            </span>
            <span className="i2i-copy">
              <b>图生图</b>
              <small>点击或拖入图片作底图，也可以用当前预览图。</small>
            </span>
          </button>
          <span className="i2i-actions">
            <button className="i2i-mini" type="button" disabled={!hasShot} title="把画布里当前这张图作为底图" onClick={() => setI2iFromShot()}>
              用当前图
            </button>
          </span>
        </div>
        {input}
      </section>
    );
  }

  const inpaint = Boolean(i2i.maskHash);
  return (
    <section>
      <div className="sec-label">参考图</div>
      <div className="i2i-card" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <div className="i2i-head">
          <button className="i2i-thumb" type="button" title="更换底图" onClick={() => fileRef.current?.click()}>
            <img src={i2i.url} alt="底图" />
            {i2i.maskUrl ? <img className="i2i-maskimg" src={i2i.maskUrl} alt="蒙版" /> : null}
          </button>
          <span className="i2i-copy">
            <b>{inpaint ? "局部重绘" : "图生图"}</b>
            <small>
              {i2i.width && i2i.height ? `${i2i.width} × ${i2i.height}` : "底图"}
              {inpaint ? " · 已有蒙版" : ""}
            </small>
          </span>
          <span className="i2i-actions">
            <button className="ico" type="button" title="编辑图片" disabled={busy} onClick={() => openEditor("draw")}>
              <IconPencil />
            </button>
            <button className="i2i-mini" type="button" title="涂蒙版，只重绘选中的部分" disabled={busy} onClick={() => openEditor("mask")}>
              蒙版
            </button>
            {inpaint ? (
              <button className="i2i-mini" type="button" title="去掉蒙版，回到整图图生图" onClick={() => patchI2i({ maskHash: undefined, maskUrl: undefined })}>
                去蒙版
              </button>
            ) : null}
            <button className="ico" type="button" title="移除底图" onClick={clearI2i}>
              <IconX />
            </button>
          </span>
        </div>
        <Slide label="强度 Strength" value={i2i.strength} min={0.01} max={0.99} step={0.01} onChange={(n) => patchI2i({ strength: clamp(n, 0.01, 0.99) })} />
        <Slide label="噪声 Noise" value={i2i.noise} min={0} max={0.99} step={0.01} onChange={(n) => patchI2i({ noise: clamp(n, 0, 0.99) })} />
        {inpaint ? (
          <Slide label="重绘强度" value={i2i.inpaintStrength} min={0.01} max={1} step={0.01} onChange={(n) => patchI2i({ inpaintStrength: clamp(n, 0.01, 1) })} />
        ) : null}
      </div>
      {input}
    </section>
  );
}
