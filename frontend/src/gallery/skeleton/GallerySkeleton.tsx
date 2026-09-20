import { useSession } from "@/state";
import { AlbumSidebar } from "../components/AlbumSidebar";
import { ArtworkGrid } from "../components/ArtworkGrid";
import { GalleryToolbar } from "../components/GalleryToolbar";
import { InspectorPanel } from "../components/InspectorPanel";

export function GallerySkeleton() {
  const view = useSession((s) => s.view);
  return (
    <section className={`view${view === "gallery" ? " active" : ""}`} id="view-gallery">
      <AlbumSidebar />
      <div className="g-main">
        <GalleryToolbar />
        <ArtworkGrid />
      </div>
      <InspectorPanel />
    </section>
  );
}
