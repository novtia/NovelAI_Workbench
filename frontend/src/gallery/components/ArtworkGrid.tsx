import { isSingleArtistAlbum, splitSingleArtistSections } from "@/data";
import { useCollection, useSession } from "@/state";
import { ArtworkCard } from "./ArtworkCard";
import { EmptyDropzone } from "./EmptyDropzone";

export function ArtworkGrid() {
  const { album, items, filtered } = useCollection();
  const compact = useSession((s) => s.compact);
  const has = items.length > 0;
  const split = isSingleArtistAlbum(album) ? splitSingleArtistSections(filtered) : null;
  const gridClass = `grid${compact ? " compact" : ""}`;

  return (
    <div className="g-scroll">
      {!has && <EmptyDropzone />}
      {split ? (
        <div className="artist-sections" hidden={!has}>
          {split.shared.length > 0 && (
            <section className={gridClass}>
              {split.shared.map((it, i) => (
                <ArtworkCard key={it.id} item={it} index={i} />
              ))}
            </section>
          )}
          {split.extras.map((group) => (
            <section className="artist-split" key={group.key}>
              <div className="artist-split-head">
                <span className="line" />
                <span className="label">{group.name === "未识别画师" ? group.name : `artist:${group.name}`}</span>
                <span className="n">{group.items.length}</span>
                <span className="line" />
              </div>
              <section className={gridClass}>
                {group.items.map((it, i) => (
                  <ArtworkCard key={it.id} item={it} index={i} />
                ))}
              </section>
            </section>
          ))}
        </div>
      ) : (
        <section className={gridClass} hidden={!has}>
          {filtered.map((it, i) => (
            <ArtworkCard key={it.id} item={it} index={i} />
          ))}
        </section>
      )}
    </div>
  );
}
