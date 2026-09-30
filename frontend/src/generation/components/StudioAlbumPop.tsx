import { closeStudioMenus, useAlbumsQuery, useSession, useStudioActions, useStudioStore } from "@/state";
import { IconPlus } from "./icons";

export function StudioAlbumPop() {
  const pop = useStudioStore((s) => s.pop);
  const popPos = useStudioStore((s) => s.popPos);
  const setPendingSave = useStudioStore((s) => s.setPendingSave);
  const albums = useAlbumsQuery().data || [];
  const albumId = useSession((s) => s.albumId);
  const saveTo = useStudioActions().saveTo;
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
