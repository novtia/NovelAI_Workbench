import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronRight } from "lucide-react";
import { childrenOf, isSeparator, tidy, type MenuEntry, type MenuItem } from "./registry";
import { useMenuDismiss } from "./hooks";
import { closeContextMenu, useContextMenuStore } from "./store";

type Anchor = { kind: "point"; x: number; y: number } | { kind: "rect"; rect: DOMRect };

const EDGE = 8;

function canFocus(entry: MenuEntry): entry is MenuItem {
  return !isSeparator(entry) && !entry.disabled;
}

function firstEnabled(entries: MenuEntry[], from = -1, step = 1) {
  const n = entries.length;
  for (let k = 1; k <= n; k += 1) {
    const i = (((from + step * k) % n) + n) % n;
    if (canFocus(entries[i])) return i;
  }
  return -1;
}

function Panel({
  entries,
  anchor,
  level,
  path,
  setPath,
  run,
}: {
  entries: MenuEntry[];
  anchor: Anchor;
  level: number;
  path: number[];
  setPath: (path: number[]) => void;
  run: (item: MenuItem) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const active = path[level] ?? -1;

  // 先按理想位置渲染一次量出尺寸，再夹进视口；放不下就翻到另一侧。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if (anchor.kind === "point") {
      left = anchor.x;
      top = anchor.y;
      if (left + w > vw - EDGE) left = anchor.x - w;
    } else {
      left = anchor.rect.right - 2;
      top = anchor.rect.top - 6;
      if (left + w > vw - EDGE) left = anchor.rect.left - w + 2;
    }
    if (top + h > vh - EDGE) top = vh - h - EDGE;
    const next = { left: Math.max(EDGE, left), top: Math.max(EDGE, top) };
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, [anchor, entries]);

  const activeEntry = active >= 0 ? entries[active] : undefined;
  const sub = activeEntry && !isSeparator(activeEntry) && activeEntry.children && !activeEntry.disabled ? activeEntry : null;
  const subEntries = sub ? tidy(childrenOf(sub)) : [];
  const subRect = sub && itemRefs.current[active] ? itemRefs.current[active]!.getBoundingClientRect() : null;

  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, maxHeight: window.innerHeight - EDGE * 2 }
    : { left: anchor.kind === "point" ? anchor.x : anchor.rect.right, top: anchor.kind === "point" ? anchor.y : anchor.rect.top, visibility: "hidden", maxHeight: window.innerHeight - EDGE * 2 };

  return (
    <>
      <div
        ref={ref}
        className="ctx-menu"
        role="menu"
        data-ctx-menu=""
        data-level={level}
        style={style}
        onContextMenu={(e) => e.preventDefault()}
      >
        {entries.map((entry, i) => {
          if (isSeparator(entry)) return <div key={`sep-${i}`} className="ctx-sep" role="separator" />;
          const hasSub = Boolean(entry.children);
          return (
            <button
              key={entry.id || `${entry.label}-${i}`}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              className={`ctx-item${entry.danger ? " danger" : ""}${active === i ? " on" : ""}`}
              disabled={entry.disabled}
              aria-haspopup={hasSub ? "menu" : undefined}
              aria-expanded={hasSub && active === i ? true : undefined}
              onMouseEnter={() => {
                if (!entry.disabled) setPath([...path.slice(0, level), i]);
              }}
              onClick={() => {
                if (entry.disabled) return;
                if (hasSub) setPath([...path.slice(0, level), i]);
                else run(entry);
              }}
            >
              <span className="ctx-ico" aria-hidden="true">
                {entry.icon}
              </span>
              <span className="ctx-label">{entry.label}</span>
              {entry.hint ? <span className="ctx-hint">{entry.hint}</span> : null}
              {hasSub ? <ChevronRight className="ctx-arrow" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      {subRect && subEntries.length > 0 ? (
        <Panel
          key={`${level + 1}-${active}`}
          entries={subEntries}
          anchor={{ kind: "rect", rect: subRect }}
          level={level + 1}
          path={path}
          setPath={setPath}
          run={run}
        />
      ) : null}
    </>
  );
}

/** 全局右键菜单宿主：挂在 WorkbenchHosts 里，由 useContextMenu 打开。 */
export function ContextMenuHost() {
  const open = useContextMenuStore((s) => s.open);
  const x = useContextMenuStore((s) => s.x);
  const y = useContextMenuStore((s) => s.y);
  const entries = useContextMenuStore((s) => s.entries);
  const [path, setPath] = useState<number[]>([]);

  useMenuDismiss(open, closeContextMenu);

  // 每次打开都从头开始，不带着上一次的高亮。
  useEffect(() => {
    if (open) setPath([]);
  }, [open, entries]);

  function run(item: MenuItem) {
    if (item.disabled || item.children) return;
    closeContextMenu();
    item.onSelect?.();
  }

  // 沿着当前路径找到每一级的菜单内容。
  function levels() {
    const out: MenuEntry[][] = [entries];
    for (let l = 0; l < path.length - 1; l += 1) {
      const e = out[l][path[l]];
      if (!e || isSeparator(e) || !e.children) break;
      out.push(tidy(childrenOf(e)));
    }
    return out;
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeContextMenu();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Enter", " "].includes(e.key)) return;
      e.preventDefault();
      const all = levels();
      const deep = Math.max(0, Math.min(path.length - 1, all.length - 1));
      const list = all[deep];
      const cur = path[deep] ?? -1;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const step = e.key === "ArrowDown" ? 1 : -1;
        // 还没有高亮时，向上从最后一项开始。
        const next = firstEnabled(list, cur < 0 && step < 0 ? 0 : cur, step);
        if (next >= 0) setPath([...path.slice(0, deep), next]);
        return;
      }
      const entry = cur >= 0 ? list[cur] : undefined;
      const item = entry && !isSeparator(entry) ? entry : null;
      if (e.key === "ArrowLeft") {
        if (path.length > 1) setPath(path.slice(0, -1));
        return;
      }
      if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
        if (!item || item.disabled) return;
        if (item.children) {
          const kids = tidy(childrenOf(item));
          const first = firstEnabled(kids);
          if (first >= 0) setPath([...path.slice(0, deep + 1), first]);
        } else if (e.key !== "ArrowRight") {
          run(item);
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path, entries]);

  if (!open || !entries.length) return null;
  return <Panel entries={entries} anchor={{ kind: "point", x, y }} level={0} path={path} setPath={setPath} run={run} />;
}
