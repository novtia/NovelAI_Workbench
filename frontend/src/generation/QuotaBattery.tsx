import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { emit, useNaiStatusQuery, useStudioStore } from "@/state";
import { opusMeter } from "@/data";

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

  let body: ReactNode;
  if (!q.data) body = <p className="quota-pop-meta">暂时无法读取订阅信息。</p>;
  else if (!q.data.configured) body = <p className="quota-pop-meta">还没有保存 NovelAI Token，无法读取 Opus 额度。</p>;
  else if (q.data.error && !sub) body = <p className="quota-pop-meta">{q.data.error}</p>;
  else if (opus && pct != null && Number.isFinite(Number(pct))) {
    const n = Math.max(0, Math.min(100, Number(pct)));
    const over = Boolean(sub?.usageNegative);
    const headline = over ? `已超额（${Math.round(n)}%）` : `剩余 ${Math.round(n)}%`;
    body = (
      <>
        <div className="quota-pop-meter" data-level={meter.level} style={{ ["--pct" as string]: over ? 0 : n }}>
          <span className="bat" aria-hidden="true">
            <span className="bat-nub" />
            <span className="bat-shell">
              <span className="bat-fill" />
            </span>
          </span>
          <div>
            <b>{headline}</b>
            <span>{over ? "本月无限额度已用超" : "本月 Opus 无限额度"}</span>
          </div>
        </div>
        <p className="quota-pop-meta">
          Anlas {sub?.anlas ?? "—"} · 固定 {sub?.anlasFixed ?? 0} · 购买 {sub?.anlasPurchased ?? 0}
        </p>
      </>
    );
  } else {
    body = <p className="quota-pop-meta">{sub?.tierName || "非 Opus"} · Anlas {sub?.anlas ?? "—"}。无限生图额度仅限 Opus。</p>;
  }

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
        <div>{body}</div>
        <button
          type="button"
          className="quota-pop-manage"
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
