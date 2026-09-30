import { copyText } from "@/data";
import { QUALITY_LABEL, UC } from "@/data/studio";
import { useShallow } from "zustand/react/shallow";
import { pushToast, useStudioActions, useStudioStore } from "@/state";
import { IconChevron, IconCopy, IconX } from "./icons";
import { PromptWell, TokenBar } from "./PromptWell";

export function PromptCard() {
  const form = useStudioStore(useShallow((s) => ({ prompt: s.form.prompt, uc: s.form.uc, straightAlpha: s.form.straightAlpha, quality: s.form.quality })));
  const promptTab = useStudioStore((s) => s.promptTab);
  const openDd = useStudioStore((s) => s.openDd);
  const setPromptTab = useStudioStore((s) => s.setPromptTab);
  const setOpenDd = useStudioStore((s) => s.setOpenDd);
  const patch = useStudioActions().patch;
  const active = promptTab === "uc" ? form.uc : form.prompt;

  return (
    <section className="card prompt-card">
      <div className="tabs">
        <button className={`tab${promptTab === "base" ? " on" : ""}`} type="button" onClick={() => setPromptTab("base")}>
          主体提示词
        </button>
        <button className={`tab${promptTab === "uc" ? " on" : ""}`} type="button" onClick={() => setPromptTab("uc")}>
          负面提示
        </button>
        <span className="grow" />
        <button
          className="ico"
          type="button"
          title="复制提示词"
          onClick={async () => {
            pushToast((await copyText(active)) ? "已复制" : "没有可复制的内容", active ? "ok" : "warn");
          }}
        >
          <IconCopy />
        </button>
      </div>
      <div className="prompt-box">
        {promptTab === "uc" ? (
          <PromptWell value={form.uc} onChange={(v) => patch({ uc: v })} placeholder="Negative / UC" />
        ) : (
          <PromptWell value={form.prompt} onChange={(v) => patch({ prompt: v })} placeholder="画师串、场景、画质、自然语言…" />
        )}
        <div className="prompt-tools" hidden={promptTab !== "base"}>
          <button
            className={`chip${form.straightAlpha ? " on" : ""}`}
            type="button"
            onClick={() => patch({ straightAlpha: !form.straightAlpha })}
          >
            <IconX />
            透明背景
          </button>
          <span className="grow" />
          <div className={`dd right${openDd === "qtags" ? " open" : ""}`} id="dd-qtags">
            <button className="qtags" type="button" onClick={() => setOpenDd(openDd === "qtags" ? "" : "qtags")}>
              质量词：<span>{QUALITY_LABEL[form.quality]}</span>
              <IconChevron />
            </button>
            <div className="dd-menu">
              {(Object.keys(QUALITY_LABEL) as Array<keyof typeof QUALITY_LABEL>).map((k) => (
                <button key={k} type="button" className={form.quality === k ? "on" : ""} onClick={() => { patch({ quality: k }); setOpenDd(""); }}>
                  {QUALITY_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="prompt-tools" hidden={promptTab !== "uc"}>
          <div className="gen-presets">
            <button type="button" onClick={() => patch({ uc: UC.heavy })}>
              Heavy
            </button>
            <button type="button" onClick={() => patch({ uc: UC.comic })}>
              漫画
            </button>
            <button type="button" onClick={() => patch({ uc: "" })}>
              清空
            </button>
          </div>
        </div>
        <TokenBar text={active} label={promptTab === "uc" ? "负面提示" : "主体提示词"} />
      </div>
    </section>
  );
}
