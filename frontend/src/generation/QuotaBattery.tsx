import { useLayoutEffect, useRef } from "react";
import { emit, useNaiStatusQuery, useStudioStore } from "@/state";
import { extraUsagePercent, opusMeter } from "@/data";

export function QuotaBattery() {
  const q = useNaiStatusQuery();
  const quotaOpen = useStudioStore((s) => s.quotaOpen);
  const setQuotaOpen = useStudioStore((s) => s.setQuotaOpen);
  const meter = opusMeter(q.data);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const sub = q.data?.subscription;
  const opus = Boolean(sub?.opus);
  const pct = sub?.usagePercent;

  useLayoutEffect(() => {
    if (!quotaOpen || !btnRef.current || !popRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    popRef.current.style.left = `${Math.round(r.right + 8)}px`;
    popRef.current.style.bottom = `${Math.round(window.innerHeight - r.bottom)}px`;
    popRef.current.style.top = "auto";
  }, [quotaOpen]);

  const note = !q.data
    ? "暂时无法读取订阅信息。"
    : !q.data.configured
      ? "还没有保存 NovelAI Token，无法读取 Opus 额度。"
      : q.data.error && !sub
        ? q.data.error
        : "";
  const n = Math.max(0, Math.min(100, Number(pct)));
  const over = Boolean(sub?.usageNegative);
  const showMeter = !note && opus && pct != null && Number.isFinite(Number(pct));
  const extra = extraUsagePercent(sub);

  return (
    <>
      <button
        className={`act-battery${quotaOpen ? " open" : ""}`}
        id="act-battery"
        ref={btnRef}
        type="button"
        data-level={meter.level}
        style={{ ["--pct" as string]: meter.fill }}
        title={meter.title}
        aria-label={meter.title}
        aria-expanded={quotaOpen}
        onClick={(e) => {
          e.stopPropagation();
          setQuotaOpen(!quotaOpen);
        }}
      >
        <span className="bat" aria-hidden="true">
          <span className="bat-nub" />
          <span className="bat-shell">
            <span className="bat-fill" />
          </span>
        </span>
        <span className="bat-pct" id="act-battery-pct">
          {meter.shown}
        </span>
        <span className="bat-lab">Opus</span>
      </button>
      <div className={`pop-panel quota-pop${quotaOpen ? " open" : ""}`} id="act-quota-pop" ref={popRef} onClick={(e) => e.stopPropagation()}>
        <div className="pop-h">Opus 额度</div>
        {note ? (
          <p className="qp-note">{note}</p>
        ) : showMeter ? (
          <>
            <div className="qp-line">
              <span>{over ? "本月已超额" : "本月剩余"}</span>
              <b>
                {Math.round(over ? 0 : n)}
                <em>%{extra > 0 ? ` +${extra}%` : ""}</em>
              </b>
            </div>
            <div className="qp-bar" data-level={meter.level}>
              <i style={{ width: `${over ? 0 : n}%` }} />
              {extra > 0 && <i className="boost" style={{ width: `${Math.min(extra, 100 - (over ? 0 : n))}%` }} />}
            </div>
          </>
        ) : (
          <p className="qp-note">{sub?.tierName || "非 Opus"} 没有无限生图额度，生图消耗 Anlas。</p>
        )}
        {sub && (
          <div className="qp-anlas">
            <div>
              <small>合计</small>
              <b>{sub.anlas ?? "—"}</b>
            </div>
            <div>
              <small>固定</small>
              <b>{sub.anlasFixed ?? 0}</b>
            </div>
            <div>
              <small>购买</small>
              <b>{sub.anlasPurchased ?? 0}</b>
            </div>
          </div>
        )}
        <button
          type="button"
          className="qp-manage"
          onClick={(e) => {
            e.stopPropagation();
            setQuotaOpen(false);
            emit("generation.openToken");
          }}
        >
          管理 Token
        </button>
      </div>
    </>
  );
}
