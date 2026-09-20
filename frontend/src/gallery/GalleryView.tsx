import { AlbumDialog } from "./components/AlbumDialog";
import { GallerySkeleton } from "./skeleton/GallerySkeleton";

export function GalleryView() {
  return (
    <>
      <GallerySkeleton />
      <AlbumDialog />
    </>
  );
}

export { GalleryView as default };
