import { useStudioActions, useStudioStore } from "@/state";
import { IconCrop, IconImage, IconPencil } from "./icons";

export function I2iSection() {
  const i2iOpen = useStudioStore((s) => s.i2iOpen);
  const setI2iOpen = useStudioStore((s) => s.setI2iOpen);
  const soon = useStudioActions().soon;
  return (
    <section>
      <div className="sec-label">参考图</div>
      <button
        className="i2i"
        type="button"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-soon]")) return;
          setI2iOpen(!i2iOpen);
          soon("图生图底图接口将在第二波接入");
        }}
      >
        <span className="i2i-ico">
          <IconImage />
        </span>
        <span className="i2i-copy">
          <b>图生图</b>
          <small>用图片引导生成。底图接口第二波接入。</small>
        </span>
        <span className="i2i-actions">
          <span className="ico" data-soon="crop" title="裁剪" onClick={(e) => { e.stopPropagation(); soon(); }}>
            <IconCrop />
          </span>
          <span className="ico" data-soon="inpaint" title="局部重绘" onClick={(e) => { e.stopPropagation(); soon(); }}>
            <IconPencil />
          </span>
        </span>
      </button>
      <div className={`i2i-drop${i2iOpen ? " show" : ""}`}>拖入图片，或点击上传。第二波接入底图。</div>
    </section>
  );
}
