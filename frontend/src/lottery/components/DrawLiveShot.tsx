import { useEffect, useRef } from "react";

export function DrawLiveShot({ src, waiting, text }: { src: string; waiting: boolean; text: string }) {
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = imgRef.current;
    if (!img || !src) return;
    const live = /\/cache\/live-/.test(src);
    if (live && img.getAttribute("src") === src) img.removeAttribute("src");
    if (img.getAttribute("src") !== src) img.src = src;
  }, [src]);

  return (
    <div className={`draw-shot is-live${waiting ? " is-waiting" : ""}`}>
      <img ref={imgRef} src={src} alt="" />
      <span className="draw-job-badge">{text}</span>
    </div>
  );
}
