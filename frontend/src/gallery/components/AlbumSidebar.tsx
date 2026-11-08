import { isSingleArtistAlbum, type Album } from "@/data";
import { useCommands, useCollection, useSession, useTabs } from "@/state";
import { IconImage, IconPencil, IconPlus, IconTrash } from "@/generation/components/icons";
import { useContextMenu, useRegisterMenu } from "@/ui/contextMenu";

type AlbumMenuCtx = { album: Album };

export function AlbumSidebar() {
  const { albums, album, albumId, items, totalCount } = useCollection();
  const { selectAlbum, deleteAlbumById } = useCommands();
  const openCreateDialog = useSession((s) => s.openCreateDialog);
  const openRenameDialog = useSession((s) => s.openRenameDialog);
  const single = isSingleArtistAlbum(album);

  const openAlbumMenu = useContextMenu<AlbumMenuCtx>("gallery.album", (e) => {
    const id = (e.currentTarget as HTMLElement).dataset.albumId;
    const target = albums.find((a) => a.id === id);
    return target ? { album: target } : false;
  });

  useRegisterMenu<AlbumMenuCtx>("gallery.album", {
    id: "gallery.album.open",
    group: 1,
    order: 0,
    build: ({ album: target }) => [
      {
        id: "detail",
        label: "收藏夹详细页",
        icon: <IconImage />,
        onSelect: () => useTabs.getState().openAlbumTab(target.id),
      },
      {
        id: "rename",
        label: "修改",
        icon: <IconPencil />,
        disabled: isSingleArtistAlbum(target),
        onSelect: () => openRenameDialog(target.id, target.name),
      },
    ],
  });
  useRegisterMenu<AlbumMenuCtx>("gallery.album", {
    id: "gallery.album.delete",
    group: 2,
    order: 0,
    build: ({ album: target }) => [
      {
        id: "delete",
        label: "删除",
        icon: <IconTrash />,
        danger: true,
        disabled: isSingleArtistAlbum(target) || albums.length <= 1,
        onSelect: () => void deleteAlbumById(target.id),
      },
    ],
  });

  return (
    <aside className="g-side">
      <div className="g-side-head">
        <span className="pane-title">收藏夹</span>
        <span className="pane-no">卷帙</span>
      </div>
      <div className="album-list">
        {albums.map((a) => {
          const active = a.id === albumId;
          const locked = isSingleArtistAlbum(a);
          return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              data-album-id={a.id}
              className={`album-item${active ? " active" : ""}`}
              onContextMenu={openAlbumMenu}
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
              {!locked && (
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
                    <IconPencil />
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
                    <IconTrash />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <button className="album-add" type="button" onClick={openCreateDialog}>
        <IconPlus />
        新建收藏夹
      </button>
      <div className="g-side-foot">
        共 {albums.length} 个收藏夹 · {totalCount || items.length} 张
        <br />
        {single ? "仅支持导入单个画师串的测试图" : "拖入图片即可导入"}
      </div>
    </aside>
  );
}
