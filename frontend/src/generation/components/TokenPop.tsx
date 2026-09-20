import { formatTokenStatus, tokenDotClass } from "@/data";
import { useStudio } from "@/state";

export function TokenPop() {
  const { pop, popPos, status, tokenInput, setTokenInput, saveToken, clearToken } = useStudio();
  const open = pop === "token";
  const sub = status?.subscription;
  const detail = sub
    ? [`固定 ${sub.anlasFixed ?? 0}`, `购买 ${sub.anlasPurchased ?? 0}`, sub.usagePercent != null ? `Opus ${sub.usagePercent}%` : ""]
        .filter(Boolean)
        .join(" · ")
    : status?.error || "";
  return (
    <div
      className={`pop-panel token-pop${open ? " open" : ""}`}
      id="st-token-pop"
      style={open ? { left: popPos.left, top: popPos.top } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="pop-h">NOVELAI TOKEN</div>
      <p className="token-help">在账号设置里复制 Persistent API Token，明文只写在 backend/data/secrets/nai.token。</p>
      <div className="token-status-line">
        <span className={`dot ${tokenDotClass(status)}`} />
        <span>{formatTokenStatus(status)}</span>
      </div>
      <p className="token-help">{detail}</p>
      <input type="password" placeholder="pst-…" autoComplete="off" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
      <div className="token-actions">
        <button type="button" id="gen-token-save" onClick={() => void saveToken()}>
          保存
        </button>
        <button type="button" onClick={() => void clearToken()}>
          清除
        </button>
      </div>
    </div>
  );
}
