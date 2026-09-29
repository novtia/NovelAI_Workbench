import { closeStudioMenus, useSession, useStudio } from "@/state";
import { IconPlus } from "./icons";

export function StudioAlbumPop() {
  const { pop, popPos, albums, albumId, saveTo, setPendingSave } = useStudio();
  const openCreateDialog = useSession((s) => s.openCreateDialog);
  const open = pop === "album";
  return (
    <div
      className={`pop-panel album-pop${open ? " open" : ""}`}
      id="st-album-pop"
      style={open ? { left: popPos.left, top: popPos.top } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="pop-h">保存到收藏夹</div>
      <div className="album-pop-list">
        {albums.map((a) => (
          <button key={a.id} type="button" className={a.id === albumId ? "on" : ""} onClick={() => void saveTo(a.id)}>
            <span className="name">{a.name}</span>
            <span className="n">{a.count ?? 0}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="album-pop-new"
        onClick={(e) => {
          e.stopPropagation();
          setPendingSave(true);
          closeStudioMenus();
          openCreateDialog();
        }}
      >
        <IconPlus />
        新建收藏夹
      </button>
    </div>
  );
}
