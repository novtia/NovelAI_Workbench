/** 历史页的多选状态：选中的 key 集合 + 范围选择用的锚点。 */
export type Selection = {
  keys: ReadonlySet<string>;
  /** 最近一次普通点击 / Ctrl 点击的那张，Shift 范围从它开始。 */
  anchor: string | null;
};

export const EMPTY_SELECTION: Selection = { keys: new Set(), anchor: null };

export type ClickMods = { ctrl?: boolean; shift?: boolean };

function range(order: string[], a: string, b: string) {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/**
 * 按点击修饰键更新选中。order 是当前展示顺序（跨日期分区的扁平列表）。
 * - 普通点击：只选这一张
 * - Ctrl/Cmd：切换这一张
 * - Shift：锚点到这一张的整段；加 Ctrl 时是在已选基础上追加这一段
 */
export function applyClick(sel: Selection, order: string[], key: string, mods: ClickMods = {}): Selection {
  if (!order.includes(key)) return sel;
  if (mods.shift && sel.anchor && order.includes(sel.anchor)) {
    const span = range(order, sel.anchor, key);
    const keys = new Set(mods.ctrl ? sel.keys : []);
    for (const k of span) keys.add(k);
    // 锚点不动，连续 Shift 点击都从同一个起点算。
    return { keys, anchor: sel.anchor };
  }
  if (mods.ctrl) {
    const keys = new Set(sel.keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    return { keys, anchor: key };
  }
  return { keys: new Set([key]), anchor: key };
}

/** 右键：点在已选中的图上保持多选，否则只选这一张。 */
export function applyContext(sel: Selection, order: string[], key: string): Selection {
  if (!order.includes(key)) return sel;
  if (sel.keys.has(key)) return sel;
  return { keys: new Set([key]), anchor: key };
}

export function selectAll(order: string[]): Selection {
  return { keys: new Set(order), anchor: order[0] ?? null };
}

/** 列表变化（删除、翻页刷新）后，去掉已经不存在的选中项。 */
export function prune(sel: Selection, order: string[]): Selection {
  if (!sel.keys.size) return sel;
  const alive = new Set(order);
  let changed = false;
  const keys = new Set<string>();
  for (const k of sel.keys) {
    if (alive.has(k)) keys.add(k);
    else changed = true;
  }
  const anchor = sel.anchor && alive.has(sel.anchor) ? sel.anchor : null;
  if (!changed && anchor === sel.anchor) return sel;
  return { keys, anchor };
}

/** 按展示顺序取出选中项（菜单操作、批量保存都要稳定的顺序）。 */
export function pickSelected<T extends { key: string }>(items: T[], sel: Selection): T[] {
  return items.filter((it) => sel.keys.has(it.key));
}
