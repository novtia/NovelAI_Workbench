import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCommands, useCollection, useSession } from "@/state";

export function AlbumSidebar() {
  const { albums, albumId, items, totalCount } = useCollection();
  const { selectAlbum, deleteAlbumById } = useCommands();
  const openCreateDialog = useSession((s) => s.openCreateDialog);
  const openRenameDialog = useSession((s) => s.openRenameDialog);

  return (
    <aside className="g-side">
      <div className="g-side-head">
        <span className="pane-title">收藏夹</span>
      </div>
      <div className="album-list">
        {albums.map((a) => {
          const active = a.id === albumId;
          return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              className={`album-item${active ? " active" : ""}`}
              onClick={() => selectAlbum(a.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectAlbum(a.id);
                }
              }}
            >
              <span className="name">{a.name}</span>
              <span className="n">{a.count ?? 0}</span>
              <span className="ops">
                <button
                  type="button"
                  title="重命名"
                  aria-label="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    openRenameDialog(a.id, a.name);
                  }}
                >
                  <Pencil strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className="del"
                  title="删除"
                  aria-label="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteAlbumById(a.id);
                  }}
                >
                  <Trash2 strokeWidth={1.8} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <button className="album-add" type="button" onClick={openCreateDialog}>
        <Plus strokeWidth={1.7} />
        新建收藏夹
      </button>
      <div className="g-side-foot">
        共 {albums.length} 个收藏夹 · {totalCount || items.length} 张
        <br />
        拖入图片即可导入
      </div>
    </aside>
  );
}
