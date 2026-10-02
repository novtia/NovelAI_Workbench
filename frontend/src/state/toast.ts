import { getSettings } from "./settingsStore";

type Toast = { id: number; text: string; kind: "ok" | "warn" | "error" };

let seq = 1;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function pushToast(text: string, kind: Toast["kind"] = "ok") {
  const id = seq++;
  toasts = [...toasts, { id, text, kind }];
  emit();
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, getSettings().appearance.toastMs);
}

export function getToasts() {
  return toasts;
}

export function subscribeToasts(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
