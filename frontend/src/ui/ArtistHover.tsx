import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { galleryApi } from "@/api";
import { artistLibraryNames, indexArtistPreviews, isSingleArtistAlbum, queryKeys, stripArtist, tagKey } from "@/data";
import type { Artwork } from "@/data/types";
import { useAlbumsQuery, useSession } from "@/state";
import { BasketAddButton } from "./BasketAddButton";

type HoverState = {
  name: string;
  key: string;
  items: Artwork[];
  index: number;
  rect: DOMRect;
};

type ArtistHoverApi = {
  show: (name: string, rect: DOMRect) => void;
  delayHide: () => void;
  cancelHide: () => void;
};

const ArtistHoverContext = createContext<ArtistHoverApi | null>(null);
const HIDE_MS = 160;

const noop: ArtistHoverApi = {
  show() {},
  delayHide() {},
  cancelHide() {},
};

let libraryArmed = false;
const libraryArmers = new Set<() => void>();

/** 第一次进入提示词输入框时才去拉「单画师」库。 */
export function armArtistLibrary() {
  if (libraryArmed) return;
  libraryArmed = true;
  libraryArmers.forEach((fn) => fn());
}

const NO_ITEMS: Artwork[] = [];

const NamesContext = createContext<string[]>([]);
const PreviewsContext = createContext<Map<string, Artwork[]>>(new Map());

function useSingleArtistItems(enabled: boolean) {
  const albumsQ = useAlbumsQuery();
  const album = (albumsQ.data || []).find(isSingleArtistAlbum);
  const itemsQ = useQuery({
    queryKey: queryKeys.items(album?.id || "_none_"),
    queryFn: () => galleryApi.listItems(album!.id),
    enabled: enabled && Boolean(album?.id),
  });
  return itemsQ.data || NO_ITEMS;
}

/** 图库里选中的测试集图片：悬停预览要显示测试集画面。 */
function useTestSetItems() {
  const testSetId = useSession((s) => s.testSetId);
  const itemsQ = useQuery({
    queryKey: queryKeys.items(testSetId || "_none_"),
    queryFn: () => galleryApi.listItems(testSetId),
    enabled: Boolean(testSetId),
  });
  return testSetId ? itemsQ.data || NO_ITEMS : NO_ITEMS;
}

/** 画师 tagKey -> 测试图（最新在前），联想列表右侧预览用。 */
export function useArtistPreviews() {
  return useContext(PreviewsContext);
}

/** 「单画师」库里去重后的画师名，输入联想用。 */
export function useArtistLibrary() {
  return useContext(NamesContext);
}

export function useArtistHover() {
  return useContext(ArtistHoverContext) || noop;
}

export function ArtistHoverProvider({ children }: { children: ReactNode }) {
  const [armed, setArmed] = useState(libraryArmed);
  useEffect(() => {
    if (libraryArmed) return;
    const fn = () => setArmed(true);
    libraryArmers.add(fn);
    return () => {
      libraryArmers.delete(fn);
    };
  }, []);
  const testSetId = useSession((s) => s.testSetId);
  // 选了测试集时也要有默认图，用来给没有皮肤的画师兜底。
  const items = useSingleArtistItems(armed || Boolean(testSetId));
  const names = useMemo(() => artistLibraryNames(items), [items]);
  const testItems = useTestSetItems();
  // 测试集是皮肤：有皮肤的画师先显示测试集里的画面，其余（以及皮肤之后）是「单画师」库里的默认图。
  const previews = useMemo(() => {
    const base = indexArtistPreviews(items);
    if (!testSetId) return base;
    const merged = new Map(base);
    for (const [key, list] of indexArtistPreviews(testItems)) merged.set(key, [...list, ...(base.get(key) || [])]);
    return merged;
  }, [testSetId, testItems, items]);
  const [state, setState] = useState<HoverState | null>(null);
  const hideTimer = useRef(0);
  const stateRef = useRef(state);
  const previewsRef = useRef(previews);
  stateRef.current = state;
  previewsRef.current = previews;

  const cancelHide = useCallback(() => {
    window.clearTimeout(hideTimer.current);
  }, []);

  const delayHide = useCallback(() => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => setState(null), HIDE_MS);
  }, [cancelHide]);

  const show = useCallback(
    (name: string, rect: DOMRect) => {
      const key = tagKey(name);
      const items = previewsRef.current.get(key) || [];
      cancelHide();
      if (!key || !items.length) {
        setState(null);
        return;
      }
      setState((prev) => {
        if (
          prev?.key === key &&
          Math.abs(prev.rect.left - rect.left) < 4 &&
          Math.abs(prev.rect.top - rect.top) < 4 &&
          Math.abs(prev.rect.width - rect.width) < 4
        ) {
          return prev;
        }
        if (prev?.key === key) return { ...prev, name, rect, items };
        return { name, key, items, index: 0, rect };
      });
    },
    [cancelHide],
  );

  useEffect(() => {
    setState((prev) => {
      if (!prev) return prev;
      const items = previews.get(prev.key) || [];
      if (!items.length) return null;
      return { ...prev, items, index: Math.min(prev.index, items.length - 1) };
    });
  }, [previews]);

  useEffect(() => {
    if (!state) return;
    function onWheel(e: WheelEvent) {
      const cur = stateRef.current;
      if (!cur || cur.items.length < 2) return;
      const t = e.target as HTMLElement | null;
      if (!t?.closest("[data-artist-hover], .artist-hover-pop")) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1;
      const n = cur.items.length;
      setState((prev) => (prev ? { ...prev, index: (prev.index + dir + n) % n } : prev));
    }
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [Boolean(state)]);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const api = useMemo<ArtistHoverApi>(() => ({ show, delayHide, cancelHide }), [show, delayHide, cancelHide]);

  return (
    <NamesContext.Provider value={names}>
      <PreviewsContext.Provider value={previews}>
        <ArtistHoverContext.Provider value={api}>
          {children}
          <ArtistHoverPop state={state} onEnter={cancelHide} onLeave={delayHide} />
        </ArtistHoverContext.Provider>
      </PreviewsContext.Provider>
    </NamesContext.Provider>
  );
}

export function ArtistHoverTrigger({
  name,
  children,
  className,
}: {
  name: string;
  children: ReactNode;
  className?: string;
}) {
  const hover = useArtistHover();
  if (!name) return children;
  return (
    <span
      className={`artist-tok${className ? ` ${className}` : ""}`}
      data-artist-hover=""
      onMouseEnter={(e) => hover.show(name, e.currentTarget.getBoundingClientRect())}
      onMouseMove={(e) => hover.show(name, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => hover.delayHide()}
    >
      {children}
    </span>
  );
}

function placePop(rect: DOMRect, w: number, h: number) {
  let left = rect.left + rect.width / 2 - w / 2;
  let top = rect.top - h - 10;
  if (top < 8) top = rect.bottom + 10;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
  return { left, top };
}

function ArtistHoverPop({
  state,
  onEnter,
  onLeave,
}: {
  state: HoverState | null;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!state) {
      setPos(null);
      return;
    }
    if (!ref.current) return;
    setPos(placePop(state.rect, ref.current.offsetWidth, ref.current.offsetHeight));
  }, [state]);

  if (!state) return null;
  const item = state.items[state.index];
  if (!item) return null;
  const shown = pos || placePop(state.rect, 220, 260);
  return createPortal(
    <div
      ref={ref}
      className="artist-hover-pop"
      style={{ left: shown.left, top: shown.top }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="cap">
        <span>{`artist:${stripArtist(state.name)}`}</span>
        {state.items.length > 1 && (
          <span className="idx">
            {state.index + 1}/{state.items.length}
          </span>
        )}
      </div>
      <div className="pop-img">
        <img src={item.thumbUrl} alt="" width={item.width || undefined} height={item.height || undefined} />
        <BasketAddButton className="on-image" names={[state.name]} />
      </div>
    </div>,
    document.body,
  );
}
