import { create } from "zustand";
import { settingsApi } from "@/api";
import {
  DEFAULT_SETTINGS,
  SETTINGS_CACHE_KEY,
  applyPatch,
  cloneSettings,
  mergePatch,
  mergeSettings,
  type SectionId,
  type Settings,
  type SettingsPatch,
} from "@/data/settings";
import { setControlsDefaultsProvider } from "@/data/lottery";
import { setFormDefaultsProvider } from "@/data/studio";
import { applySettingsToDom } from "@/ui/applySettings";

const SAVE_DELAY_MS = 320;

function loadCache(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
    if (raw) return mergeSettings(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return cloneSettings(DEFAULT_SETTINGS);
}

function saveCache(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

type SettingsState = {
  settings: Settings;
  /** 已从后端读到（或确认读取失败）；在这之前的修改只改本地，等读完再一起写。 */
  ready: boolean;
  saveError: string | null;
  hydrate: () => Promise<void>;
  update: (patch: SettingsPatch) => void;
  set: <S extends SectionId, K extends keyof Settings[S]>(section: S, key: K, value: Settings[S][K]) => void;
  reset: (section?: SectionId) => Promise<void>;
  replaceAll: (data: unknown) => Promise<void>;
};

let pending: SettingsPatch = {};
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<unknown> = Promise.resolve();

export const useSettingsStore = create<SettingsState>((set, get) => {
  function flush() {
    timer = null;
    if (!get().ready) return;
    const patch = pending;
    pending = {};
    if (!Object.keys(patch).length) return;
    inflight = inflight
      .then(() => settingsApi.putSettings(patch))
      .then((res) => {
        // 期间又有新修改时不覆盖本地，避免滑块来回跳
        if (!Object.keys(pending).length) set({ settings: mergeSettings(res.settings), saveError: null });
        else set({ saveError: null });
      })
      .catch((err) => {
        set({ saveError: err instanceof Error ? err.message : "设置保存失败" });
      });
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  }

  return {
    settings: loadCache(),
    ready: false,
    saveError: null,
    hydrate: async () => {
      try {
        const res = await settingsApi.getSettings();
        // 读取期间用户已改动的项以本地为准
        const remote = mergeSettings(res.settings);
        set({ settings: applyPatch(remote, pending), ready: true });
      } catch {
        set({ ready: true });
      }
      if (Object.keys(pending).length) schedule();
    },
    update: (patch) => {
      set((s) => ({ settings: applyPatch(s.settings, patch) }));
      pending = mergePatch(pending, patch);
      schedule();
    },
    set: (section, key, value) => {
      get().update({ [section]: { [key]: value } } as SettingsPatch);
    },
    reset: async (section) => {
      if (timer) clearTimeout(timer);
      pending = {};
      // 先本地立即生效
      set((s) => {
        const fresh = cloneSettings(DEFAULT_SETTINGS);
        if (!section) return { settings: fresh };
        return { settings: { ...s.settings, [section]: fresh[section] } };
      });
      try {
        const res = await inflight.then(() => settingsApi.resetSettings(section));
        set({ settings: mergeSettings(res.settings), saveError: null });
      } catch (err) {
        set({ saveError: err instanceof Error ? err.message : "重置失败" });
      }
    },
    replaceAll: async (data) => {
      if (timer) clearTimeout(timer);
      pending = {};
      const res = await inflight.then(() => settingsApi.importSettings(data));
      set({ settings: mergeSettings(res.settings), saveError: null });
    },
  };
});

/** 非 React 代码（toast、store 初始化、导入流程等）读取当前设置。 */
export function getSettings(): Settings {
  return useSettingsStore.getState().settings;
}

/** React 里按需订阅设置，例如 useSettings((s) => s.gallery.density)。 */
export function useSettings<T>(selector: (s: Settings) => T): T {
  return useSettingsStore((state) => selector(state.settings));
}

// 把设置里的默认值注入到数据层（表单默认值、抽奖台默认参数）
setFormDefaultsProvider(() => getSettings().generation);
setControlsDefaultsProvider(() => {
  const { min, max, draws, target, wmin, wmax, jitter, boost } = getSettings().lottery;
  return { min, max, draws, target, wmin, wmax, jitter, boost };
});

// 设置变化时：写本地缓存（首屏防闪烁）并落到 DOM
useSettingsStore.subscribe((state, prev) => {
  if (state.settings === prev.settings) return;
  saveCache(state.settings);
  applySettingsToDom(state.settings);
});
applySettingsToDom(useSettingsStore.getState().settings);

if (typeof matchMedia === "function") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (getSettings().appearance.theme === "auto") applySettingsToDom(getSettings());
  });
}
