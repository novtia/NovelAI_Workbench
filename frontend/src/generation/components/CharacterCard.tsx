import { memo } from "react";
import { inferGender } from "@/data";
import { useStudioActions, useStudioStore } from "@/state";
import type { Character } from "@/data/types";
import { GenderSvg, IconCheck, IconDown, IconTrash, IconUp } from "./icons";
import { PromptWell, TokenBar } from "./PromptWell";

export const CharacterCard = memo(function CharacterCard({ ch, index }: { ch: Character; index: number }) {
  const tab = useStudioStore((s) => s.charTabs[index] || "prompt");
  const setCharTab = useStudioStore((s) => s.setCharTab);
  const { patch, mutateChar } = useStudioActions();
  const gender = inferGender(ch.prompt);
  const enabled = ch.enabled !== false;

  function move(dir: -1 | 1) {
    const chars = useStudioStore.getState().form.characters;
    const j = index + dir;
    if (j < 0 || j >= chars.length) return;
    const next = chars.slice();
    const [c] = next.splice(index, 1);
    next.splice(j, 0, c);
    patch({ characters: next });
  }

  return (
    <article className={`char-card${enabled ? "" : " disabled"}`} data-g={gender} data-i={index}>
      <div className="char-bar">
        <span className={`gender${gender === "m" ? " male" : gender === "o" ? " other" : ""}`} title={gender === "m" ? "boy" : gender === "o" ? "other" : "girl"}>
          <GenderSvg g={gender} />
        </span>
        <span className="name">角色 {index + 1}</span>
        <span className="grow" />
        <button className="ico" type="button" title="上移" onClick={() => move(-1)}>
          <IconUp />
        </button>
        <button className="ico" type="button" title="下移" onClick={() => move(1)}>
          <IconDown />
        </button>
        <button
          className={`ico ${enabled ? "ok" : "off"}`}
          type="button"
          title={enabled ? "已启用" : "已停用"}
          onClick={() => mutateChar(index, (c) => ({ ...c, enabled: !enabled }))}
        >
          <IconCheck />
        </button>
        <button className="ico danger" type="button" title="删除" onClick={() => patch({ characters: useStudioStore.getState().form.characters.filter((_, i) => i !== index) })}>
          <IconTrash />
        </button>
      </div>
      <div className="char-body">
        <div className="tabs">
          <button className={`tab${tab === "prompt" ? " on" : ""}`} type="button" onClick={() => setCharTab(index, "prompt")}>
            提示词
          </button>
          <button className={`tab${tab === "uc" ? " on" : ""}`} type="button" onClick={() => setCharTab(index, "uc")}>
            负面提示
          </button>
        </div>
        <div className="prompt-box sm">
          {tab === "uc" ? (
            <PromptWell value={ch.uc} onChange={(v) => mutateChar(index, (c) => ({ ...c, uc: v }))} placeholder="Negative / UC" />
          ) : (
            <PromptWell
              value={ch.prompt}
              onChange={(v) => {
                mutateChar(index, (c) => ({ ...c, prompt: v, gender: inferGender(v) }));
              }}
              placeholder={`角色 ${index + 1}`}
            />
          )}
          <TokenBar text={tab === "uc" ? ch.uc : ch.prompt} label={`角色 ${index + 1} ${tab === "uc" ? "负面提示" : "提示词"}`} />
        </div>
      </div>
    </article>
  );
});
