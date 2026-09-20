import type { KeyboardEvent } from "react";

export function ConsoleField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onKeyDown,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}
