import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { basketText, stripArtist, tagKey } from "@/data";
import { copyText } from "@/data/artwork";
import type { BasketArtist } from "@/data/types";
import { pushToast, useBasket, useSession } from "@/state";
import { ArtistHoverTrigger, armArtistLibrary, useArtistPreviews } from "@/ui/ArtistHover";

/** 点单个画师名：直接复制 `artist:名字`。 */
async function copyOne(name: string) {
  const text = `artist:${stripArtist(name)}`;
  const ok = await copyText(text);
  pushToast(ok ? `已复制 ${text}` : "复制失败", ok ? "ok" : "error");
}

/** 画师串弹窗里的一张卡片：没有权重，缩略图取自悬停预览库，悬停出现删除按钮。 */
const BasketCard = memo(function BasketCard({
  artist,
  thumb,
  onRemove,
}: {
  artist: BasketArtist;
  thumb: string;
  onRemove: (key: string) => void;
}) {
  return (
    <span className="artist-card basket-card">
      {thumb ? <img className="bc-thumb" src={thumb} alt="" loading="lazy" /> : <i className="bc-thumb empty" />}
      <ArtistHoverTrigger name={artist.name}>
        <span
          className="ac-name"
          role="button"
          tabIndex={0}
          title="点击复制"
          onClick={() => void copyOne(artist.name)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void copyOne(artist.name);
            }
          }}
        >
          {artist.name}
        </span>
      </ArtistHoverTrigger>
      <button
        type="button"
        className="ac-del"
        title="移出画师串"
        aria-label={`移出 ${artist.name}`}
        onClick={() => onRemove(artist.key)}
      >
        ×
      </button>
    </span>
  );
});

export function BasketPopover() {
  const open = useSession((s) => s.basketOpen);
  const setOpen = useSession((s) => s.setBasketOpen);
  const { artists, count, remove, clear, copy } = useBasket();
  const previews = useArtistPreviews();

  const popRef = useRef<HTMLElement>(null);

  // 打开时才去拉「单画师」库，卡片缩略图和悬停预览都用它。
  useEffect(() => {
    if (open) armArtistLibrary();
  }, [open]);

  // 弹窗贴在活动栏「串」按钮右侧，底边对齐按钮；箭头指向按钮中心。
  useLayoutEffect(() => {
    if (!open) return;
    let raf = 0;
    let last = "";
    function place() {
      const pop = popRef.current;
      const btn = document.querySelector<HTMLElement>('[data-panel="basket"]');
      if (!pop || !btn) return;
      const r = btn.getBoundingClientRect();
      // 按钮位置没变就什么都不做
      const sig = `${r.left}|${r.top}|${r.right}|${r.bottom}|${window.innerHeight}`;
      if (sig === last) return;
      last = sig;
      const bottom = Math.max(8, Math.round(window.innerHeight - r.bottom));
      pop.style.left = `${Math.round(r.right + 14)}px`;
      pop.style.bottom = `${bottom}px`;
      pop.style.maxHeight = `${Math.max(240, window.innerHeight - bottom - 16)}px`;
      pop.style.setProperty("--arrow-bottom", `${Math.round(r.height / 2 - 6)}px`);
    }
    // 「后台」任务出现/消失、额度条变化都会把「串」按钮顶上去或压下来，
    // 所以打开期间每帧比对一次按钮位置，动了就跟过去（没动时只读一次 rect，几乎没开销）。
    function tick() {
      place();
      raf = requestAnimationFrame(tick);
    }
    tick();
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // 只在打开时监听 Esc；弹窗不是模态，点别处不会关闭。
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const removeOne = (key: string) => remove([key]);
  const onClear = () => {
    if (!count) return;
    if (window.confirm(`清空画师串里的 ${count} 位画师？`)) clear();
  };

  return (
    <aside className="basket-pop" aria-label="画师串" ref={popRef}>
      <header className="bd-head">
        <strong>画师串</strong>
        <span className="bd-count">{count}</span>
        <button type="button" className="bd-close" title="关闭 (Esc)" aria-label="关闭画师串" onClick={() => setOpen(false)}>
          ×
        </button>
      </header>
      <div className="bd-body">
        {count ? (
          <div className="bd-cards">
            {artists.map((a) => (
              <BasketCard
                key={a.key}
                artist={a}
                thumb={previews.get(tagKey(a.name))?.[0]?.thumbUrl || ""}
                onRemove={removeOne}
              />
            ))}
          </div>
        ) : (
          <div className="bd-empty">
            <p>还没有画师</p>
            <small>在图库图片上点「加入串」，或在画师悬停预览里点 ＋，就会出现在这里。</small>
          </div>
        )}
      </div>
      {count ? <div className="bd-preview" title="将复制的内容">{basketText(artists)}</div> : null}
      <footer className="bd-foot">
        <button type="button" className="bd-copy" disabled={!count} onClick={() => void copy()}>
          复制画师串
        </button>
        <button type="button" className="bd-clear" disabled={!count} onClick={onClear}>
          清空
        </button>
      </footer>
    </aside>
  );
}
