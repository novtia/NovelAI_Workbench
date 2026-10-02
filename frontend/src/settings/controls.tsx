import type { ReactNode } from "react";
import { DEFAULT_SETTINGS, type Settings } from "@/data/settings";
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
