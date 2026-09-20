import { Plus } from "lucide-react";
import { useCommands, useCollection, useSession } from "@/state";

export function GalleryToolbar() {
  const { album, items, filtered, query } = useCollection();
  const compact = useSession((s) => s.compact);
  const setQuery = useSession((s) => s.setQuery);
  const toggleCompact = useSession((s) => s.toggleCompact);
  const { pickFiles, clearCurrentAlbum } = useCommands();
  const has = items.length > 0;
  const count = query.trim() ? `${filtered.length} / ${items.length} 张` : `${items.length} 张`;

  return (
    <div className="g-toolbar">
      <div className="g-title">
        <h2 className="album-title">{album?.name || "收藏夹"}</h2>
        <span className="count">{has ? count : "0 张"}</span>
      </div>
      <input
        className="search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="筛选画师 / prompt…"
        autoComplete="off"
      />
      <button className="btn" type="button" title="切换画廊密度" onClick={toggleCompact}>
        {compact ? "舒适" : "紧凑"}
      </button>
      {has && (
        <button className="btn" type="button" onClick={() => void clearCurrentAlbum()}>
          清空
        </button>
      )}
      <button className="btn btn-primary" type="button" onClick={pickFiles}>
        <Plus strokeWidth={2} />
        导入图片
      </button>
    </div>
  );
}
