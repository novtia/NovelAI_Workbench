import { BAR_COLORS, drawSum, rowName, sortedDrawRows } from "@/data";
import type { DrawResult } from "@/data/types";
import { ArtistHoverTrigger } from "@/ui/ArtistHover";

export function WeightBar({ draw }: { draw: DrawResult }) {
  const rows = sortedDrawRows(draw);
  if (!rows.length) return null;
  const { total } = drawSum(draw, rows);
  return (
    <>
      <div className="wbar">
        {rows.map((r, j) => (
          <i key={j} style={{ width: `${((r.cents / total) * 100).toFixed(1)}%`, background: BAR_COLORS[j % BAR_COLORS.length] }} />
        ))}
      </div>
      <div className="wlegend">
        {rows.map((r, j) => (
          <span key={j}>
            <i style={{ background: BAR_COLORS[j % BAR_COLORS.length] }} />
            <ArtistHoverTrigger name={rowName(r)}>{rowName(r)}</ArtistHoverTrigger> {(r.cents / 100).toFixed(2)}
          </span>
        ))}
      </div>
    </>
  );
}
