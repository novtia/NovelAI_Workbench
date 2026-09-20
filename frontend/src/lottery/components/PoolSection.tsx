import type { PoolArtist } from "@/data/types";
import { PoolRow } from "./PoolRow";

export function PoolSection({ title, artists }: { title?: string; artists: PoolArtist[] }) {
  if (!artists.length) return null;
  if (!title) {
    return (
      <>
        {artists.map((p) => (
          <PoolRow key={p.key} artist={p} />
        ))}
      </>
    );
  }
  return (
    <div className="pool-sec">
      <div className="pool-sec-h">{title}</div>
      {artists.map((p) => (
        <PoolRow key={p.key} artist={p} />
      ))}
    </div>
  );
}
