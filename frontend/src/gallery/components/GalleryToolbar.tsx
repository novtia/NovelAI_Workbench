import { isSingleArtistAlbum } from "@/data";
import { useCommands, useCollection, useSession } from "@/state";
import { IconPlus } from "@/generation/components/icons";

const VOLUME = ["〇", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"];

export function GalleryToolbar() {
  const { album, albums, testSet, items, filtered, query } = useCollection();
  const compact = useSession((s) => s.compact);
  const setQuery = useSession((s) => s.setQuery);
  const toggleCompact = useSession((s) => s.toggleCompact);
  const { pickFiles, clearCurrentAlbum } = useCommands();
  const has = items.length > 0;
  const count = query.trim() ? `${filtered.length} / ${items.length} 张` : `${items.length} 张`;
  const volume = VOLUME[albums.findIndex((a) => a.id === album?.id) + 1] || "〇";

  return (
    <div className={`g-toolbar${isSingleArtistAlbum(album) ? " has-testbar" : ""}`}>
      <div className="g-title">
        <span className="kicker">{testSet ? `卷${volume} · TEST SET` : `卷${volume} · GALLERY`}</span>
        <h2 className="album-title">{testSet?.name || album?.name || "收藏夹"}</h2>
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
        <button
          className="btn"
          type="button"
          title={testSet ? "清空默认集里的全部图片（测试集不受影响，但对应的画师位置会消失）" : undefined}
          onClick={() => void clearCurrentAlbum()}
        >
          清空
        </button>
      )}
      <button
        className="btn btn-primary"
        type="button"
        title={testSet ? "导入到默认集：新画师会成为新角色，所有测试集里都会多出这个位置" : undefined}
        onClick={pickFiles}
      >
        <IconPlus />
        导入图片
      </button>
    </div>
  );
}
