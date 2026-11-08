import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { fitCamera, zoomAt, type Box, type Camera } from "@/data/studioCanvas";
import type { Artwork } from "@/data/types";
import { IconExpand } from "@/generation/components/icons";

/** 选中的图以自身像素居中放在画布原点。 */
export function imageBox(item: Pick<Artwork, "width" | "height">): Box {
  const w = item.width || 832;
  const h = item.height || 1216;
  return { x: -w / 2, y: -h / 2, w, h };
}

type Pan = { id: number; sx: number; sy: number; cam: Camera; moved: boolean };

/**
 * 中间只预览当前选中的一张图。
 * 拖拽平移，滚轮缩放，双击空白处回到适应窗口。
 */
export function AlbumCanvas({ item, empty }: { item: Artwork | null; empty: string | null }) {
  const box = item ? imageBox(item) : null;
  const viewRef = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, z: 1 });
  const camRef = useRef(cam);
  camRef.current = cam;
  const pan = useRef<Pan | null>(null);
  const ready = useRef(false);
  const [ease, setEase] = useState(false);
  const easeRef = useRef(false);
  const boxRef = useRef(box);
  boxRef.current = box;

  function viewSize() {
    const el = viewRef.current;
    return { w: el?.clientWidth || 1, h: el?.clientHeight || 1 };
  }

  function stopEase() {
    if (!easeRef.current) return;
    easeRef.current = false;
    setEase(false);
  }

  function moveCam(next: Camera, animated: boolean) {
    easeRef.current = animated;
    setEase(animated);
    setCam(next);
  }

  function fit() {
    const current = boxRef.current;
    if (!current) return;
    const { w, h } = viewSize();
    moveCam(fitCamera(current, w, h, 0.86), true);
  }

  useLayoutEffect(() => {
    if (!box) {
      ready.current = false;
      return;
    }
    const first = !ready.current;
    ready.current = true;
    const { w, h } = viewSize();
    moveCam(fitCamera(box, w, h, 0.86), !first);
    // 换图时重新适应窗口。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.width, item?.height]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      stopEase();
      const c = camRef.current;
      setCam(zoomAt(c, e.clientX - r.left, e.clientY - r.top, c.z * Math.exp(-e.deltaY * 0.0015)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [item?.id]);

  function onDown(e: ReactPointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest(".cv-hud")) return;
    if (e.button !== 0 && e.button !== 1) return;
    stopEase();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pan.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, cam: camRef.current, moved: false };
  }

  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    const p = pan.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.sx;
    const dy = e.clientY - p.sy;
    if (Math.abs(dx) + Math.abs(dy) > 2) p.moved = true;
    setCam({ ...p.cam, x: p.cam.x + dx, y: p.cam.y + dy });
  }

  function onUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (pan.current?.id === e.pointerId) pan.current = null;
  }

  if (!item || !box) {
    return empty ? <p className="album-empty">{empty}</p> : null;
  }

  return (
    <div
      ref={viewRef}
      className="cv"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onAuxClick={(e) => e.preventDefault()}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest(".cv-hud")) fit();
      }}
    >
      <div
        className={`cv-world${ease ? " ease" : ""}`}
        style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`, visibility: ready.current ? "visible" : "hidden" }}
      >
        <div className="cv-cell on" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
          <img src={item.imageUrl} alt="" draggable={false} />
        </div>
      </div>
      <div className="cv-hud">
        <span className="mchip">{Math.round(cam.z * 100)}%</span>
        <button className="sbtn" type="button" title="适应窗口（双击画布）" onClick={fit}>
          <IconExpand />
        </button>
      </div>
    </div>
  );
}
