import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import { registerMenu, resolveMenu, type MenuDef } from "./registry";
import { useContextMenuStore } from "./store";

/**
 * 给当前界面往某个 scope 注册菜单项，卸载时自动注销。
 * def.build 每次打开菜单时调用，总是用最新一次渲染的闭包，所以可以直接读 state。
 */
export function useRegisterMenu<C>(scope: string, def: MenuDef<C>) {
  const ref = useRef(def);
  ref.current = def;
  const { id, group, order } = def;
  useEffect(
    () =>
      registerMenu<C>(scope, {
        id,
        group,
        order,
        build: (ctx) => ref.current.build(ctx),
      }),
    [scope, id, group, order],
  );
}

/**
 * 返回绑到元素上的 onContextMenu。getCtx 在菜单打开前调用，可以顺便调整选中状态；
 * 返回 false 表示这次不弹菜单（让浏览器默认菜单也不出现）。
 * 菜单项为空时不弹。
 */
export function useContextMenu<C>(scope: string, getCtx: (e: MouseEvent) => C | false) {
  const openMenu = useContextMenuStore((s) => s.openMenu);
  const ref = useRef(getCtx);
  ref.current = getCtx;
  return useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      // 子元素先弹了自己的菜单，就不让外层的再弹一次。
      e.stopPropagation();
      const ctx = ref.current(e);
      if (ctx === false) return;
      openMenu(e.clientX, e.clientY, resolveMenu(scope, ctx));
    },
    [scope, openMenu],
  );
}

/** 菜单打开期间的全局关闭条件：点到别处、滚动、缩放、失焦。 */
export function useMenuDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => t instanceof Element && Boolean(t.closest("[data-ctx-menu]"));
    const onDown = (e: Event) => {
      if (!inside(e.target)) close();
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) close();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("contextmenu", onDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("contextmenu", onDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open, close]);
}
