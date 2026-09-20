import type { KeyboardEvent } from "react";
import { Dices } from "lucide-react";
import { useLottery } from "@/state";
import { ConsoleField } from "./ConsoleField";

export function LotteryConsole() {
  const { controls, patchControls, roll, boundMin, boundMax } = useLottery();

  function onEnter(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void roll();
    }
  }

  return (
    <div className="l-console">
      <div className="l-fields">
        <ConsoleField label="画师数 min" min={boundMin} max={boundMax} step={1} value={controls.min} onChange={(min) => patchControls({ min })} onKeyDown={onEnter} />
        <ConsoleField label="画师数 max" min={boundMin} max={boundMax} step={1} value={controls.max} onChange={(max) => patchControls({ max })} onKeyDown={onEnter} />
        <ConsoleField label="条数" min={1} max={50} step={1} value={controls.draws} onChange={(draws) => patchControls({ draws })} onKeyDown={onEnter} />
        <ConsoleField label="目标和" min={0.01} step={0.01} value={controls.target} onChange={(target) => patchControls({ target })} onKeyDown={onEnter} />
        <ConsoleField label="最小权重" min={0.01} max={99} step={0.01} value={controls.wmin} onChange={(wmin) => patchControls({ wmin })} onKeyDown={onEnter} />
        <ConsoleField label="最大权重" min={0.01} max={99} step={0.01} value={controls.wmax} onChange={(wmax) => patchControls({ wmax }, true)} onKeyDown={onEnter} />
        <div className="slider-field">
          <span>随机幅度</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(controls.jitter * 100)}
            onChange={(e) => patchControls({ jitter: Number(e.target.value) / 100 })}
            onKeyDown={onEnter}
          />
          <output>{Math.round(controls.jitter * 100)}%</output>
        </div>
      </div>
      <button className="btn btn-primary l-run" type="button" onClick={() => void roll()}>
        <Dices strokeWidth={2} />
        开始抽奖
      </button>
    </div>
  );
}
