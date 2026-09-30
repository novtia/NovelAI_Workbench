import { isSingleArtistAlbum, splitSingleArtistSections } from "@/data";
import type { SkinSlot } from "@/data";
import { useCollection, useSession, useTestRun } from "@/state";
import { ArtworkCard } from "./ArtworkCard";
import { ArtworkPendingCard } from "./ArtworkPendingCard";
import { EmptyDropzone } from "./EmptyDropzone";

export function ArtworkGrid() {
  const { album, testSet, items, filtered } = useCollection();
  const { layout, preset } = useTestRun();
  const compact = useSession((s) => s.compact);
  // 所有收藏夹（普通、单画师、测试集）都按行排：从左到右、排满再换行。
  const gridClass = `grid${compact ? " compact" : ""}`;

  const has = items.length > 0;
  const single = isSingleArtistAlbum(album);
  // 测试集是「皮肤」：布局完全取自默认集，有皮肤的画师换成皮肤图，生成中的显示占位，其余仍是默认图。
  const skinned = single && Boolean(testSet);

  function renderSlot(slot: SkinSlot, i: number) {
    if (slot.skin) return <ArtworkCard key={slot.key} item={slot.skin} index={i} />;
    if (slot.pending) {
      return <ArtworkPendingCard key={slot.key} card={slot.pending} index={i} fallbackSize={preset?.form} />;
    }
    return <ArtworkCard key={slot.key} item={slot.base} index={i} />;
  }

  const split = single && !skinned ? splitSingleArtistSections(filtered) : null;

  return (
    <div className="g-scroll">
      {!has && <EmptyDropzone />}
      {skinned ? (
        <div className="artist-sections" hidden={!has}>
          {layout.shared.length > 0 && <section className={gridClass}>{layout.shared.map(renderSlot)}</section>}
          {layout.extras.map((group) => (
            <section className="artist-split" key={group.key}>
              <div className="artist-split-head">
                <span className="line" />
                <span className="label">{group.name === "未识别画师" ? group.name : `artist:${group.name}`}</span>
                <span className="n">{group.slots.length}</span>
                <span className="line" />
              </div>
              <section className={gridClass}>{group.slots.map(renderSlot)}</section>
            </section>
          ))}
        </div>
      ) : split ? (
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
      {has && skinned && layout.shared.length + layout.extras.length === 0 && (
        <p className="g-nomatch">没有匹配的图片</p>
      )}
    </div>
  );
}
