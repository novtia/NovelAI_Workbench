import { clipPrompt, inferGender } from "@/data";
import { openStudioPop, pushToast, useStudio } from "@/state";
import {
  Icon1x,
  Icon4x,
  IconCheck,
  IconDirector,
  GenderSvg,
  IconDownload,
  IconEnhance,
  IconFolderPlus,
  IconHeart,
  IconOutpaint,
  IconPencil,
  IconTrash,
} from "./icons";

export function StudioStage() {
  const {
    form,
    sizeLabel,
    previewUrl,
    hasPreview,
    directing,
    busy,
    genProgress,
    current,
    activeChar,
    setActiveChar,
    mutateChar,
    confirmPositions,
    deleteCurrent,
    soon,
  } = useStudio();
  const w = form.width;
  const h = form.height;
  const seedText = current?.meta?.seed != null && Number(current.meta.seed) >= 0 ? String(current.meta.seed) : form.seed >= 0 ? String(form.seed) : "随机";

  return (
    <section
      className={`stage${directing ? " directing" : ""}${directing && hasPreview ? " has-preview" : ""}`}
      id="st-stage"
    >
      <div className="deco deco-a" />
      <div className="deco deco-b" />
      <div className="deco deco-c" />
      <div className="canvas-tools">
        <button className="tbtn" type="button" title="增强" onClick={() => soon()}>
          <IconEnhance />
        </button>
        <button className="tbtn" type="button" title="放大 4 倍" onClick={() => soon()}>
          <Icon4x />
          4x
        </button>
        <button className="tbtn" type="button" title="放大 1 倍" onClick={() => soon()}>
          <Icon1x />
          1x
        </button>
        <button className="tbtn" type="button" title="Director 工具" onClick={() => soon()}>
          <IconDirector />
        </button>
        <button className="tbtn" type="button" title="局部重绘" onClick={() => soon()}>
          <IconPencil />
        </button>
        <button className="tbtn" type="button" title="扩图" onClick={() => soon()}>
          <IconOutpaint />
        </button>
      </div>
      <div className="dir-chips">
        {directing &&
          form.characters.map((ch, i) =>
            ch.enabled === false ? null : (
              <button key={i} type="button" className={`dir-chip${activeChar === i ? " on" : ""}`} onClick={() => setActiveChar(i)}>
                <span className="n">{i + 1}</span>
                <GenderSvg g={inferGender(ch.prompt)} />
                <span className="t">{clipPrompt(ch.prompt)}</span>
              </button>
            ),
          )}
      </div>
      <div className="frame-wrap">
        <div className={`frame-box${w > h ? " landscape" : w === h ? " square" : ""}`} id="frame-box">
          {previewUrl ? <img src={previewUrl} alt="生成预览" /> : null}
          <div className="dir-mask" />
          <div className="dir-pins">
            {directing &&
              form.characters.map((ch, i) => {
                if (ch.enabled === false) return null;
                const x = Math.min(0.98, Math.max(0.02, Number(ch.x) || 0.5));
                const y = Math.min(0.98, Math.max(0.02, Number(ch.y) || 0.5));
                return (
                  <button
                    key={i}
                    type="button"
                    className={`dir-pin${activeChar === i ? " on" : ""}`}
                    style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      setActiveChar(i);
                      const pin = e.currentTarget;
                      pin.setPointerCapture(e.pointerId);
                      const move = (ev: PointerEvent) => {
                        const box = document.getElementById("frame-box");
                        if (!box) return;
                        const r = box.getBoundingClientRect();
                        const nx = Math.min(0.98, Math.max(0.02, (ev.clientX - r.left) / r.width));
                        const ny = Math.min(0.98, Math.max(0.02, (ev.clientY - r.top) / r.height));
                        mutateChar(i, (c) => ({ ...c, x: Number(nx.toFixed(3)), y: Number(ny.toFixed(3)) }));
                      };
                      const up = () => {
                        pin.removeEventListener("pointermove", move);
                        pin.removeEventListener("pointerup", up);
                      };
                      pin.addEventListener("pointermove", move);
                      pin.addEventListener("pointerup", up);
                    }}
                  >
                    {i + 1}
                  </button>
                );
              })}
          </div>
        </div>
      </div>
      <div className={`busy-veil${busy ? " show" : ""}${busy && previewUrl ? " live" : ""}`}>
        {busy && previewUrl ? "" : busy ? genProgress || "生成中" : "生成中"}
      </div>
      <div className="stage-bl">
        <span className="mchip">{sizeLabel}</span>
        <span className="mchip">
          <IconHeart />
          <span>{seedText}</span>
        </span>
      </div>
      <div className="stage-br">
        <button className="sbtn primary" id="btn-confirm-pos" type="button" title="确认修改位置" onClick={confirmPositions}>
          <IconCheck />
        </button>
        <button
          className="sbtn primary"
          id="btn-save-gallery"
          type="button"
          title="保存到图库"
          onClick={(e) => {
            e.stopPropagation();
            if (!current) {
              pushToast("没有可保存的预览图", "warn");
              return;
            }
            if (current.savedId) {
              pushToast("这张已经在图库里", "ok");
              return;
            }
            openStudioPop("album", e.currentTarget, true);
          }}
        >
          <IconFolderPlus />
        </button>
        <button
          className="sbtn"
          id="btn-download"
          type="button"
          title="下载"
          onClick={(e) => {
            e.stopPropagation();
            openStudioPop("download", e.currentTarget, true);
          }}
        >
          <IconDownload />
        </button>
        <button className="sbtn danger" id="btn-del-preview" type="button" title="从会话移除" onClick={deleteCurrent}>
          <IconTrash />
        </button>
      </div>
    </section>
  );
}
