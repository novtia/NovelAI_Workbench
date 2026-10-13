import type { Settings } from "./settings";
import { SIZES, UC, formToPayload } from "./studio";
import type { ParamSet, StudioForm } from "./types";

/** 设置里「画师测试」分区 → 一张生图表单（每位画师 1 张）。 */
export function artistTestForm(s: Settings["artistTest"]): StudioForm {
  const [width, height] = SIZES[s.preset][s.aspect];
  const character = s.character.trim();
  return {
    prompt: s.prompt.trim(),
    uc: UC[s.ucPreset],
    characters: character ? [{ prompt: character, uc: "", x: 0.5, y: 0.5 }] : [],
    model: s.model,
    effort: s.effort,
    v5Mode: s.v5Mode,
    quality: s.quality,
    width,
    height,
    sampler: s.sampler,
    noiseSchedule: s.noiseSchedule,
    steps: s.steps,
    scale: s.scale,
    cfgRescale: s.cfgRescale,
    seed: s.seed,
    nSamples: 1,
    useCoords: false,
    straightAlpha: true,
    aspect: s.aspect,
    preset: s.preset,
  };
}

/**
 * 画师测试实际用的表单：选了生图预设就直接套用预设（每位画师 1 张；预设里没有角色时补上设置里的角色提示词），
 * 没选或预设已被删除就用设置里的自定义参数。
 */
export function resolveArtistTestForm(s: Settings["artistTest"], presets: ParamSet[]): { form: StudioForm; preset: ParamSet | null } {
  const preset = s.presetId ? presets.find((p) => p.id === s.presetId) || null : null;
  if (!preset) return { form: artistTestForm(s), preset: null };
  const form: StudioForm = { ...preset.form, nSamples: 1, characters: (preset.form.characters || []).map((c) => ({ ...c })) };
  const character = s.character.trim();
  if (character && !form.characters.some((c) => String(c.prompt || "").trim())) {
    form.characters = [{ prompt: character, uc: "", x: 0.5, y: 0.5 }];
  }
  return { form, preset };
}

/** 测试集下拉里「默认测试参数」这一项的 id：不对应任何已保存的预设。 */
export const ARTIST_TEST_PRESET_ID = "__artist-test__";
export const ARTIST_TEST_PRESET_NAME = "默认测试参数";

/** 给缺图的画师补一张图的任务：完成后后端直接存进目标收藏夹（单画师）。 */
export function artistQuickPayload(form: StudioForm, albumId: string, name: string, artistLine: string) {
  return {
    ...formToPayload(form, { artists: artistLine, source: "gallery" }),
    source: "gallery",
    client: {
      targetAlbumId: albumId,
      artist: name,
      artists: [name],
      artistLine,
      form,
    },
  };
}

/** 任务属于哪位画师：补图任务的 client.artists[0]。 */
export function quickJobTarget(client: Record<string, unknown> | undefined | null) {
  if (!client || !client.targetAlbumId) return null;
  const artists = Array.isArray(client.artists) ? client.artists : [];
  const name = String(artists[0] || client.artist || "");
  return name ? { albumId: String(client.targetAlbumId), name } : null;
}
