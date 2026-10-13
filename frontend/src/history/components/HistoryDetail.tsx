import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MODEL_LABEL, SAMPLER_LABEL } from "@/data";
import type { HistoryShot } from "@/data/history";
import { IconCopy, IconSparkles, IconX } from "@/generation/components/icons";
import { copyShotPrompt, loadShotParams, pushToast, saveShotsToAlbum, useAlbumsQuery } from "@/state";

function textOf(value: unknown) {
  const text = value == null ? "" : String(value);
  return text && text !== "undefined" ? text : "";
}

function modelLabel(meta: Record<string, unknown>) {
  const raw = textOf(meta.model);
  if (!raw) return "—";
  if (MODEL_LABEL[raw]) return MODEL_LABEL[raw];
  if (raw.includes("curated")) return "V5 精选";
  if (raw.includes("medium") || meta.effort === "medium") return "V5 完整 · 节约";
  if (raw.includes("nai-diffusion-5")) return "V5 完整";
  return raw;
}

function when(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function HistoryDetail({ shot, onClose }: { shot: HistoryShot | null; onClose: () => void }) {
  const albums = useAlbumsQuery().data || [];
  const [picked, setPicked] = useState("");
  const qc = useQueryClient();
  const target = albums.some((a) => a.id === picked) ? picked : albums[0]?.id || "";
  const meta = shot?.meta || {};
  const sampler = textOf(meta.sampler);
  const width = shot?.width;
  const height = shot?.height;

  function loadParams() {
    if (shot) loadShotParams(shot);
  }

  async function copyPrompt() {
    if (shot) await copyShotPrompt(shot);
  }

  async function save() {
    if (!shot?.blobHash) {
      pushToast("这张图没有可保存的文件", "warn");
      return;
    }
    if (!target) {
      pushToast("还没有收藏夹", "warn");
      return;
    }
    await saveShotsToAlbum(qc, [shot], target, albums.find((a) => a.id === target)?.name);
  }

  return (
    <aside className={`inspector${shot ? " open" : ""}`} aria-hidden={!shot}>
      <div className="insp-inner">
        <div className="insp-head">
          <span className="pane-title">历史详情</span>
          <button className="icon-btn" type="button" title="关闭" aria-label="关闭" onClick={onClose}>
            <IconX />
          </button>
        </div>
        {shot && (
          <>
            <div className="insp-body">
              <div className="preview">
                <img src={shot.url} alt="" width={width || undefined} height={height || undefined} />
              </div>
              <dl className="meta-grid">
                <dt>时间</dt>
                <dd>{when(shot.createdAt)}</dd>
                <dt>模型</dt>
                <dd>{modelLabel(meta)}</dd>
                <dt>分辨率</dt>
                <dd>{width && height ? `${width} × ${height}` : "—"}</dd>
                <dt>步数</dt>
                <dd>{textOf(meta.steps) || "—"}</dd>
                <dt>Sampler</dt>
                <dd>{SAMPLER_LABEL[sampler] || sampler || "—"}</dd>
                <dt>CFG</dt>
                <dd>{textOf(meta.scale) || "—"}</dd>
                <dt>Seed</dt>
                <dd>{textOf(meta.seed) || "—"}</dd>
              </dl>
              <div className="block">
                <div className="block-head">Prompt</div>
                <pre className="prompt">{shot.prompt || "—"}</pre>
              </div>
              <div className="move-row">
                <label htmlFor="hist-album">收藏夹</label>
                <select id="hist-album" value={target} onChange={(e) => setPicked(e.target.value)} disabled={!albums.length}>
                  {albums.length ? (
                    albums.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))
                  ) : (
                    <option value="">没有收藏夹</option>
                  )}
                </select>
                <button className="mini" type="button" onClick={() => void save()}>
                  存入
                </button>
              </div>
            </div>
            <div className="insp-foot">
              <button className="btn btn-primary" type="button" onClick={loadParams}>
                <IconSparkles />
                载入参数
              </button>
              <button className="btn" type="button" onClick={() => void copyPrompt()}>
                <IconCopy />
                复制提示词
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
