import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { findFormulas, formulaItems, previewFormula, stepsUntilEnd, uniqueFormulas } from "@/data";
import { useStudioStore, useTagCounters } from "@/state";
import { armArtistLibrary, useArtistLibrary } from "@/ui/ArtistHover";

function short(list: string[]) {
  if (!list.length) return "-";
  const s = list.join(", ");
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** 参数设置里的「标签公式」下拉：列出 Prompt 里写的所有公式及当前进度。 */
export function TagFormulaPanel() {
  const text = useStudioStore(useShallow((s) => [s.form.prompt, ...s.form.characters.map((c) => c.prompt || "")].join("\n")));
  const counters = useTagCounters((s) => s.counters);
  const loops = useTagCounters((s) => s.loops);
  const running = useTagCounters((s) => s.running);
  const { setIndex, reset, setLoop } = useTagCounters.getState();
  const library = useArtistLibrary();
  const formulas = useMemo(() => uniqueFormulas(findFormulas(text)), [text]);
  useEffect(() => {
    if (formulas.some((f) => f.kind === "pool")) armArtistLibrary();
  }, [formulas]);

  return (
    <details className="ai-adv tag-formula">
      <summary>标签公式（{formulas.length}）</summary>
      <div className="tf-list">
        {formulas.length === 0 ? (
          <p className="tf-empty">在 Prompt 里写 &lt;画师&gt;，每次生图按 a-z 前进一位。&lt;画师:随机&gt; 随机取，&lt;画师:3&gt; 一次取 3 个，&lt;a|b|c&gt; 自定义列表。</p>
        ) : (
          formulas.map((f) => {
            const total = formulaItems(f, library).length;
            const p = previewFormula(f, library, counters);
            const step = f.mode === "rand" ? 0 : f.step;
            const looping = Boolean(loops[f.key]);
            const left = stepsUntilEnd(f, library, counters);
            return (
              <div className="tf-card" key={f.raw}>
                <div className="tf-head">
                  <code>{f.raw}</code>
                  <span className="tf-pos">{f.mode === "rand" ? "随机" : total ? `${p.index + 1} / ${total}` : "画师库为空"}</span>
                </div>
                {total > 0 && (
                  <div className="tf-body">
                    <div>
                      本次：<b>{f.mode === "rand" ? "随机一个" : short(p.current)}</b>
                    </div>
                    {f.mode !== "rand" && <div>下次：{short(p.next)}</div>}
                  </div>
                )}
                {step > 0 && total > 0 && (
                  <>
                    {looping && <div className="tf-loop">循环中 · 剩余 {left}</div>}
                    <div className="tf-actions">
                      <button type="button" onClick={() => setIndex(f.key, p.index - step + total)}>
                        上一位
                      </button>
                      <button type="button" onClick={() => setIndex(f.key, p.index + step)}>
                        下一位
                      </button>
                      <button type="button" onClick={() => reset(f.key)}>
                        重置
                      </button>
                      <button type="button" className={looping ? "on" : ""} onClick={() => setLoop(f.key, running && looping ? false : !looping)}>
                        {running && looping ? "停止" : "循环"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </details>
  );
}
