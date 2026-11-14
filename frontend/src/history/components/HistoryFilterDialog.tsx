import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Search, X } from "lucide-react";
import {
  ASPECT_FILTER_LABELS,
  collectHistorySamplers,
  DATE_PRESET_LABELS,
  EMPTY_HISTORY_FILTER,
  filterHistoryShots,
  hasActiveHistoryFilter,
  MODE_FILTER_LABELS,
  MODEL_FILTER_LABELS,
  SAMPLER_LABEL,
  TYPE_FILTER_LABELS,
  type HistoryAspectFilter,
  type HistoryDatePreset,
  type HistoryFilter,
  type HistoryModeFilter,
  type HistoryModelFilter,
  type HistoryTypeFilter,
} from "@/data";
import type { HistoryShot } from "@/data/history";

type Props = {
  open: boolean;
  value: HistoryFilter;
  shots: HistoryShot[];
  hasNextPage: boolean;
  onClose: () => void;
  onApply: (next: HistoryFilter) => void;
};

const DATE_OPTIONS = Object.keys(DATE_PRESET_LABELS) as HistoryDatePreset[];
const TYPE_OPTIONS = Object.keys(TYPE_FILTER_LABELS) as HistoryTypeFilter[];
const ASPECT_OPTIONS = Object.keys(ASPECT_FILTER_LABELS) as HistoryAspectFilter[];
const MODEL_OPTIONS = Object.keys(MODEL_FILTER_LABELS) as HistoryModelFilter[];
const MODE_OPTIONS = Object.keys(MODE_FILTER_LABELS) as HistoryModeFilter[];

export function HistoryFilterDialog({ open, value, shots, hasNextPage, onClose, onApply }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<HistoryFilter>(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      setDraft(value);
      if (!el.open) el.showModal();
      queueMicrotask(() => inputRef.current?.focus());
    } else if (el.open) {
      el.close();
    }
  }, [open, value]);

  const samplers = useMemo(() => collectHistorySamplers(shots), [shots]);
  const previewCount = useMemo(() => filterHistoryShots(shots, draft).length, [shots, draft]);
  const dirty = hasActiveHistoryFilter(draft);

  return (
    <dialog
      className="modal h-filter-dialog"
      ref={ref}
      aria-labelledby="hf-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onApply(draft);
        }}
      >
        <div className="hf-head">
          <h3 id="hf-title">筛选历史记录</h3>
          <button className="icon-btn" type="button" title="关闭" aria-label="关闭" onClick={onClose}>
            <X />
          </button>
        </div>

        <div className="hf-body">
          <div className="hf-sec">
            <label className="hf-label" htmlFor="hf-query">
              关键词
            </label>
            <div className="hf-search-wrap">
              <Search className="hf-search-ico" aria-hidden="true" />
              <input
                ref={inputRef}
                id="hf-query"
                className="hf-search-input"
                type="search"
                autoComplete="off"
                placeholder="搜索提示词、负面词、画师、角色、Seed（空格分隔多词）"
                value={draft.query}
                onChange={(e) => setDraft((d) => ({ ...d, query: e.target.value }))}
              />
              {draft.query ? (
                <button
                  className="hf-search-clear"
                  type="button"
                  title="清空关键词"
                  aria-label="清空关键词"
                  onClick={() => {
                    setDraft((d) => ({ ...d, query: "" }));
                    inputRef.current?.focus();
                  }}
                >
                  <X />
                </button>
              ) : null}
            </div>
          </div>

          <div className="hf-sec">
            <span className="hf-label">日期范围</span>
            <div className="hf-pills">
              {DATE_OPTIONS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={draft.datePreset === k ? "on" : ""}
                  onClick={() => setDraft((d) => ({ ...d, datePreset: k }))}
                >
                  {DATE_PRESET_LABELS[k]}
                </button>
              ))}
            </div>
            {draft.datePreset === "custom" ? (
              <div className="hf-dates">
                <label>
                  <span>从</span>
                  <input
                    type="date"
                    value={draft.dateFrom}
                    max={draft.dateTo || undefined}
                    onChange={(e) => setDraft((d) => ({ ...d, dateFrom: e.target.value }))}
                  />
                </label>
                <label>
                  <span>至</span>
                  <input
                    type="date"
                    value={draft.dateTo}
                    min={draft.dateFrom || undefined}
                    onChange={(e) => setDraft((d) => ({ ...d, dateTo: e.target.value }))}
                  />
                </label>
              </div>
            ) : null}
          </div>

          <div className="hf-sec">
            <span className="hf-label">生成类型</span>
            <div className="hf-pills">
              {TYPE_OPTIONS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={draft.requestType === k ? "on" : ""}
                  onClick={() => setDraft((d) => ({ ...d, requestType: k }))}
                >
                  {TYPE_FILTER_LABELS[k]}
                </button>
              ))}
            </div>
          </div>

          <div className="hf-sec">
            <span className="hf-label">画幅方向</span>
            <div className="hf-pills">
              {ASPECT_OPTIONS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={draft.aspect === k ? "on" : ""}
                  onClick={() => setDraft((d) => ({ ...d, aspect: k }))}
                >
                  {ASPECT_FILTER_LABELS[k]}
                </button>
              ))}
            </div>
          </div>

          <div className="hf-grid-2">
            <div className="hf-sec">
              <span className="hf-label">模型</span>
              <div className="hf-pills">
                {MODEL_OPTIONS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={draft.model === k ? "on" : ""}
                    onClick={() => setDraft((d) => ({ ...d, model: k }))}
                  >
                    {MODEL_FILTER_LABELS[k]}
                  </button>
                ))}
              </div>
            </div>

            <div className="hf-sec">
              <span className="hf-label">V5 模式</span>
              <div className="hf-pills">
                {MODE_OPTIONS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={draft.v5Mode === k ? "on" : ""}
                    onClick={() => setDraft((d) => ({ ...d, v5Mode: k }))}
                  >
                    {MODE_FILTER_LABELS[k]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="hf-sec">
            <label className="hf-label" htmlFor="hf-sampler">
              采样器
            </label>
            <select
              id="hf-sampler"
              className="hf-select"
              value={draft.sampler}
              onChange={(e) => setDraft((d) => ({ ...d, sampler: e.target.value }))}
            >
              <option value="">全部采样器</option>
              {samplers.map((s) => (
                <option key={s} value={s}>
                  {SAMPLER_LABEL[s] || s}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="hf-foot">
          <div className="hf-stat">
            <span>
              已加载 {shots.length} 张 · 匹配 <b>{previewCount}</b> 张
            </span>
            {hasNextPage ? <small>（还有更早记录可在列表底部加载）</small> : null}
          </div>
          <div className="hf-actions">
            <button
              className="btn"
              type="button"
              disabled={!dirty}
              onClick={() => setDraft(EMPTY_HISTORY_FILTER)}
            >
              <RotateCcw />
              重置
            </button>
            <button className="btn" type="button" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" type="submit">
              应用筛选
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
