import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { boundsOf, canvasLayout, cellOfShot, fitCamera, groupOfShot, scrollCamera, shotNearest, zoomAt, type Box, type Camera } from "@/data/studioCanvas";
import type { StudioShot } from "@/data/types";
import { useStudioActions, useStudioStore } from "@/state";
import { IconExpand } from "./icons";

type Pan = { id: number; sx: number; sy: number; cam: Camera; moved: boolean };

/**
 * 中间预览区是一张无限画布：所有会话图按任务排在上面。
 * 中键（或左键按在空白处）拖拽平移。按住 Ctrl 滚轮缩放；普通滚轮上下滚动，视口中心的图成为当前图。
 */
export function StudioCanvas({ fw, fh }: { fw: number; fh: number }) {
  const session = useStudioStore((s) => s.session);
  const currentId = useStudioStore((s) => s.currentId);
  const liveUrl = useStudioStore((s) => s.liveUrl);
  const { showShot } = useStudioActions();

  const groups = useMemo(() => canvasLayout(session, [fw, fh]), [session, fw, fh]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const showShotRef = useRef(showShot);
  showShotRef.current = showShot;
  const viewRef = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, z: 1 });
  const camRef = useRef(cam);
  camRef.current = cam;
  const pan = useRef<Pan | null>(null);
  // 滚轮切图、点选放大时，不要让对焦效果把镜头拉回整组。
  const selfPick = useRef(false);
  const ready = useRef(false);
  const [ease, setEase] = useState(false);
  const easeRef = useRef(false);

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

  function focusBox(box: Box, fill = 0.82) {
    const { w, h } = viewSize();
    moveCam(fitCamera(box, w, h, fill), true);
  }

  function focusCurrent() {
    const g = groupOfShot(groups, currentId);
    const box = g || boundsOf(groups);
    if (!box) return;
    const { w, h } = viewSize();
    moveCam(fitCamera(box, w, h), false);
  }

  /** 变体组里的一张：放大到接近铺满视口并居中。单张图的组本身就是这一张，不必再缩。 */
  function focusShot(id: string) {
    const g = groupOfShot(groups, id);
    const cell = cellOfShot(groups, id);
    if (!g || !cell || g.cells.length < 2) return;
    focusBox(cell, 0.92);
  }

  function fitAll() {
    const box = boundsOf(groups);
    const { w, h } = viewSize();
    if (box) moveCam(fitCamera(box, w, h, 0.9), true);
  }

  const currentGroupKey = groupOfShot(groups, currentId)?.key || "";
  useLayoutEffect(() => {
    if (selfPick.current) {
      selfPick.current = false;
      return;
    }
    focusCurrent();
    ready.current = true;
    // 只在当前图所在的任务块变化时对焦，不跟着格子尺寸抖动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGroupKey, currentId]);

  // 滚轮缩放要 preventDefault，React 的 onWheel 是 passive 的，只能手动挂。
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const c = camRef.current;
      stopEase();
      if (e.ctrlKey) {
        const step = 0.01;
        setCam(zoomAt(c, e.clientX - r.left, e.clientY - r.top, c.z * Math.exp(-e.deltaY * step)));
        return;
      }
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const next = scrollCamera(c, e.deltaY * unit);
      setCam(next);
      const shot = shotNearest(groupsRef.current, (el.clientWidth / 2 - next.x) / next.z, (el.clientHeight / 2 - next.y) / next.z);
      if (shot && shot.id !== currentIdRef.current) {
        selfPick.current = true;
        showShotRef.current(shot);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function onDown(e: ReactPointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.closest(".cv-hud")) return;
    const onCell = target.closest(".cv-cell");
    if (e.button === 1 || (e.button === 0 && !onCell)) {
      stopEase();
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      pan.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, cam: camRef.current, moved: false };
    }
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

  function pick(shot: StudioShot) {
    selfPick.current = true;
    if (shot.id !== currentId) showShot(shot);
    focusShot(shot.id);
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
        if (!(e.target as HTMLElement).closest(".cv-cell")) fitAll();
      }}
    >
      <div className={`cv-world${ease ? " ease" : ""}`} style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`, visibility: ready.current ? "visible" : "hidden" }}>
        {groups.map((g) =>
          g.cells.map((c) => {
            const shot = c.shot;
            const on = Boolean(shot && shot.id === currentId);
            const src = shot ? (shot.pending ? (on ? liveUrl : "") || shot.thumbUrl : shot.url || shot.thumbUrl) : c.src;
            const style = { left: c.x, top: c.y, width: c.w, height: c.h };
            const body = (
              <>
                {src ? <img src={src} alt="" draggable={false} /> : null}
                {shot?.pending && !src ? (
                  <span className="load-dots" aria-label="生成中">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : null}
                {c.badge ? <span className="var-badge">{c.badge}</span> : null}
              </>
            );
            return shot ? (
              <button
                key={c.key}
                type="button"
                className={`cv-cell${on ? " on" : ""}`}
                style={style}
                title={shot.pending ? "生成中" : "选中这张"}
                onClick={() => pick(shot)}
              >
                {body}
              </button>
            ) : (
              <div
                key={c.key}
                className="cv-cell original"
                style={style}
                title="原图"
                onClick={() => focusBox({ x: c.x, y: c.y, w: c.w, h: c.h }, 0.92)}
              >
                {body}
              </div>
            );
          }),
        )}
      </div>
      <div className="cv-hud">
        <span className="mchip">{Math.round(cam.z * 100)}%</span>
        <button className="sbtn" type="button" title="显示全部（双击空白处）" onClick={fitAll}>
          <IconExpand />
        </button>
      </div>
    </div>
  );
}
