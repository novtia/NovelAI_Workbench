import { useEffect, useState } from "react";

const FADE_MS = 520;

/**
 * 缩略图原地换图：地址变了，旧图留在原位，新图在同一个容器里加载完再淡入盖上去，
 * 淡完才真正替换。容器大小、位置、卡片本身都不动，用于单画师图库切测试集。
 */
export function SwapImage({ src, alt, width, height }: { src: string; alt: string; width?: number; height?: number }) {
  const [shown, setShown] = useState(src);
  const [incoming, setIncoming] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // 目标地址变了：开始预载新图（换回当前显示的那张就直接取消）。
  useEffect(() => {
    setReady(false);
    setIncoming(src === shown ? null : src);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // 淡入完成后，新图变成底图。
  useEffect(() => {
    if (!incoming || !ready) return;
    const t = window.setTimeout(() => {
      setShown(incoming);
      setIncoming(null);
      setReady(false);
    }, FADE_MS);
    return () => window.clearTimeout(t);
  }, [incoming, ready]);

  return (
    <>
      <img src={shown} alt={alt} loading="lazy" decoding="async" width={width} height={height} />
      {incoming && (
        <img
          key={incoming}
          className={`swap-in${ready ? " on" : ""}`}
          src={incoming}
          alt={alt}
          decoding="async"
          aria-hidden="true"
          onLoad={() => requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)))}
          onError={() => {
            setShown(incoming);
            setIncoming(null);
          }}
        />
      )}
    </>
  );
}
