import { useCollection, useSession } from "@/state";
import { ArtworkCard } from "./ArtworkCard";
import { EmptyDropzone } from "./EmptyDropzone";

export function ArtworkGrid() {
  const { items, filtered } = useCollection();
  const compact = useSession((s) => s.compact);
  const has = items.length > 0;
  return (
    <div className="g-scroll">
      {!has && <EmptyDropzone />}
      <section className={`grid${compact ? " compact" : ""}`} hidden={!has}>
        {filtered.map((it, i) => (
          <ArtworkCard key={it.id} item={it} index={i} />
        ))}
      </section>
    </div>
  );
}
