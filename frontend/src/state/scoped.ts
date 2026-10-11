import { useSyncExternalStore } from "react";
import { create, type StateCreator, type StoreApi } from "zustand";

/**
 * 按标签隔离的 store。
 *
 * 每个标签 id 对应一个真正的 zustand store（懒创建，存在 registry 里）。
 * 导出的「外观」保持 zustand 的用法：`useXxx(selector)`、`useXxx.getState()`、`useXxx.setState()`、`useXxx.subscribe()`，
 * 全部委托给「当前标签」的 store，所以现有调用点不用改。
 *
 * - 组件、订阅跟随「激活标签」：切换标签时会自动重新订阅并重新读取。
 * - `getState` / `setState` 跟随「当前标签」：默认是激活标签，`runInTab(id, fn)` 期间是指定标签，
 *   用来让后台标签的任务同步、异步回写落在正确的标签上（只覆盖 fn 的同步部分，await 之后要再包一次）。
 * - 关闭标签时 `disposeTab(id)` 销毁它所有 store，之后对该 id 的访问只会拿到一次性的游离 store，不会泄漏。
 */

export const MAIN_TAB_ID = "main";

let activeTabId = MAIN_TAB_ID;
let override: string | null = null;
const switchListeners = new Set<() => void>();
const disposers = new Set<(id: string) => void>();
const dead = new Set<string>();

/** 激活标签（界面正在渲染的那个）。 */
export function activeTab() {
  return activeTabId;
}

/** 当前标签：`runInTab` 期间是指定标签，否则是激活标签。 */
export function currentTabId() {
  return override ?? activeTabId;
}

export function setActiveTab(id: string) {
  if (id === activeTabId) return;
  activeTabId = id;
  for (const fn of Array.from(switchListeners)) fn();
}

export function onActiveTabChange(fn: () => void) {
  switchListeners.add(fn);
  return () => {
    switchListeners.delete(fn);
  };
}

/** 在指定标签的上下文里同步执行 fn。 */
export function runInTab<T>(tabId: string, fn: () => T): T {
  const prev = override;
  override = tabId;
  try {
    return fn();
  } finally {
    override = prev;
  }
}

/** 返回一个绑定到「调用时的标签」的包装，用于异步流程里 await 之后回写。 */
export function bindToTab<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const tabId = currentTabId();
  return (...args) => runInTab(tabId, () => fn(...args));
}

/** 销毁某个标签下所有的 store。 */
export function disposeTab(id: string) {
  dead.add(id);
  for (const drop of disposers) drop(id);
}

export type TabScopedStore<T> = {
  (): T;
  <U>(selector: (state: T) => U): U;
  getState: () => T;
  setState: StoreApi<T>["setState"];
  subscribe: StoreApi<T>["subscribe"];
  /** 指定标签的底层 store（没有就创建）。 */
  forTab: (id: string) => StoreApi<T>;
  /** 已经创建过 store 的标签 id。 */
  tabIds: () => string[];
};

export function createTabScopedStore<T>(init: (tabId: string) => StateCreator<T>): TabScopedStore<T> {
  const registry = new Map<string, StoreApi<T>>();

  function forTab(id: string): StoreApi<T> {
    let store = registry.get(id);
    if (store) return store;
    store = create<T>(init(id));
    if (!dead.has(id)) registry.set(id, store);
    return store;
  }

  disposers.add((id) => {
    registry.delete(id);
  });

  const getState = () => forTab(currentTabId()).getState();

  function subscribe(listener: (state: T, prev: T) => void) {
    let off = forTab(activeTabId).subscribe(listener);
    // 切换标签只换订阅对象，不触发 listener。
    const rebind = () => {
      off();
      off = forTab(activeTabId).subscribe(listener);
    };
    switchListeners.add(rebind);
    return () => {
      switchListeners.delete(rebind);
      off();
    };
  }

  function subscribeHook(cb: () => void) {
    let off = forTab(activeTabId).subscribe(cb);
    const onSwitch = () => {
      off();
      off = forTab(activeTabId).subscribe(cb);
      cb();
    };
    switchListeners.add(onSwitch);
    return () => {
      switchListeners.delete(onSwitch);
      off();
    };
  }

  function hook<U>(selector?: (state: T) => U): U | T {
    const pick = selector ?? ((s: T) => s as unknown as U);
    return useSyncExternalStore(
      subscribeHook,
      () => pick(forTab(activeTabId).getState()),
      () => pick(forTab(activeTabId).getState()),
    );
  }

  const facade = hook as unknown as TabScopedStore<T>;
  facade.getState = getState;
  facade.setState = ((partial: unknown, replace?: boolean) =>
    (forTab(currentTabId()).setState as (p: unknown, r?: boolean) => void)(partial, replace)) as StoreApi<T>["setState"];
  facade.subscribe = subscribe;
  facade.forTab = forTab;
  facade.tabIds = () => Array.from(registry.keys());
  return facade;
}
