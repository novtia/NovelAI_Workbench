import { SAMPLER_LABEL } from "@/data/studio";
import { accountLabel, costLabel, genLabel, formatTokenStatus } from "@/data";
import { openStudioPop, useStudio } from "@/state";
import { IconBolt, IconCollapse, IconExpand, IconReset, IconSeed, IconX } from "./icons";

export function ParamDock() {
  const {
    form,
    patch,
    busy,
    genProgress,
    aiOpen,
    aiSettled,
    status,
    generate,
    resetParams,
    setAiOpen,
  } = useStudio();
  const random = form.seed < 0;
  const opus = Boolean(status?.subscription?.opus);
  const pct = status?.subscription?.usagePercent;
  const showQuota = Boolean(status?.subscription);
  const quotaText =
    opus && pct != null
      ? status?.subscription?.usageNegative
        ? `Opus 额度已超额（${Math.max(0, Math.min(100, Number(pct)))}%）`
        : `剩余 ${Math.round(Math.max(0, Math.min(100, Number(pct))))}% Opus 额度`
      : status?.subscription && !opus
        ? `Anlas ${status.subscription.anlas}（非 Opus）`
        : "";

  function rollSeed() {
    patch({ seed: Math.floor(Math.random() * 4294967295) });
  }

  return (
    <div className="left-foot">
      <section className={`card ai-set${aiOpen ? " open" : ""}${aiSettled ? " is-settled" : ""}`} id="ai-set">
        <div className="ai-compact-slot">
          <div className="ai-compact" id="ai-compact" inert={aiOpen || undefined}>
            <div className="ai-compact-main">
              <div className="param-grid">
                <span className="lab">步数</span>
                <span className="lab">引导</span>
                <span className="lab">种子</span>
                <span className="lab">采样器</span>
                <input className="val" type="number" min={1} max={50} value={form.steps} onChange={(e) => patch({ steps: Number(e.target.value) })} />
                <input className="val" type="number" min={0} max={30} step={0.1} value={form.scale} onChange={(e) => patch({ scale: Number(e.target.value) })} />
                <div className={`val seed-box${random ? " is-random" : ""}`} id="seed-box">
                  <button className="seed-toggle" type="button" title={random ? "生成并锁定种子" : "恢复随机种子"} onClick={() => (random ? rollSeed() : patch({ seed: -1 }))}>
                    <IconSeed />
                    <span className="seed-num">{random ? "" : String(Math.trunc(form.seed))}</span>
                  </button>
                  <input id="gen-seed" type="number" min={-1} step={1} value={form.seed} tabIndex={-1} onChange={(e) => patch({ seed: Number(e.target.value) })} title="种子，-1 为随机" />
                </div>
                <div className="val" id="sampler-trigger">
                  <button
                    type="button"
                    id="sampler-label"
                    onClick={(e) => {
                      e.stopPropagation();
                      openStudioPop("sampler", e.currentTarget, true);
                    }}
                  >
                    {SAMPLER_LABEL[form.sampler] || form.sampler}
                  </button>
                </div>
              </div>
              <div className="cfg">
                <span>CFG 重缩放</span>
                <input type="number" min={0} max={1} step={0.05} value={form.cfgRescale} onChange={(e) => patch({ cfgRescale: Number(e.target.value) })} />
              </div>
            </div>
            <button className={`play${aiOpen ? " on" : ""}`} type="button" title="展开参数设置" onClick={() => setAiOpen(true)}>
              <IconExpand />
            </button>
          </div>
        </div>
        <div className="ai-panel-slot">
          <div className="ai-panel" id="ai-panel" inert={!aiOpen || undefined}>
            <div className="ai-panel-head">
              <span>参数设置</span>
              <button className="ico" type="button" title="重置参数" onClick={resetParams}>
                <IconReset />
              </button>
              <button className="play" type="button" title="收起" onClick={() => setAiOpen(false)}>
                <IconCollapse />
              </button>
            </div>
            <label className="ai-field">
              步数
              <div className="ai-slide">
                <input className="ai-box" type="number" min={1} max={50} step={1} value={form.steps} onChange={(e) => patch({ steps: Number(e.target.value) })} />
                <input type="range" min={1} max={50} step={1} value={form.steps} onChange={(e) => patch({ steps: Number(e.target.value) })} />
              </div>
            </label>
            <label className="ai-field">
              引导
              <div className="ai-slide">
                <input className="ai-box" type="number" min={0} max={30} step={0.1} value={form.scale} onChange={(e) => patch({ scale: Number(e.target.value) })} />
                <input type="range" min={0} max={30} step={0.1} value={form.scale} onChange={(e) => patch({ scale: Number(e.target.value) })} />
              </div>
            </label>
            <div className="ai-seed-row">
              <label className="ai-field">
                种子
                <div className={`ai-seed-box${random ? " is-random" : ""}`}>
                  <input
                    className="ai-box grow"
                    type="number"
                    min={0}
                    step={1}
                    value={random ? "" : form.seed}
                    placeholder="随机"
                    onChange={(e) => {
                      if (e.target.value === "") return;
                      const n = Number(e.target.value);
                      if (!Number.isFinite(n) || n < 0) return;
                      patch({ seed: Math.trunc(n) });
                    }}
                    onBlur={(e) => {
                      const n = Number(e.target.value);
                      if (e.target.value === "" || !Number.isFinite(n) || n < 0) patch({ seed: -1 });
                    }}
                  />
                  <button className="seed-face" type="button" title="生成并锁定种子" onClick={rollSeed}>
                    <IconSeed />
                  </button>
                  <button className="seed-clear" type="button" title="恢复随机种子" onClick={() => patch({ seed: -1 })}>
                    <IconX />
                  </button>
                </div>
              </label>
              <label className="ai-field">
                采样器
                <button
                  className="ai-sampler"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openStudioPop("sampler", e.currentTarget, true);
                  }}
                >
                  {SAMPLER_LABEL[form.sampler] || form.sampler}
                </button>
              </label>
            </div>
            <details className="ai-adv">
              <summary>高级设置</summary>
              <div className="extra show">
                <label>
                  调度
                  <select value={form.noiseSchedule} onChange={(e) => patch({ noiseSchedule: e.target.value })}>
                    <option value="karras">karras</option>
                    <option value="exponential">exponential</option>
                    <option value="polyexponential">polyexponential</option>
                  </select>
                </label>
                <label>
                  SMEA
                  <select disabled title="V5 文生图暂不发送">
                    <option>关闭</option>
                  </select>
                </label>
              </div>
            </details>
            <label className="ai-field">
              CFG 重缩放
              <div className="ai-slide">
                <input className="ai-box" type="number" min={0} max={1} step={0.05} value={form.cfgRescale} onChange={(e) => patch({ cfgRescale: Number(e.target.value) })} />
                <input type="range" min={0} max={1} step={0.05} value={form.cfgRescale} onChange={(e) => patch({ cfgRescale: Number(e.target.value) })} />
              </div>
            </label>
          </div>
        </div>
      </section>
      <div className="quota" hidden={!showQuota}>
        <div className="row">
          <span>{quotaText || formatTokenStatus(status) || accountLabel(status)}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const trig = document.getElementById("st-account");
              if (trig) openStudioPop("token", trig);
            }}
          >
            详情
          </button>
        </div>
        <i className="bar" style={{ width: opus && pct != null ? `${Math.max(0, Math.min(100, Number(pct)))}%` : "0%" }} />
      </div>
      <p className="gen-bg-hint">后台执行 · 切换页面不会中断</p>
      <button className={`gen${busy ? " busy" : ""}`} type="button" onClick={() => void generate()} disabled={busy}>
        <span>{genLabel(form.nSamples, busy, genProgress || (busy ? "排队中" : ""))}</span>
        <span className="cost">
          {costLabel(status)}
          <IconBolt />
        </span>
      </button>
    </div>
  );
}
