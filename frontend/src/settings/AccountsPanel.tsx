import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { generationApi } from "@/api";
import { queryKeys } from "@/data/queryKeys";
import type { NaiAccount, NaiAccountPatch, NaiAccountsData, NaiChannel } from "@/data/types";
import { confirmDialog } from "@/state/confirm";
import { useNaiAccountsQuery } from "@/state/queries";
import { pushToast } from "@/state/toast";
import { Card, Segmented, Switch } from "./controls";

const CHANNEL_LABEL: Record<NaiChannel, string> = { official: "官方", gateway: "自建网关" };

function errText(err: unknown) {
  return err instanceof Error ? err.message : "操作失败";
}

/** 这个账号当前会被怎样使用，一句话说清楚。 */
function modeText(a: NaiAccount): { text: string; kind: "ok" | "warn" | "off" } {
  if (!a.configured) return { text: "还没有填 Token，无法使用", kind: "warn" };
  if (!a.enabled) return { text: "已停用：不参与生图", kind: "off" };
  if (a.useFree && a.usePoints) return { text: "免费额度和点数都可以用", kind: "ok" };
  if (a.useFree) return { text: "只用免费额度：需要花点数的生图会跳过此账号", kind: "ok" };
  if (a.usePoints) return { text: "只用点数：会动用免费额度的生图会跳过此账号", kind: "ok" };
  return { text: "免费额度和点数都已关闭，不会被选中", kind: "warn" };
}

function QuotaChips({ account }: { account: NaiAccount }) {
  const sub = account.subscription;
  if (!account.configured) return null;
  if (!sub) {
    return (
      <div className="s-acct-quota">
        <span className="s-chip dim">{account.error || "额度读取中…"}</span>
      </div>
    );
  }
  const extra = Number(sub.usagePurchasedPercent);
  return (
    <div className="s-acct-quota">
      <span className="s-chip strong">{sub.tierName || (sub.opus ? "Opus" : "订阅中")}</span>
      <span className="s-chip">点数 {sub.anlas ?? 0}</span>
      <span className="s-chip dim">固定 {sub.anlasFixed ?? 0}</span>
      <span className="s-chip dim">购买 {sub.anlasPurchased ?? 0}</span>
      {sub.opus && sub.usagePercent != null ? (
        <span className={`s-chip${sub.usageNegative ? " bad" : ""}`}>Opus 免费额度 {sub.usageNegative ? 0 : Math.round(Number(sub.usagePercent))}%</span>
      ) : null}
      {Number.isFinite(extra) && extra > 0 ? <span className="s-chip">额外 +{Math.round(extra)}%</span> : null}
    </div>
  );
}

function ModeTile({ title, desc, checked, disabled, onChange }: { title: string; desc: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`s-mode${checked && !disabled ? " on" : ""}${disabled ? " disabled" : ""}`}>
      <div className="s-mode-text">
        <div className="s-mode-title">{title}</div>
        <div className="s-mode-desc">{desc}</div>
      </div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} label={title} />
    </div>
  );
}

/** 新增 / 编辑一个账号：名称、渠道、网关地址、Token。 */
function AccountEditor({ account, onSubmit, onCancel }: { account?: NaiAccount; onSubmit: (patch: NaiAccountPatch) => Promise<boolean>; onCancel: () => void }) {
  const [name, setName] = useState(account?.name ?? "");
  const [channel, setChannel] = useState<NaiChannel>(account?.channel ?? "official");
  const [gatewayUrl, setGatewayUrl] = useState(account?.gatewayUrl ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const isNew = !account;
  const needToken = isNew && !token.trim();
  const gatewayMissing = channel === "gateway" && !/^https?:\/\//i.test(gatewayUrl.trim());

  const submit = async () => {
    setBusy(true);
    const patch: NaiAccountPatch = { name: name.trim(), channel, gatewayUrl: channel === "gateway" ? gatewayUrl.trim() : "" };
    if (token.trim()) patch.token = token.trim();
    const ok = await onSubmit(patch);
    setBusy(false);
    if (ok) setToken("");
  };

  return (
    <div className="s-acct-edit">
      <label className="s-field">
        <span className="s-field-label">名称</span>
        <input className="s-input" placeholder="例如：主号 / 公益网关" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="s-field">
        <span className="s-field-label">渠道</span>
        <Segmented
          options={[
            { value: "official", label: CHANNEL_LABEL.official },
            { value: "gateway", label: CHANNEL_LABEL.gateway },
          ]}
          value={channel}
          onChange={(v) => setChannel(v as NaiChannel)}
        />
      </div>
      {channel === "gateway" ? (
        <label className="s-field">
          <span className="s-field-label">网关地址</span>
          <input className="s-input" placeholder="https://moyan.ink" spellCheck={false} value={gatewayUrl} onChange={(e) => setGatewayUrl(e.target.value)} />
          <span className="s-row-hint">走自己的网关就填它的地址，Token 处填网关发的 sk- Key。网关一般不提供额度查询。</span>
        </label>
      ) : null}
      <label className="s-field">
        <span className="s-field-label">Token</span>
        <input
          type="password"
          className="s-input"
          autoComplete="off"
          placeholder={isNew ? (channel === "gateway" ? "sk-…" : "pst-…") : `已保存 ${account.hint}，留空则不修改`}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <span className="s-row-hint">在 NovelAI 账号设置里复制 Persistent API Token。明文只保存在本机文件，不会进入事件库和备份。</span>
      </label>
      <div className="s-acct-edit-actions">
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || needToken || gatewayMissing} onClick={() => void submit()}>
          {isNew ? "添加账号" : "保存修改"}
        </button>
      </div>
    </div>
  );
}

function AccountItem({
  account,
  index,
  count,
  editing,
  onEdit,
  onPatch,
  onMove,
  onRemove,
}: {
  account: NaiAccount;
  index: number;
  count: number;
  editing: boolean;
  onEdit: (open: boolean) => void;
  onPatch: (patch: NaiAccountPatch) => Promise<boolean>;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const mode = modeText(account);
  const sub = account.subscription;
  const noFreeQuota = Boolean(sub) && !sub?.opus;
  const dim = !account.enabled || !account.configured;
  const dot = !account.configured || !account.enabled ? "" : account.error && !sub ? "err" : "ok";
  const toggles = !account.enabled || !account.configured;
  return (
    <article className={`s-acct${dim ? " off" : ""}`}>
      <header className="s-acct-head">
        <span className="s-acct-rank" title="优先级：数字越小越先用">
          {index + 1}
        </span>
        <span className={`dot ${dot}`} />
        <div className="s-acct-title">
          <b>{account.name}</b>
          <span className={`s-chip channel ${account.channel}`}>{CHANNEL_LABEL[account.channel]}</span>
          {account.configured ? <span className="s-acct-token">{account.hint}</span> : null}
        </div>
        <div className="s-acct-tools">
          <button type="button" className="s-icon-btn" title="提高优先级" disabled={index === 0} onClick={() => onMove(-1)}>
            <ChevronUp size={15} />
          </button>
          <button type="button" className="s-icon-btn" title="降低优先级" disabled={index === count - 1} onClick={() => onMove(1)}>
            <ChevronDown size={15} />
          </button>
          <button type="button" className={`s-icon-btn${editing ? " on" : ""}`} title="编辑" onClick={() => onEdit(!editing)}>
            <Pencil size={14} />
          </button>
          <button type="button" className="s-icon-btn danger" title="删除" onClick={onRemove}>
            <Trash2 size={14} />
          </button>
          <Switch checked={account.enabled} onChange={(v) => void onPatch({ enabled: v })} label={`启用 ${account.name}`} />
        </div>
      </header>

      <QuotaChips account={account} />

      <div className="s-acct-modes">
        <ModeTile
          title="使用免费额度"
          desc={noFreeQuota ? "这个账号不是 Opus，没有免费额度" : "Opus 小图：≤1024×1024 且 ≤28 步"}
          checked={account.useFree}
          disabled={toggles || noFreeQuota}
          onChange={(v) => void onPatch({ useFree: v })}
        />
        <ModeTile title="使用点数" desc="超出免费范围的部分扣 Anlas 点数" checked={account.usePoints} disabled={toggles} onChange={(v) => void onPatch({ usePoints: v })} />
      </div>

      <div className={`s-acct-note ${mode.kind}`}>{mode.text}</div>

      {editing ? (
        <AccountEditor
          account={account}
          onCancel={() => onEdit(false)}
          onSubmit={async (patch) => {
            const ok = await onPatch(patch);
            if (ok) onEdit(false);
            return ok;
          }}
        />
      ) : null}
    </article>
  );
}

/** 账号与渠道：多个账号并排管理，每个账号独立开关「免费额度 / 点数」，按列表顺序挑第一个能承担这次生图的账号。 */
export function AccountsPanel() {
  const qc = useQueryClient();
  const q = useNaiAccountsQuery();
  const accounts = q.data?.accounts ?? [];
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.naiAccounts });
    void qc.invalidateQueries({ queryKey: queryKeys.naiStatus });
  };
  const setLocal = (fn: (list: NaiAccount[]) => NaiAccount[]) =>
    qc.setQueryData<NaiAccountsData>(queryKeys.naiAccounts, (old) => (old ? { ...old, accounts: fn(old.accounts) } : old));

  const patch = async (id: string, p: NaiAccountPatch): Promise<boolean> => {
    // 开关类改动先在界面上生效，失败再回滚
    const { token: _token, ...local } = p;
    setLocal((list) => list.map((a) => (a.id === id ? { ...a, ...local } : a)));
    try {
      await generationApi.saveAccount(id, p);
      refresh();
      return true;
    } catch (err) {
      pushToast(errText(err), "error");
      refresh();
      return false;
    }
  };

  const create = async (p: NaiAccountPatch): Promise<boolean> => {
    try {
      await generationApi.saveAccount(null, p);
      pushToast("已添加账号");
      setAdding(false);
      refresh();
      return true;
    } catch (err) {
      pushToast(errText(err), "error");
      return false;
    }
  };

  const move = async (index: number, dir: -1 | 1) => {
    const next = [...accounts];
    const to = index + dir;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    setLocal(() => next);
    try {
      await generationApi.reorderAccounts(next.map((a) => a.id));
      refresh();
    } catch (err) {
      pushToast(errText(err), "error");
      refresh();
    }
  };

  const remove = async (a: NaiAccount) => {
    if (!(await confirmDialog(`删除账号「${a.name}」？它的 Token 会从本机删除。`, { title: "删除账号", confirmText: "删除" }))) return;
    try {
      await generationApi.deleteAccount(a.id);
      pushToast("已删除账号");
      if (editingId === a.id) setEditingId(null);
      refresh();
    } catch (err) {
      pushToast(errText(err), "error");
    }
  };

  const usable = accounts.filter((a) => a.enabled && a.configured).length;

  return (
    <>
      <Card
        title="NovelAI 账号"
        right={
          <button type="button" className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
            {adding ? "收起" : "添加账号"}
          </button>
        }
      >
        <div className="s-acct-intro">
          共 {accounts.length} 个账号，{usable} 个可用。生图时按下面的顺序，挑第一个开关允许、点数也够的账号；自建网关查不到额度时，只看开关。
        </div>

        {adding ? (
          <div className="s-acct s-acct-new">
            <div className="s-acct-new-title">新账号</div>
            <AccountEditor onCancel={() => setAdding(false)} onSubmit={create} />
          </div>
        ) : null}

        {accounts.length === 0 && !adding ? (
          <div className="s-acct-empty">
            <p>还没有账号。</p>
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              添加第一个账号
            </button>
          </div>
        ) : null}

        <div className="s-acct-list">
          {accounts.map((a, i) => (
            <AccountItem
              key={a.id}
              account={a}
              index={i}
              count={accounts.length}
              editing={editingId === a.id}
              onEdit={(open) => setEditingId(open ? a.id : null)}
              onPatch={(p) => patch(a.id, p)}
              onMove={(dir) => void move(i, dir)}
              onRemove={() => void remove(a)}
            />
          ))}
        </div>
        {q.data?.file ? <div className="s-row-hint s-acct-file">账号文件：{q.data.file}</div> : null}
      </Card>
    </>
  );
}
