import { useLottery } from "@/state";

export function PresetBar() {
  const { presetId, setPreset, sets } = useLottery();
  const empty = !sets.length;
  return (
    <section className="l-console lot-gen">
      <div className="lot-preset-row">
        <label className="field">
          <span>生图预设</span>
          <select value={presetId} onChange={(e) => setPreset(e.target.value)}>
            <option value="">{empty ? "暂无预设，请先在生图室保存" : "请选择预设"}</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <p className="lot-preset-hint">
          {empty
            ? "还没有预设。保存当前生图参数后，抽奖台可直接选用。"
            : "在生图室保存参数套。抽奖生图使用选中预设，画师串默认加在最前，预设 Prompt 里写 &lt;插入位置:抽奖,图库&gt;（英文冒号逗号）可指定插入位置；切换页面不会中断队列。"}
        </p>
      </div>
    </section>
  );
}
