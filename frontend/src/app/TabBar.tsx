import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { useStore } from "zustand";
import type { LucideIcon } from "lucide-react";
import { NAV_ICONS } from "@/ui/navIcons";
import { WindowControls } from "./WindowControls";
import { useAlbumsQuery, useSession, useStudioStore, useTabs, type Tab, type ViewId } from "@/state";

export const VIEW_META: Record<ViewId, { label: string; Icon: LucideIcon }> = {
  gallery: { label: "图库", Icon: NAV_ICONS.gallery },
  lottery: { label: "抽奖台", Icon: NAV_ICONS.lottery },
  studio: { label: "生图室", Icon: NAV_ICONS.studio },
  history: { label: "历史", Icon: NAV_ICONS.history },
  settings: { label: "设置", Icon: NAV_ICONS.settings },
};

function TabItem({
  tab,
  active,
  drop,
  onDragState,
}: {
  tab: Tab;
  active: boolean;
  drop: "before" | "after" | null;
  onDragState: (e: DragEvent<HTMLDivElement>, kind: "start" | "over" | "drop" | "end") => void;
}) {
  const activate = useTabs((s) => s.activateTab);
  const close = useTabs((s) => s.closeTab);
  const albumId = useStore(useSession.forTab(tab.id), (s) => s.albumId);
  const busy = useStore(useStudioStore.forTab(tab.id), (s) => s.busy);
  const albums = useAlbumsQuery().data;
  const meta = VIEW_META[tab.view];
  const title = tab.view === "gallery" ? albums?.find((a) => a.id === albumId)?.name || meta.label : meta.label;

  function onMouseDown(e: MouseEvent) {
    // 中键关闭；默认的滚动光标要拦掉。
    if (e.button === 1) e.preventDefault();
  }
  function onAuxClick(e: MouseEvent) {
    if (e.button === 1) {
      e.preventDefault();
      close(tab.id);
    }
  }

  return (
    <div
      className={`wb-tab${active ? " active" : ""}${drop ? ` drop-${drop}` : ""}`}
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      title={title}
      draggable
      onClick={() => activate(tab.id)}
      onMouseDown={onMouseDown}
      onAuxClick={onAuxClick}
      onDragStart={(e) => onDragState(e, "start")}
      onDragOver={(e) => onDragState(e, "over")}
      onDrop={(e) => onDragState(e, "drop")}
      onDragEnd={(e) => onDragState(e, "end")}
    >
      <span className="wb-tab-glyph" aria-hidden="true">
        <meta.Icon />
      </span>
      <span className="wb-tab-title">{title}</span>
      {tab.view === "studio" && busy ? <span className="wb-tab-dot" title="生成中" /> : null}
      <button
        type="button"
        className="wb-tab-close"
        title="关闭标签页"
        aria-label={`关闭 ${title}`}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          close(tab.id);
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        ×
      </button>
    </div>
  );
}

/** 浏览器式顶部标签栏：每个标签是一个独立的工作台窗口，只渲染激活的那个。 */
export function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const openTab = useTabs((s) => s.openTab);
  const closeTab = useTabs((s) => s.closeTab);
  const activateTab = useTabs((s) => s.activateTab);
  const moveTab = useTabs((s) => s.moveTab);
  const dragId = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; side: "before" | "after" } | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const { tabs: list, activeId: cur } = useTabs.getState();
      if (mod && e.key === "Tab") {
        e.preventDefault();
        const i = list.findIndex((t) => t.id === cur);
        const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
        if (next) activateTab(next.id);
        return;
      }
      // 浏览器会抢走 Ctrl+T / Ctrl+W，所以同时支持 Alt 组合键；放进 Electron 后 Ctrl 组合键也能用。
      if ((mod || e.altKey) && !e.shiftKey && key === "t") {
        e.preventDefault();
        openTab("gallery");
      } else if ((mod || e.altKey) && !e.shiftKey && key === "w") {
        e.preventDefault();
        closeTab(cur);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activateTab, closeTab, openTab]);

  function onDragState(tabId: string) {
    return (e: DragEvent<HTMLDivElement>, kind: "start" | "over" | "drop" | "end") => {
      if (kind === "start") {
        dragId.current = tabId;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-wb-tab", tabId);
        return;
      }
      if (!dragId.current) return;
      if (kind === "over") {
        if (!e.dataTransfer.types.includes("application/x-wb-tab")) return;
        e.preventDefault();
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const side = e.clientX < r.left + r.width / 2 ? "before" : "after";
        setDrop((d) => (d && d.id === tabId && d.side === side ? d : { id: tabId, side }));
        return;
      }
      if (kind === "drop") {
        e.preventDefault();
        e.stopPropagation();
        const from = dragId.current;
        const list = useTabs.getState().tabs;
        const target = list.findIndex((t) => t.id === tabId);
        const origin = list.findIndex((t) => t.id === from);
        if (target >= 0 && origin >= 0 && from !== tabId) {
          const side = drop?.id === tabId ? drop.side : "after";
          let to = side === "before" ? target : target + 1;
          if (origin < to) to -= 1;
          moveTab(from, to);
        }
      }
      dragId.current = null;
      setDrop(null);
    };
  }

  return (
    <div className="wb-tabbar" role="tablist" aria-label="窗口标签页" data-tauri-drag-region>
      <div className="wb-tabs">
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            drop={drop?.id === tab.id ? drop.side : null}
            onDragState={onDragState(tab.id)}
          />
        ))}
      </div>
      <button type="button" className="wb-tab-add" title="新建标签页 (Alt+T)" aria-label="新建标签页" onClick={() => openTab("gallery")}>
        +
      </button>
      <div className="wb-tab-fill" data-tauri-drag-region />
      <WindowControls />
    </div>
  );
}
