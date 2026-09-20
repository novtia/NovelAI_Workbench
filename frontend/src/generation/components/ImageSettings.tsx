import { PRESET_LABEL } from "@/data/studio";
import { useStudio } from "@/state";
import { IconChevron, IconLand, IconPort, IconSquare } from "./icons";

export function ImageSettings() {
  const { form, sizeLabel, setSize, patch, openDd, setOpenDd } = useStudio();
  return (
    <section>
      <div className="sec-label">图像设置</div>
      <div className="res-row">
        <span className="k">分辨率</span>
        <span className="size-box">{sizeLabel}</span>
      </div>
      <div className="aspect-row">
        <div className={`dd${openDd === "preset" ? " open" : ""}`} id="dd-preset">
          <button className="preset" type="button" onClick={() => setOpenDd(openDd === "preset" ? "" : "preset")}>
            <span>{PRESET_LABEL[form.preset]}</span>
            <IconChevron />
          </button>
          <div className="dd-menu">
            {(Object.keys(PRESET_LABEL) as Array<keyof typeof PRESET_LABEL>).map((k) => (
              <button key={k} type="button" className={form.preset === k ? "on" : ""} onClick={() => { setSize(k, form.aspect); setOpenDd(""); }}>
                {PRESET_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
        <div className="seg-bar" id="aspect-bar">
          <button type="button" className={form.aspect === "land" ? "on" : ""} title="横图" onClick={() => setSize(form.preset, "land")}>
            <IconLand />
          </button>
          <button type="button" className={form.aspect === "port" ? "on" : ""} title="竖图" onClick={() => setSize(form.preset, "port")}>
            <IconPort />
          </button>
          <button type="button" className={form.aspect === "square" ? "on" : ""} title="方图" onClick={() => setSize(form.preset, "square")}>
            <IconSquare />
          </button>
        </div>
      </div>
      <div className="nimg-wrap">
        <div className="nimg-label">生成张数</div>
        <div className="seg-bar nimg">
          {[1, 2, 3, 4].map((n) => (
            <button key={n} type="button" className={form.nSamples === n ? "on" : ""} onClick={() => patch({ nSamples: n })}>
              {n}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
