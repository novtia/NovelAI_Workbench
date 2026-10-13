import type { ReactNode } from "react";

/** 一个可点的菜单项。有 children 时是二级菜单入口，自己不再触发 onSelect。 */
export type MenuItem = {
  id?: string;
  label: string;
  icon?: ReactNode;
  /** 右侧的提示文字，比如快捷键。 */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
  /** 二级菜单。写成函数时，打开这个子菜单才去取列表。 */
  children?: MenuEntry[] | (() => MenuEntry[]);
};

export type MenuSeparator = { separator: true };
export type MenuEntry = MenuItem | MenuSeparator;

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return "separator" in entry && entry.separator === true;
}

/**
 * 某个界面往某个 scope 注册的一组菜单项。
 * 同一个 scope 可以有多个来源；按 group、order 排序，不同 group 之间自动加分隔线。
 */
export type MenuDef<C = unknown> = {
  /** 同一个 scope 里唯一；重复注册同一个 id 会覆盖旧的。 */
  id: string;
  group?: number;
  order?: number;
  /** 返回 null 或空数组表示这次不显示。 */
  build: (ctx: C) => MenuItem[] | null | undefined;
};

type Stored = { def: MenuDef<any>; seq: number };

const scopes = new Map<string, Map<string, Stored>>();
let counter = 0;

/** 注册菜单项，返回注销函数。 */
export function registerMenu<C>(scope: string, def: MenuDef<C>): () => void {
  let list = scopes.get(scope);
  if (!list) {
    list = new Map();
    scopes.set(scope, list);
  }
  const stored: Stored = { def, seq: ++counter };
  list.set(def.id, stored);
  return () => {
    const cur = scopes.get(scope);
    // 只注销自己：期间被同 id 覆盖过的，不能误删新的。
    if (cur?.get(def.id) === stored) cur.delete(def.id);
  };
}

/** 汇总一个 scope 下所有已注册的菜单项，组与组之间插分隔线。 */
export function resolveMenu(scope: string, ctx: unknown): MenuEntry[] {
  const list = scopes.get(scope);
  if (!list) return [];
  const defs = [...list.values()].sort(
    (a, b) =>
      (a.def.group ?? 0) - (b.def.group ?? 0) || (a.def.order ?? 0) - (b.def.order ?? 0) || a.seq - b.seq,
  );
  const out: MenuEntry[] = [];
  let lastGroup: number | null = null;
  for (const { def } of defs) {
    const items = def.build(ctx);
    if (!items || !items.length) continue;
    const group = def.group ?? 0;
    if (lastGroup !== null && group !== lastGroup) out.push({ separator: true });
    out.push(...items);
    lastGroup = group;
  }
  return out;
}

/** 取一个菜单项的二级菜单内容。 */
export function childrenOf(item: MenuItem): MenuEntry[] {
  const c = item.children;
  if (!c) return [];
  return typeof c === "function" ? c() : c;
}

/** 去掉首尾和连续的分隔线。 */
export function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (isSeparator(e) && (!out.length || isSeparator(out[out.length - 1]))) continue;
    out.push(e);
  }
  while (out.length && isSeparator(out[out.length - 1])) out.pop();
  return out;
}

/** 测试用：清空所有注册。 */
export function resetMenus() {
  scopes.clear();
}
