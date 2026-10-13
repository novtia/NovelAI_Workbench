import { useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_SETTINGS, type Settings } from "@/data/settings";
import { useParamSetsQuery } from "@/state/queries";
import { useSettingsStore } from "@/state/settingsStore";
import type { Control, Option, SettingItem } from "./catalog";

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`s-switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="s-switch-knob" />
    </button>
  );
}

export function Segmented({
  options,
  value,
  onChange,
  disabled,
}: {
  options: Option[];
  value: unknown;
  onChange: (v: Option["value"]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="seg-bar s-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SelectBox({
  options,
  value,
  onChange,
  disabled,
}: {
  options: Option[];
  value: unknown;
  onChange: (v: Option["value"]) => void;
  disabled?: boolean;
}) {
  const idx = options.findIndex((o) => o.value === value);
  return (
    <select className="s-select" value={idx < 0 ? "" : String(idx)} disabled={disabled} onChange={(e) => onChange(options[Number(e.target.value)].value)}>
      {idx < 0 ? <option value="">{String(value)}</option> : null}
      {options.map((o, i) => (
        <option key={String(o.value)} value={String(i)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function formatValue(v: number, digits = 0, unit = "") {
  const text = digits ? v.toFixed(digits) : String(Math.round(v));
  return unit ? `${text} ${unit}` : text;
}

export function Slider({
  value,
  min,
  max,
  step,
  unit,
  digits,
  onChange,
  disabled,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  digits?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="s-slider">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="s-slider-val">{formatValue(value, digits, unit)}</span>
    </div>
  );
}

/** 文本框：输入时不立刻写设置（每个字符一次请求太碎），失焦或停手片刻后再提交。 */
export function TextBox({
  value,
  onChange,
  disabled,
  label,
  placeholder,
  rows = 2,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  label: string;
  placeholder?: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef(0);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const commit = (v: string) => {
    window.clearTimeout(timer.current);
    if (v !== value) onChange(v);
  };
  return (
    <textarea
      className="s-text"
      aria-label={label}
      rows={rows}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => {
        setDraft(e.target.value);
        window.clearTimeout(timer.current);
        const v = e.target.value;
        timer.current = window.setTimeout(() => commit(v), 600);
      }}
      onBlur={() => commit(draft)}
    />
  );
}

export function NumberBox({
  value,
  min,
  max,
  onChange,
  disabled,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  label: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft.trim() === "" || !Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, n));
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <input
      className="s-number"
      type="number"
      aria-label={label}
      min={min}
      max={max}
      step={1}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/** 选生图室里保存的预设；预设被删掉后仍显示成「已删除」，这时实际按自定义参数生图，改选即可恢复。 */
export function PresetSelect({ value, emptyLabel, onChange, disabled }: { value: string; emptyLabel: string; onChange: (v: string) => void; disabled?: boolean }) {
  const sets = useParamSetsQuery().data || [];
  const missing = value !== "" && !sets.some((s) => s.id === value);
  return (
    <select className="s-select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {missing ? <option value={value}>（预设已被删除）</option> : null}
      {sets.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

function getValue(settings: Settings, item: SettingItem): unknown {
  return (settings[item.section] as Record<string, unknown>)[item.key];
}

function defaultValue(item: SettingItem): unknown {
  return (DEFAULT_SETTINGS[item.section] as Record<string, unknown>)[item.key];
}

function ControlView({ control, value, onChange, disabled, label }: { control: Control; value: unknown; onChange: (v: never) => void; disabled: boolean; label: string }) {
  const emit = onChange as (v: unknown) => void;
  switch (control.kind) {
    case "switch":
      return <Switch checked={Boolean(value)} onChange={emit} disabled={disabled} label={label} />;
    case "segmented":
      return <Segmented options={control.options} value={value} onChange={emit} disabled={disabled} />;
    case "select":
      return <SelectBox options={control.options} value={value} onChange={emit} disabled={disabled} />;
    case "slider":
      return <Slider {...control} value={Number(value)} onChange={emit} disabled={disabled} label={label} />;
    case "text":
      return <TextBox value={String(value ?? "")} onChange={emit} disabled={disabled} label={label} placeholder={control.placeholder} rows={control.rows} />;
    case "preset":
      return <PresetSelect value={String(value ?? "")} emptyLabel={control.emptyLabel} onChange={emit} disabled={disabled} />;
    case "number":
      return <NumberBox value={Number(value)} min={control.min} max={control.max} onChange={emit} disabled={disabled} label={label} />;
  }
}

/** 一行设置：标题 + 说明 + 控件；与默认值不同时右侧出现「还原」。 */
export function SettingRow({ item }: { item: SettingItem }) {
  const settings = useSettingsStore((s) => s.settings);
  const set = useSettingsStore((s) => s.set);
  const value = getValue(settings, item);
  const def = defaultValue(item);
  const changed = value !== def;
  const disabled = item.disabledWhen ? item.disabledWhen(settings) : false;
  const write = (v: unknown) => (set as (s: string, k: string, v: unknown) => void)(item.section, item.key, v);
  return (
    <div className={`s-row${disabled ? " disabled" : ""}${changed ? " changed" : ""}`} data-setting={`${item.section}.${item.key}`}>
      <div className="s-row-text">
        <div className="s-row-label">
          {item.label}
          {changed ? <span className="s-dot" title="已修改" /> : null}
        </div>
        {item.hint ? <div className="s-row-hint">{item.hint}</div> : null}
        {item.note ? <div className="s-row-note">{item.note}</div> : null}
      </div>
      <div className="s-row-ctl">
        <ControlView control={item.control} value={value} onChange={write as never} disabled={disabled} label={item.label} />
        <button
          type="button"
          className="s-revert"
          title={`还原为默认值`}
          style={{ visibility: changed ? "visible" : "hidden" }}
          disabled={!changed}
          onClick={() => write(def)}
        >
          还原
        </button>
      </div>
    </div>
  );
}

export function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="s-card">
      <header className="s-card-head">
        <h3>{title}</h3>
        {right}
      </header>
      <div className="s-card-body">{children}</div>
    </section>
  );
}
