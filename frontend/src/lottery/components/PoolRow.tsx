import { useEffect, useState } from "react";
import { isListed } from "@/data";
import type { PoolArtist } from "@/data/types";
import { useLotteryActions, useLotteryStore } from "@/state";
import { ArtistHoverTrigger } from "@/ui/ArtistHover";
import { IconPin } from "@/generation/components/icons";

export function PoolRow({ artist }: { artist: PoolArtist }) {
  const pinned = useLotteryStore((s) => s.pinned);
  const excluded = useLotteryStore((s) => s.excluded);
  const weightCaps = useLotteryStore((s) => s.weightCaps);
  const controls = useLotteryStore((s) => s.controls);
  const { togglePin, toggleExclude, applyCap } = useLotteryActions();
  const off = isListed(excluded, artist);
  const pin = isListed(pinned, artist);
  const cap = weightCaps[artist.key];
  const [value, setValue] = useState(cap == null ? "" : String(cap));

  useEffect(() => {
    setValue(cap == null ? "" : String(cap));
  }, [cap]);

  function commit() {
    const next = applyCap(artist.key, value);
    setValue(next);
  }

  return (
    <div className={`pool-row${off ? " off" : ""}${pin ? " pinned" : ""}`}>
      <button
        type="button"
        className={`pool-pin${pin ? " on" : ""}`}
        title={pin ? "取消固定基底" : "固定为基底，每条抽奖必出并占名额"}
        onClick={() => togglePin(artist.key)}
      >
        <IconPin />
      </button>
      <button
        type="button"
        className="pool-toggle"
        title={off ? "点击移回抽奖池" : "点击从抽奖池排除"}
        onClick={() => toggleExclude(artist.key)}
      >
        <span className="pname">
          <ArtistHoverTrigger name={artist.name}>{artist.name}</ArtistHoverTrigger>
        </span>
        {pin && <span className="base">基底</span>}
        {off && <span className="ban">已排除</span>}
        {artist.weight !== 1 && <span className="pmeta">w{artist.weight}</span>}
      </button>
      <label className="pool-cap" title="该画师抽中后的 tag 权重上限；空白则用控制台「最大权重」">
        ≤
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder={String(controls.wmax || 1)}
          value={value}
          aria-label={`${artist.name} 最大权重`}
          className={cap != null ? "has-cap" : ""}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>
    </div>
  );
}
