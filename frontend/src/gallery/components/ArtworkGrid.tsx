import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { galleryApi } from "@/api";
import { isSingleArtistAlbum, queryKeys, splitSingleArtistSections } from "@/data";
import type { SkinSlot } from "@/data";
import { applyClick, applyContext, EMPTY_SELECTION, pickSelected, prune, selectAll, type Selection } from "@/data/historySelection";
import type { Artwork } from "@/data/types";
import { confirmDialog, getSettings, pushToast, useCollection, useCommands, useSession, useSettings, useTestRun } from "@/state";
import { IconUp } from "@/generation/components/icons";
import { useContextMenu, useRegisterMenu } from "@/ui/contextMenu";
import { useScrollMemory } from "@/ui/useScrollMemory";
import { ArtworkCard } from "./ArtworkCard";
import { ArtworkPendingCard } from "./ArtworkPendingCard";
import { EmptyDropzone } from "./EmptyDropzone";

type GalleryMenuCtx = { items: Artwork[] };

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export function ArtworkGrid() {
  const { album, testSet, items, filtered, query } = useCollection();
  const { layout, preset, redraw } = useTestRun();
  // 回调引用保持稳定，不让每张卡片的 memo 失效。
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;
  const redrawStable = useCallback((item: Artwork) => void redrawRef.current(item), []);
  const density = useSettings((s) => s.gallery.density);
  const sort = useSettings((s) => s.gallery.sort);
  const pageSize = useSettings((s) => s.gallery.pageSize);
  // 所有收藏夹（普通、单画师、测试集）都按行排：从左到右、排满再换行。
  const gridClass = `grid${density === "compact" ? " compact" : ""}`;

  // 排序与分批渲染只作用于普通收藏夹；单画师收藏夹的顺序决定画师位置，必须保持原样。
  const ordered = useMemo(
    () => (sort === "added_asc" ? [...filtered].sort((a, b) => a.addedAt - b.addedAt) : [...filtered].sort((a, b) => b.addedAt - a.addedAt)),
    [filtered, sort],
  );
  const [shown, setShown] = useState<number>(pageSize);
  const resetKey = `${album?.id || ""}|${query}|${sort}|${pageSize}`;
  useEffect(() => {
    setShown(pageSize);
  }, [resetKey, pageSize]);
  const visible = pageSize > 0 ? ordered.slice(0, shown) : ordered;
  const more = pageSize > 0 && shown < ordered.length;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!more || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => n + pageSize);
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [more, pageSize, shown]);

  const has = items.length > 0;
  const single = isSingleArtistAlbum(album);
  // 测试集是「皮肤」：布局完全取自默认集，有皮肤的画师换成皮肤图，生成中的显示占位，其余仍是默认图。
  const skinned = single && Boolean(testSet);

  function renderSlot(slot: SkinSlot, i: number) {
    if (slot.skin && slot.pending) {
      return <ArtworkPendingCard key={slot.key} card={slot.pending} index={i} fallbackSize={preset?.form} />;
    }
    if (slot.skin) return <ArtworkCard key={slot.key} item={slot.skin} index={i} enter={false} onRedraw={redrawStable} picked={sel.keys.has(slot.skin.id)} onPick={onPick} onContext={openCardMenu} />;
    if (slot.pending) {
      return <ArtworkPendingCard key={slot.key} card={slot.pending} index={i} fallbackSize={preset?.form} />;
    }
    return <ArtworkCard key={slot.key} item={slot.base} index={i} enter={false} />;
  }

  const split = single && !skinned ? splitSingleArtistSections(filtered) : null;
  // 单画师图库里默认图和皮肤图是同一批格子：入场动画一律关掉，切测试集时卡片只换图，不整页重播。
  const enter = !single;

  // 可多选的图：测试集里只有皮肤图（默认图属于单画师库，不在这次删除范围内）。
  const selectable = useMemo(() => {
    if (skinned) {
      const slots = [...layout.shared, ...layout.extras.flatMap((g) => g.slots)];
      return slots.flatMap((slot) => (slot.skin && !slot.pending ? [slot.skin] : []));
    }
    if (split) return [...split.shared, ...split.extras.flatMap((g) => g.items)];
    return ordered;
  }, [skinned, layout, split, ordered]);
  const catalog = useMemo(() => selectable.map((item) => ({ key: item.id, item })), [selectable]);
  const order = useMemo(() => catalog.map((c) => c.key), [catalog]);
  const orderRef = useRef(order);
  orderRef.current = order;
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  useEffect(() => {
    setSel((cur) => prune(cur, order));
  }, [order]);
  const picked = useMemo(() => pickSelected(catalog, sel).map((c) => c.item), [catalog, sel]);

  const qc = useQueryClient();
  const { generateFrom, copyArtists } = useCommands();
  const removeItems = useCallback(
    async (list: Artwork[]) => {
      if (!list.length) return;
      if (getSettings().gallery.confirmDelete) {
        const ok = await confirmDialog(
          list.length > 1 ? `删除选中的 ${list.length} 张图片？会同时删除本地文件，无法恢复。` : "删除这张图片？会同时删除本地文件，无法恢复。",
          { title: "删除图片", confirmText: "删除" },
        );
        if (!ok) return;
      }
      const albums = new Set<string>();
      let n = 0;
      for (const it of list) {
        try {
          await galleryApi.deleteItem(it.id);
          n += 1;
          if (it.albumId) albums.add(it.albumId);
        } catch (err) {
          pushToast(err instanceof Error ? err.message : "删除失败", "error");
          break;
        }
      }
      if (!n) return;
      if (list.some((it) => it.id === useSession.getState().openId)) useSession.getState().setOpenId(null);
      setSel(EMPTY_SELECTION);
      await qc.invalidateQueries({ queryKey: queryKeys.albums });
      await Promise.all([...albums].map((id) => qc.invalidateQueries({ queryKey: queryKeys.items(id) })));
      pushToast(n === 1 ? "已删除" : `已删除 ${n} 张`, "ok");
    },
    [qc],
  );

  const keyRef = useRef({ order, picked, removeItems });
  keyRef.current = { order, picked, removeItems };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target) || document.querySelector("dialog[open]")) return;
      const cur = keyRef.current;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (!cur.order.length) return;
        e.preventDefault();
        setSel(selectAll(cur.order));
        useSession.getState().setOpenId(null);
      } else if (e.key === "Escape") {
        setSel((s) => (s.keys.size ? EMPTY_SELECTION : s));
      } else if (e.key === "Delete" && cur.picked.length) {
        e.preventDefault();
        void cur.removeItems(cur.picked);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onPick = useCallback((item: Artwork, e: MouseEvent<HTMLElement>) => {
    const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    setSel((cur) => applyClick(cur, orderRef.current, item.id, mods));
    if (mods.ctrl || mods.shift) {
      if (useSession.getState().openId) useSession.getState().setOpenId(null);
      return;
    }
    useSession.getState().setOpenId(item.id);
  }, []);

  const openCardMenu = useContextMenu<GalleryMenuCtx>("gallery.card", (e) => {
    const id = (e.currentTarget as HTMLElement).dataset.id;
    if (!id) return false;
    const next = applyContext(sel, orderRef.current, id);
    if (next === sel && !sel.keys.has(id)) return false;
    setSel(next);
    const open = useSession.getState().openId;
    if (!(next.keys.size === 1 && open && next.keys.has(open))) useSession.getState().setOpenId(null);
    return { items: pickSelected(catalog, next).map((c) => c.item) };
  });
  const openBoardMenu = useContextMenu<GalleryMenuCtx>("gallery.board", (e) => {
    if ((e.target as HTMLElement).closest(".card")) return false;
    if (!order.length) return false;
    return { items: picked };
  });

  const clearSel = useCallback(() => setSel(EMPTY_SELECTION), []);
  useRegisterMenu<GalleryMenuCtx>("gallery.card", {
    id: "gallery.single",
    group: 1,
    order: 0,
    build: ({ items: list }) => {
      const only = list.length === 1 ? list[0] : null;
      return [
        { id: "gen", label: "用此参数生图", disabled: !only, onSelect: () => only && generateFrom(only) },
        { id: "copy", label: "复制画师串", disabled: !only || !(only.artists || []).length, onSelect: () => only && void copyArtists(only) },
      ];
    },
  });
  useRegisterMenu<GalleryMenuCtx>("gallery.card", {
    id: "gallery.select",
    group: 2,
    order: 0,
    build: ({ items: list }) => [
      {
        id: "all",
        label: "全选",
        hint: "Ctrl+A",
        disabled: list.length === order.length,
        onSelect: () => {
          setSel(selectAll(order));
          useSession.getState().setOpenId(null);
        },
      },
      { id: "none", label: "取消选择", hint: "Esc", onSelect: clearSel },
    ],
  });
  useRegisterMenu<GalleryMenuCtx>("gallery.card", {
    id: "gallery.delete",
    group: 3,
    order: 0,
    build: ({ items: list }) => [
      {
        id: "delete",
        label: list.length > 1 ? `删除（${list.length} 张）` : "删除",
        hint: "Del",
        danger: true,
        onSelect: () => void removeItems(list),
      },
    ],
  });
  useRegisterMenu<GalleryMenuCtx>("gallery.board", {
    id: "gallery.board.select",
    group: 1,
    build: () => [
      {
        id: "all",
        label: "全选",
        hint: "Ctrl+A",
        disabled: picked.length === order.length,
        onSelect: () => {
          setSel(selectAll(order));
          useSession.getState().setOpenId(null);
        },
      },
      { id: "none", label: "取消选择", hint: "Esc", disabled: !picked.length, onSelect: clearSel },
    ],
  });

  // 滚动位置持久化：每个收藏夹 / 测试集各记一份，刷新、重启、切页面回来都停在原处。
  const scrollRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const active = useSession((s) => s.view === "gallery");
  const onScroll = useScrollMemory({
    ref: scrollRef,
    storeKey: `${album?.id || ""}|${skinned && testSet ? testSet.id : ""}`,
    ready: has && Boolean(album) && !query.trim(),
    active,
    getShown: () => shownRef.current,
    setShown,
  });
  const [showTop, setShowTop] = useState(false);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setShowTop(e.currentTarget.scrollTop > 600);
    onScroll(e);
  };

  return (
    <div className="g-wrap">
    {picked.length > 0 && (
      <div className="g-selbar">
        <span>已选 {picked.length} 张</span>
        <button type="button" onClick={clearSel}>
          取消选择
        </button>
      </div>
    )}
    <div
      className="g-scroll"
      ref={scrollRef}
      onScroll={handleScroll}
      onContextMenu={openBoardMenu}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        if ((e.target as HTMLElement).closest(".card")) return;
        clearSel();
      }}
    >
      {!has && <EmptyDropzone />}
      {skinned ? (
        <div className="artist-sections" hidden={!has}>
          {layout.shared.length > 0 && <section className={gridClass}>{layout.shared.map(renderSlot)}</section>}
          {layout.extras.map((group) => (
            <section className="artist-split" key={group.key}>
              <div className="artist-split-head">
                <span className="line" />
                <span className="label">{group.name === "未识别画师" ? group.name : `artist:${group.name}`}</span>
                <span className="n">{group.slots.length}</span>
                <span className="line" />
              </div>
              <section className={gridClass}>{group.slots.map(renderSlot)}</section>
            </section>
          ))}
        </div>
      ) : split ? (
        <div className="artist-sections" hidden={!has}>
          {split.shared.length > 0 && (
            <section className={gridClass}>
              {split.shared.map((it, i) => (
                <ArtworkCard key={it.id} item={it} index={i} enter={enter} picked={sel.keys.has(it.id)} onPick={onPick} onContext={openCardMenu} />
              ))}
            </section>
          )}
          {split.extras.map((group) => (
            <section className="artist-split" key={group.key}>
              <div className="artist-split-head">
                <span className="line" />
                <span className="label">{group.name === "未识别画师" ? group.name : `artist:${group.name}`}</span>
                <span className="n">{group.items.length}</span>
                <span className="line" />
              </div>
              <section className={gridClass}>
                {group.items.map((it, i) => (
                  <ArtworkCard key={it.id} item={it} index={i} enter={enter} picked={sel.keys.has(it.id)} onPick={onPick} onContext={openCardMenu} />
                ))}
              </section>
            </section>
          ))}
        </div>
      ) : (
        <section className={gridClass} hidden={!has}>
          {visible.map((it, i) => (
            <ArtworkCard key={it.id} item={it} index={i} picked={sel.keys.has(it.id)} onPick={onPick} onContext={openCardMenu} />
          ))}
        </section>
      )}
      {more && !split && !skinned ? (
        <div ref={sentinel} className="g-more">
          已显示 {visible.length} / {ordered.length} 张，继续滚动加载…
        </div>
      ) : null}
      {has && skinned && layout.shared.length + layout.extras.length === 0 && (
        <p className="g-nomatch">没有匹配的图片</p>
      )}
    </div>
    <button
      className={`g-top${showTop ? " show" : ""}`}
      type="button"
      title="回到顶部"
      aria-label="回到顶部"
      tabIndex={showTop ? 0 : -1}
      onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
    >
      <IconUp />
    </button>
    </div>
  );
}
