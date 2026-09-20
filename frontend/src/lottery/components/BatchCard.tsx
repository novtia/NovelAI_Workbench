import type { DrawBatch } from "@/data/types";
import { BatchHead } from "./BatchHead";
import { DrawCard } from "./DrawCard";

export function BatchCard({ batch }: { batch: DrawBatch }) {
  return (
    <section className="lot-batch" data-batch={batch.id}>
      <BatchHead batch={batch} />
      <div className="lottery-list">
        {batch.draws.map((d, i) => (
          <DrawCard key={d.id || `${batch.id}-${i}`} batch={batch} index={i} draw={d} />
        ))}
      </div>
    </section>
  );
}
