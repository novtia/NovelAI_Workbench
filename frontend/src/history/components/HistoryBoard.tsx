import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { groupByDay, historyShots, type HistoryShot } from "@/data/history";
import {
  applyClick,
  applyContext,
  EMPTY_SELECTION,
  pickSelected,
  prune,
  selectAll,
  type Selection,
} from "@/data/historySelection";
import {
  copyShotPrompt,
  deleteHistoryShots,
  loadShotParams,
  saveShotsToAlbum,
  useAlbumsQuery,
  useHistoryQuery,
} from "@/state";
import { useContextMenu, useRegisterMenu, type MenuItem } from "@/ui/contextMenu";
import { IconCopy, IconSparkles } from "@/generation/components/icons";
import { HistoryDetail } from "./HistoryDetail";

function clock(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 图的宽高比；缺尺寸时按竖图 2:3，并限制极端比例，免得一张图占满整行或细成一条。 */
function ratioOf(shot: HistoryShot) {
  const r = shot.width && shot.height ? shot.width / shot.height : 2 / 3;
  return Math.min(2.4, Math.max(0.4, r));
}

type CardProps = {
  shot: HistoryShot;
  on: boolean;
  onPick: (shot: HistoryShot, e: MouseEvent) => void;
  onContext: (e: MouseEvent) => void;
};

function HistoryCard({ shot, on, onPick, onContext }: CardProps) {
  const r = ratioOf(shot);
  return (
    <button
      type="button"
      className={`h-card${on ? " sel" : ""}`}
      style={{ "--r": r } as React.CSSProperties}
      data-shot-key={shot.key}
      aria-pressed={on}
      onClick={(e) => onPick(shot, e)}
      onContextMenu={onContext}
      // Shift 点击会触发浏览器的文字选择，按下时就拦掉。
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
    >
      <span className="h-frame">
        <img src={shot.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} />
        {shot.total > 1 ? <span className="badge">{`${shot.index + 1}/${shot.total}`}</span> : null}
        <time dateTime={new Date(shot.createdAt).toISOString()}>{clock(shot.createdAt)}</time>
        <span className="h-check" aria-hidden="true" />
      </span>
    </button>
  );
}

/** 右键菜单里用的上下文：作用的图（已按展示顺序）。 */
type HistoryMenuCtx = { shots: HistoryShot[] };

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export function HistoryBoard() {
  const query = useHistoryQuery();
  const qc = useQueryClient();
  const albums = useAlbumsQuery().data || [];
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  const sentinel = useRef<HTMLDivElement>(null);
  const shots = useMemo(() => historyShots(query.data?.pages.flatMap((page) => page.jobs) || []), [query.data]);
  const days = useMemo(() => groupByDay(shots), [shots]);
  const order = useMemo(() => shots.map((s) => s.key), [shots]);
  const picked = useMemo(() => pickSelected(shots, sel), [shots, sel]);
  const detailShot = picked.length === 1 ? picked[0] : null;

  // 刷新、删除后去掉已经不存在的选中项。
  useEffect(() => {
    setSel((cur) => prune(cur, order));
  }, [order]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage, days.length]);

  const clear = useCallback(() => setSel(EMPTY_SELECTION), []);

  const removeShots = useCallback(
    async (list: HistoryShot[]) => {
      if (await deleteHistoryShots(qc, list)) clear();
    },
    [qc, clear],
  );

  // 快捷键：Ctrl+A 全选、Esc 取消、Delete 删除。
  const keyRef = useRef({ order, picked, removeShots });
  keyRef.current = { order, picked, removeShots };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target) || document.querySelector("dialog[open]")) return;
      const cur = keyRef.current;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (!cur.order.length) return;
        e.preventDefault();
        setSel(selectAll(cur.order));
      } else if (e.key === "Escape") {
        setSel((s) => (s.keys.size ? EMPTY_SELECTION : s));
      } else if (e.key === "Delete" && cur.picked.length) {
        e.preventDefault();
        void cur.removeShots(cur.picked);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function pick(shot: HistoryShot, e: MouseEvent) {
    setSel((cur) => applyClick(cur, order, shot.key, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
  }

  // ---- 右键菜单 ----
  const openShotMenu = useContextMenu<HistoryMenuCtx>("history.shot", (e) => {
    const key = (e.currentTarget as HTMLElement).dataset.shotKey;
    if (!key) return false;
    const next = applyContext(sel, order, key);
    setSel(next);
    return { shots: pickSelected(shots, next) };
  });
  const openBoardMenu = useContextMenu<HistoryMenuCtx>("history.board", () => (shots.length ? { shots: picked } : false));

  useRegisterMenu<HistoryMenuCtx>("history.shot", {
    id: "history.save",
    group: 1,
    order: 0,
    build: ({ shots: list }) => {
      const many = list.length > 1;
      return [
        {
          id: "save",
          label: many ? `保存到收藏夹（${list.length} 张）` : "保存到收藏夹",
          children: () =>
            albums.length
              ? albums.map<MenuItem>((a) => ({
                  id: a.id,
                  label: a.name,
                  hint: a.count != null ? String(a.count) : undefined,
                  onSelect: () => void saveShotsToAlbum(qc, list, a.id, a.name),
                }))
              : [{ label: "还没有收藏夹", disabled: true }],
        },
      ];
    },
  });

  useRegisterMenu<HistoryMenuCtx>("history.shot", {
    id: "history.single",
    group: 1,
    order: 1,
    build: ({ shots: list }) => {
      const only = list.length === 1 ? list[0] : null;
      return [
        { id: "load", label: "载入参数", icon: <IconSparkles />, disabled: !only, onSelect: () => only && loadShotParams(only) },
        { id: "copy", label: "复制提示词", icon: <IconCopy />, disabled: !only, onSelect: () => only && void copyShotPrompt(only) },
      ];
    },
  });

  useRegisterMenu<HistoryMenuCtx>("history.shot", {
    id: "history.select",
    group: 2,
    order: 0,
    build: ({ shots: list }) => [
      { id: "all", label: "全选", hint: "Ctrl+A", disabled: list.length === order.length, onSelect: () => setSel(selectAll(order)) },
      { id: "none", label: "取消选择", hint: "Esc", onSelect: clear },
    ],
  });

  useRegisterMenu<HistoryMenuCtx>("history.shot", {
    id: "history.delete",
    group: 3,
    order: 0,
    build: ({ shots: list }) => [
      {
        id: "delete",
        label: list.length > 1 ? `删除（${list.length} 张）` : "删除",
        hint: "Del",
        danger: true,
        onSelect: () => void removeShots(list),
      },
    ],
  });

  useRegisterMenu<HistoryMenuCtx>("history.board", {
    id: "history.board.select",
    group: 1,
    build: () => [
      { id: "all", label: "全选", hint: "Ctrl+A", disabled: picked.length === order.length, onSelect: () => setSel(selectAll(order)) },
      { id: "none", label: "取消选择", hint: "Esc", disabled: !picked.length, onSelect: clear },
    ],
  });

  return (
    <div className="h-main">
      <div className="h-bar">
        {picked.length ? (
          <>
            <span className="sel-count">已选 {picked.length} 张</span>
            <button className="mini" type="button" onClick={clear}>
              取消选择
            </button>
          </>
        ) : (
          <span className="hint">Ctrl 多选 · Shift 连选 · 右键更多操作</span>
        )}
      </div>
      <div
        className="h-scroll"
        onContextMenu={openBoardMenu}
        onClick={(e) => {
          // 点在空白处取消选择（按着修饰键时不动，免得连选时手滑清空）。
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          if (!(e.target as HTMLElement).closest(".h-card")) clear();
        }}
      >
        {query.isLoading && <p className="h-more">正在读取历史…</p>}
        {query.isError && !shots.length && <p className="h-more">历史记录加载失败</p>}
        {!query.isLoading && !query.isError && !shots.length && (
          <div className="empty">
            <div className="dropzone">
              <h2>还没有生图记录</h2>
              <p>在生图室生成的图片会出现在这里，按日期分开。</p>
            </div>
          </div>
        )}
        {days.map((day) => (
          <section className="h-day" key={day.key}>
            <div className="h-day-head">
              <span className="label">{day.label}</span>
              <span className="line" />
              <span className="n">{day.shots.length} 张</span>
            </div>
            <div className="h-grid">
              {day.shots.map((shot) => (
                <HistoryCard key={shot.key} shot={shot} on={sel.keys.has(shot.key)} onPick={pick} onContext={openShotMenu} />
              ))}
            </div>
          </section>
        ))}
        <div ref={sentinel} className="h-more">
          {query.isFetchingNextPage ? "继续加载…" : query.hasNextPage ? "" : shots.length ? "已经到底了" : ""}
        </div>
      </div>
      <HistoryDetail shot={detailShot} onClose={clear} />
    </div>
  );
}
