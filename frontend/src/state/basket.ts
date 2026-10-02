import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { galleryApi } from "@/api";
import { basketAdd, basketHasAll, basketRemove, basketText, normalizeBasketNames } from "@/data/artistBasket";
import { copyText } from "@/data/artwork";
import { queryKeys } from "@/data/queryKeys";
import type { BasketArtist } from "@/data/types";
import { useSession } from "./session";
import { getSettings } from "./settingsStore";
import { pushToast } from "./toast";

const EMPTY: BasketArtist[] = [];

/** 所有写请求串行发出；乐观更新立刻生效，最后一个请求返回时才用服务端结果校准，避免连点时闪烁。 */
let chain: Promise<unknown> = Promise.resolve();
let pending = 0;

function mutate(
  qc: QueryClient,
  optimistic: (list: BasketArtist[]) => BasketArtist[],
  call: () => Promise<BasketArtist[]>,
  failText: string,
) {
  qc.setQueryData<BasketArtist[]>(queryKeys.artistBasket, (old) => optimistic(old ?? EMPTY));
  pending += 1;
  chain = chain
    .then(async () => {
      try {
        const server = await call();
        if (pending === 1) qc.setQueryData(queryKeys.artistBasket, server);
      } catch {
        pushToast(failText, "error");
        void qc.invalidateQueries({ queryKey: queryKeys.artistBasket });
      } finally {
        pending -= 1;
      }
    })
    .catch(() => undefined);
}

function currentList(qc: QueryClient) {
  return qc.getQueryData<BasketArtist[]>(queryKeys.artistBasket) ?? EMPTY;
}

/** 画师串面板的读取（全部画师，按加入顺序）。 */
export function useBasketQuery<T = BasketArtist[]>(select?: (list: BasketArtist[]) => T) {
  return useQuery({
    queryKey: queryKeys.artistBasket,
    queryFn: galleryApi.getBasket,
    staleTime: 60_000,
    select,
  });
}

/** 只要动作、不订阅列表（卡片用，避免列表变化时整体重渲染）。 */
export function useBasketActions() {
  const qc = useQueryClient();

  const add = useCallback(
    (names: unknown) => {
      const fresh = basketAdd(currentList(qc), names);
      if (fresh === currentList(qc)) return;
      const wanted = normalizeBasketNames(names).map((n) => n.name);
      mutate(qc, (l) => basketAdd(l, names), () => galleryApi.addToBasket(wanted), "加入画师串失败");
      if (getSettings().basket.autoOpen) useSession.getState().setBasketOpen(true);
    },
    [qc],
  );

  const remove = useCallback(
    (keys: string[]) => {
      if (!keys.length) return;
      mutate(
        qc,
        (l) => basketRemove(l, keys),
        async () => {
          let last: BasketArtist[] = EMPTY;
          for (const key of keys) last = await galleryApi.removeFromBasket(key);
          return last;
        },
        "移出画师串失败",
      );
    },
    [qc],
  );

  /** 都已在面板里 → 全部移出；否则把缺的加进去。返回操作后是否「已加入」。 */
  const toggle = useCallback(
    (names: unknown): boolean => {
      const wanted = normalizeBasketNames(names);
      if (!wanted.length) return false;
      if (basketHasAll(currentList(qc), names)) {
        remove(wanted.map((w) => w.key));
        pushToast(wanted.length > 1 ? `已从画师串移出 ${wanted.length} 位` : `已移出画师串：${wanted[0].name}`);
        return false;
      }
      add(names);
      pushToast(wanted.length > 1 ? `已加入画师串 ${wanted.length} 位` : `已加入画师串：${wanted[0].name}`);
      return true;
    },
    [qc, add, remove],
  );

  const clear = useCallback(() => {
    if (!currentList(qc).length) return;
    mutate(qc, () => EMPTY, () => galleryApi.clearBasket(), "清空画师串失败");
  }, [qc]);

  const copy = useCallback(async () => {
    const list = currentList(qc);
    if (!list.length) {
      pushToast("画师串是空的", "warn");
      return false;
    }
    const ok = await copyText(basketText(list, getSettings().basket));
    pushToast(ok ? `已复制画师串（${list.length} 位）` : "复制失败", ok ? "ok" : "error");
    return ok;
  }, [qc]);

  return useMemo(() => ({ add, remove, toggle, clear, copy }), [add, remove, toggle, clear, copy]);
}

/** 这些画师是否都已在面板里（返回 boolean，值不变时不会触发重渲染）。 */
export function useBasketHas(names: unknown) {
  const { data } = useBasketQuery((list) => basketHasAll(list, names));
  return Boolean(data);
}

export function useBasket() {
  const { data } = useBasketQuery();
  const actions = useBasketActions();
  const artists = data ?? EMPTY;
  return { artists, count: artists.length, ...actions };
}
