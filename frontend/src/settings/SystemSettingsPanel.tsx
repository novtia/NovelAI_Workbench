import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Terminal, Trash2 } from "lucide-react";
import { settingsApi } from "@/api";
import { formatBytes, type SystemInfo } from "@/data/settings";
import { clearLogs, exportLogsText, filterLogs, formatLogTime, openDevtools, useDebugLogs, type LogEntry } from "@/lib/logger";
import { useSettings, useSettingsStore } from "@/state/settingsStore";
import { pushToast } from "@/state/toast";
import { findSection } from "./catalog";
import { Card, SettingRow } from "./controls";

type ConsoleFilter = "all" | "fe" | "rust" | "warn";

const BUCKET_META: Array<{ key: string; label: string; cls: string }> = [
  { key: "favorites", label: "收藏夹", cls: "fav" },
  { key: "studio", label: "生图室", cls: "studio" },
  { key: "lottery", label: "抽奖", cls: "lottery" },
  { key: "inputs", label: "底图输入", cls: "inputs" },
  { key: "legacy", label: "未整理", cls: "legacy" },
];

function formatDetail(detail: unknown): string {
  if (detail === undefined) return "";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const detailStr = useMemo(() => formatDetail(entry.detail), [entry.detail]);
  const long = detailStr.length > 110;
  const originLabel = entry.origin === "rust" ? "RUST" : "FE";

  return (
    <div className={`sys-log-row lvl-${entry.level}${long ? " expandable" : ""}`} onClick={() => long && setExpanded((v) => !v)}>
      <span className="sys-log-ts">{entry.ts || formatLogTime(entry.at)}</span>
      <span className={`sys-log-scope ${entry.origin}`}>
        {originLabel}:{entry.scope}
      </span>
      <span className={`sys-log-lvl lvl-${entry.level}`}>{entry.level.toUpperCase()}</span>
      <span className="sys-log-msg">
        <span className="sys-log-ev">{entry.event}</span>
        {detailStr ? <span className={`sys-log-detail${expanded ? " open" : ""}`}>{detailStr}</span> : null}
      </span>
    </div>
  );
}

function StorageDistribution({ info, onOpenData }: { info?: SystemInfo; onOpenData: () => void }) {
  const segments = useMemo(() => {
    if (!info) return [];
    const list: Array<{ key: string; label: string; cls: string; bytes: number; count?: number }> = [];
    for (const meta of BUCKET_META) {
      const row = info.buckets?.[meta.key];
      if (row && row.bytes > 0) {
        list.push({ key: meta.key, label: meta.label, cls: meta.cls, bytes: row.bytes, count: row.count });
      }
    }
    if (info.dbBytes > 0) {
      list.push({ key: "db", label: "事件数据库", cls: "db", bytes: info.dbBytes });
    }
    return list;
  }, [info]);

  const totalBytes = useMemo(() => segments.reduce((sum, s) => sum + s.bytes, 0), [segments]);

  return (
    <Card
      title="存储分布"
      right={
        <button type="button" className="mini" onClick={onOpenData}>
          前往数据维护 →
        </button>
      }
    >
      {!info ? (
        <div className="s-row-hint">正在读取存储分布…</div>
      ) : (
        <div className="sys-dist">
          <div className="sys-dist-head">
            <span>总计 {formatBytes(totalBytes)}</span>
            <span className="sys-dist-sub">{info.blobCount} 个图片文件 · {info.events} 条事件</span>
          </div>
          <div className="sys-dist-bar" role="img" aria-label="存储占用分布条">
            {segments.length === 0 ? (
              <span className="sys-dist-seg empty" style={{ width: "100%" }} />
            ) : (
              segments.map((s) => {
                const pct = totalBytes > 0 ? Math.max(2.5, (s.bytes / totalBytes) * 100) : 0;
                return (
                  <span
                    key={s.key}
                    className={`sys-dist-seg ${s.cls}`}
                    style={{ width: `${pct}%` }}
                    title={`${s.label}：${formatBytes(s.bytes)}`}
                  />
                );
              })
            )}
          </div>
          <div className="sys-dist-legend">
            {segments.map((s) => (
              <div key={s.key} className="sys-legend-item">
                <i className={`sys-legend-dot ${s.cls}`} />
                <span className="sys-legend-name">{s.label}</span>
                <span className="sys-legend-val">
                  {s.count !== undefined ? `${s.count} · ` : ""}
                  {formatBytes(s.bytes)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

export function SystemSettingsPanel({ onNavigateData }: { onNavigateData: () => void }) {
  const sys = useSettings((s) => s.system);
  const setSetting = useSettingsStore((s) => s.set);
  const infoQ = useQuery({ queryKey: ["system-info"], queryFn: settingsApi.getSystemInfo, staleTime: 0 });
  const logs = useDebugLogs();

  const [filter, setFilter] = useState<ConsoleFilter>("all");
  const [query, setQuery] = useState("");
  const [stickBottom, setStickBottom] = useState(true);
  const consoleRef = useRef<HTMLDivElement>(null);

  const systemSection = findSection("system");
  const runtimeGroup = systemSection.groups[0];
  const debugGroup = systemSection.groups[1];

  const visibleLogs = useMemo(
    () =>
      filterLogs(logs, {
        origin: filter === "fe" ? "fe" : filter === "rust" ? "rust" : "all",
        onlyWarn: filter === "warn",
        query,
      }),
    [logs, filter, query],
  );

  useEffect(() => {
    if (!stickBottom || !consoleRef.current) return;
    consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [visibleLogs.length, stickBottom]);

  const info = infoQ.data;

  const copyDataDir = async () => {
    if (!info?.dataDir) return;
    try {
      await navigator.clipboard.writeText(info.dataDir);
      pushToast("已复制数据目录");
    } catch {
      pushToast("复制失败", "warn");
    }
  };

  const copyLogs = async () => {
    const text = exportLogsText(query, visibleLogs);
    if (!text) {
      pushToast("当前没有可复制的日志", "warn");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      pushToast(`已复制 ${visibleLogs.length} 条日志`);
    } catch {
      pushToast("复制失败", "warn");
    }
  };

  return (
    <div className="sys-panel">
      {/* 顶部系统铭牌 */}
      <section className="sys-hero">
        <div className="sys-hero-top">
          <div className="sys-seal" aria-hidden="true">
            系
          </div>
          <div className="sys-hero-id">
            <div className="sys-hero-title">
              <strong>画师串工作台</strong>
              <span className="sys-ver">{info ? `v${info.version}` : "v0.1.0"}</span>
              <span className={`sys-status-pill${sys.debugMode ? " on" : ""}`}>
                <i className="sys-status-dot" />
                {sys.debugMode ? "调试已开启" : "常规运行"}
              </span>
            </div>
            <div className="sys-hero-path">
              <span>数据目录</span>
              <code>{info?.dataDir || "读取中…"}</code>
              {info?.dataDir ? (
                <button type="button" className="sys-copy-btn" title="复制数据目录" onClick={() => void copyDataDir()}>
                  <Copy />
                </button>
              ) : null}
            </div>
          </div>
          <div className="sys-hero-act">
            <button
              type="button"
              className={`btn${sys.debugMode ? " btn-primary" : ""}`}
              disabled={!sys.debugMode}
              title={sys.debugMode ? "打开开发者控制台（快捷键 F12）" : "请先开启下方「启用调试模式」"}
              onClick={() => openDevtools()}
            >
              <Terminal />
              <span>打开控制台</span>
            </button>
          </div>
        </div>

        <div className="sys-metrics">
          <div className="sys-metric">
            <span className="sys-metric-k">事件总量</span>
            <strong className="sys-metric-v">{info ? info.events.toLocaleString() : "—"}</strong>
          </div>
          <div className="sys-metric">
            <span className="sys-metric-k">收藏夹 / 作品</span>
            <strong className="sys-metric-v">{info ? `${info.albums} / ${info.artworks}` : "—"}</strong>
          </div>
          <div className="sys-metric">
            <span className="sys-metric-k">图片体积</span>
            <strong className="sys-metric-v">{info ? formatBytes(info.blobBytes) : "—"}</strong>
          </div>
          <div className="sys-metric">
            <span className="sys-metric-k">数据库大小</span>
            <strong className="sys-metric-v">{info ? formatBytes(info.dbBytes) : "—"}</strong>
          </div>
        </div>
      </section>

      {/* 存储分布条 */}
      <StorageDistribution info={info} onOpenData={onNavigateData} />

      {/* 运行与传输 */}
      <Card title={runtimeGroup.title}>
        {runtimeGroup.items.map((item) => (
          <SettingRow key={`${item.section}.${item.key}`} item={item} />
        ))}
      </Card>

      {/* 调试与实时日志台 */}
      <Card
        title={debugGroup.title}
        right={
          <div className="sys-debug-head-acts">
            <button type="button" className="mini" disabled={!sys.debugMode} onClick={() => openDevtools()} title="打开 DevTools 控制台 (F12)">
              打开控制台
            </button>
            <button type="button" className="mini" disabled={visibleLogs.length === 0} onClick={() => void copyLogs()}>
              复制 ({visibleLogs.length})
            </button>
            <button
              type="button"
              className="mini"
              disabled={logs.length === 0}
              onClick={() => {
                clearLogs();
                pushToast("已清空日志");
              }}
            >
              <Trash2 />
            </button>
          </div>
        }
      >
        {debugGroup.items.map((item) => (
          <SettingRow key={`${item.section}.${item.key}`} item={item} />
        ))}

        <div className="sys-console-wrap">
          <div className="sys-console-bar">
            <div className="seg-bar s-seg" role="tablist" aria-label="日志来源筛选">
              {(
                [
                  ["all", "全部"],
                  ["fe", "前端 FE"],
                  ["rust", "后端 RUST"],
                  ["warn", "警告/错误"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" className={filter === id ? "on" : ""} onClick={() => setFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
            <input
              type="search"
              className="search sys-console-search"
              placeholder="过滤模块、事件名或参数…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="sys-stick">
              <input type="checkbox" checked={stickBottom} onChange={(e) => setStickBottom(e.target.checked)} />
              <span>滚底</span>
            </label>
          </div>

          <div
            className={`sys-console${sys.debugMode ? "" : " muted"}`}
            ref={consoleRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
              if (atBottom !== stickBottom) setStickBottom(atBottom);
            }}
          >
            {!sys.debugMode ? (
              <div className="sys-console-empty">
                <p>调试模式当前已关闭，不会在控制台打印常规调试日志。</p>
                <button type="button" className="btn" onClick={() => setSetting("system", "debugMode", true)}>
                  立即启用调试模式
                </button>
              </div>
            ) : visibleLogs.length === 0 ? (
              <div className="sys-console-empty">
                <p>{logs.length === 0 ? "已就绪：点击生图、修改设置或切换队列即可在此看到实时模块日志。" : "没有匹配当前筛选条件的日志。"}</p>
              </div>
            ) : (
              visibleLogs.map((entry) => <LogRow key={entry.id} entry={entry} />)
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
