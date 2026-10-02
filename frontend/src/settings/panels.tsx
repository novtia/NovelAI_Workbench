import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { lotteryApi, settingsApi } from "@/api";
import { boardPayload } from "@/data/lottery";
import { queryKeys } from "@/data/queryKeys";
import { useLotteryStore } from "@/state/lotteryStore";
import { formatBytes, type SystemInfo } from "@/data/settings";
import { formatTokenStatus, tokenDotClass } from "@/data/studio";
import { LS_DRAFT, LS_IMPORT_OPTS, LS_SELECTED_SET } from "@/data/studio";
import { confirmDialog } from "@/state/confirm";
import { pushToast } from "@/state/toast";
import { useNaiStatusQuery } from "@/state/queries";
import { useStudioActions } from "@/state/studio";
import { useStudioStore } from "@/state/studioStore";
import { getSettings, useSettingsStore } from "@/state/settingsStore";
import { Card } from "./controls";

export function TokenPanel() {
  const tokenInput = useStudioStore((s) => s.tokenInput);
  const setTokenInput = useStudioStore((s) => s.setTokenInput);
  const { saveToken, clearToken } = useStudioActions();
  const status = useNaiStatusQuery().data || null;
  const sub = status?.subscription;
  const detail = sub
    ? [`固定 ${sub.anlasFixed ?? 0}`, `购买 ${sub.anlasPurchased ?? 0}`, sub.usagePercent != null ? `Opus ${sub.usagePercent}%` : ""].filter(Boolean).join(" · ")
    : status?.error || "";
  return (
    <div className="s-token">
      <div className="s-token-line">
        <span className={`dot ${tokenDotClass(status)}`} />
        <span>{formatTokenStatus(status)}</span>
      </div>
      {detail ? <div className="s-row-hint">{detail}</div> : null}
      <div className="s-row-hint">在 NovelAI 账号设置里复制 Persistent API Token。明文只保存在 backend/data/secrets/nai.token，不会进入事件库和备份。</div>
      <div className="s-token-form">
        <input
          type="password"
          className="s-input"
          placeholder="pst-…"
          autoComplete="off"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
        />
        <button type="button" className="btn btn-primary" onClick={() => void saveToken()}>
          保存
        </button>
        <button type="button" className="btn" onClick={() => void clearToken()}>
          清除
        </button>
      </div>
    </div>
  );
}

/** 把当前「抽奖」默认参数写入已有的抽奖台（保留排除/置顶/权重上限与预设）。 */
export function LotteryApplyPanel() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    try {
      const { min, max, draws, target, wmin, wmax, jitter, boost } = getSettings().lottery;
      const board = await lotteryApi.getBoard();
      const saved = await lotteryApi.saveBoard(boardPayload(board, { min, max, draws, target, wmin, wmax, jitter, boost }));
      qc.setQueryData(queryKeys.lotteryBoard, saved);
      const store = useLotteryStore.getState();
      store.setControls(saved.controls);
      store.setBoardVersion(saved.version ?? 0);
      store.setDirty(false);
      pushToast("已应用到当前抽奖台");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "应用失败", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="s-row">
      <div className="s-row-main">
        <div className="s-row-label">应用到当前抽奖台</div>
        <div className="s-row-hint">默认参数只在「重置」与新建抽奖台时生效；需要立刻覆盖现有抽奖台时点这里。</div>
      </div>
      <button type="button" className="btn" disabled={busy} onClick={() => void apply()}>
        应用
      </button>
    </div>
  );
}

function InfoGrid({ info }: { info: SystemInfo }) {
  const rows: Array<[string, string]> = [
    ["版本", info.version],
    ["服务端口", info.port ? String(info.port) : "—"],
    ["数据目录", info.dataDir],
    ["数据库大小", formatBytes(info.dbBytes)],
    ["事件数", String(info.events)],
    ["收藏夹 / 图片", `${info.albums} / ${info.artworks}`],
    ["图片文件", `${info.blobCount} 个 · ${formatBytes(info.blobBytes)}`],
  ];
  return (
    <dl className="s-info">
      {rows.map(([k, v]) => (
        <div key={k} className="s-info-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const LOCAL_KEYS = [LS_DRAFT, LS_IMPORT_OPTS, LS_SELECTED_SET, "wb.testRuns"];

export function SystemPanel() {
  const qc = useQueryClient();
  const settings = useSettingsStore((s) => s.settings);
  const reset = useSettingsStore((s) => s.reset);
  const replaceAll = useSettingsStore((s) => s.replaceAll);
  const infoQ = useQuery({ queryKey: ["system-info"], queryFn: settingsApi.getSystemInfo, staleTime: 0 });
  const [busy, setBusy] = useState("");
  const [report, setReport] = useState<string[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run<T>(name: string, fn: () => Promise<T>) {
    setBusy(name);
    try {
      return await fn();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "操作失败", "error");
      return undefined;
    } finally {
      setBusy("");
    }
  }

  const verify = () =>
    run("verify", async () => {
      const r = await settingsApi.verifyIntegrity();
      const lines = [
        r.ok ? "整体校验通过" : "发现问题",
        `事件链：${r.chain.ok ? "完好" : "异常"}（${r.chain.events} 条事件）`,
        `图片引用 ${r.blobs.referenced} 个，缺失 ${r.blobs.missing.length}，损坏 ${r.blobs.mismatch.length}`,
        `投影重放：${r.projections.match ? "一致" : "不一致"}`,
        ...r.chain.errors.slice(0, 5),
      ];
      setReport(lines);
      pushToast(r.ok ? "完整性校验通过" : "完整性校验发现问题", r.ok ? "ok" : "warn");
    });

  const rebuild = async () => {
    if (!(await confirmDialog("从事件流重建所有查询投影？数据不会丢，但可能需要几秒。", { title: "重建投影", confirmText: "重建" }))) return;
    void run("rebuild", async () => {
      const r = await settingsApi.rebuildProjections();
      setReport([`已重放 ${r.rebuilt} 条事件`, `事件链：${r.chain.ok ? "完好" : "异常"}`]);
      void qc.invalidateQueries();
      pushToast("投影已重建");
    });
  };

  const backup = () =>
    run("backup", async () => {
      const r = await settingsApi.backupHint();
      setReport([r.note, ...r.copy]);
    });

  const exportSettings = () => {
    const blob = new Blob([JSON.stringify({ app: "minimax-workbench", settings }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "workbench-settings.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importSettings = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { settings?: unknown };
      const data = parsed && typeof parsed === "object" && "settings" in parsed ? parsed.settings : parsed;
      await replaceAll(data);
      pushToast("设置已导入");
    } catch (err) {
      pushToast(err instanceof Error ? `导入失败：${err.message}` : "导入失败", "error");
    }
  };

  const clearLocal = async () => {
    if (!(await confirmDialog("清除浏览器本地缓存的生图草稿、导入勾选、测试集映射？图库数据和服务端设置不受影响。", { title: "清除本地缓存", confirmText: "清除" }))) return;
    for (const key of LOCAL_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    pushToast("本地缓存已清除，刷新页面后生效");
  };

  return (
    <>
      <Card
        title="存储信息"
        right={
          <button type="button" className="mini" onClick={() => void infoQ.refetch()} disabled={infoQ.isFetching}>
            {infoQ.isFetching ? "读取中…" : "刷新"}
          </button>
        }
      >
        {infoQ.data ? <InfoGrid info={infoQ.data} /> : <div className="s-row-hint">{infoQ.isError ? "无法读取存储信息" : "读取中…"}</div>}
      </Card>

      <Card title="数据维护">
        <div className="s-actions">
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void verify()}>
            {busy === "verify" ? "校验中…" : "校验完整性"}
          </button>
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={rebuild}>
            {busy === "rebuild" ? "重建中…" : "重建投影"}
          </button>
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void backup()}>
            备份说明
          </button>
        </div>
        <div className="s-row-hint">校验会检查事件哈希链、图片文件是否缺失/损坏，并对比重放后的投影。备份只需复制 events.sqlite 与 blobs/。</div>
        {report ? (
          <pre className="s-report">{report.join("\n")}</pre>
        ) : null}
      </Card>

      <Card title="设置的导入与导出">
        <div className="s-actions">
          <button type="button" className="btn" onClick={exportSettings}>
            导出设置 JSON
          </button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            导入设置 JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importSettings(f);
            }}
          />
        </div>
        <div className="s-row-hint">导入会整体替换当前设置（文件里缺的项回到默认值）。</div>
      </Card>

      <Card title="重置与清理">
        <div className="s-actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              void confirmDialog("把所有设置恢复为默认值？图库和历史数据不受影响。", { title: "恢复全部默认", confirmText: "恢复" }).then((ok) => {
                if (ok) void reset().then(() => pushToast("已恢复全部默认设置"));
              });
            }}
          >
            恢复全部默认设置
          </button>
          <button type="button" className="btn" onClick={clearLocal}>
            清除本地缓存
          </button>
        </div>
        <div className="s-row-hint">本地缓存包括生图草稿、导入元数据勾选项、测试集与预设的对应关系。</div>
      </Card>
    </>
  );
}
