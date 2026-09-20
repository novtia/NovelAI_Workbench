import { useEffect, useRef } from "react";
import { persistImportOpts } from "@/data";
import { closeMetaDialog, useStudio } from "@/state";
import { IconX } from "./icons";

export function MetaImportDialog() {
  const { metaOpen, metaUrl, metaStatus, metaError, metaForm, importOpts, setImportOpts, importMeta, soon } = useStudio();
  const ref = useRef<HTMLDialogElement>(null);
  const ok = metaStatus === "ok" && Boolean(metaForm);

  function patchOpts(patch: Partial<typeof importOpts>) {
    const next = { ...importOpts, ...patch };
    setImportOpts(next);
    persistImportOpts(next);
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (metaOpen && !el.open) el.showModal();
    if (!metaOpen && el.open) el.close();
  }, [metaOpen]);

  return (
    <dialog
      className="modal meta-dialog"
      id="st-meta-dialog"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        closeMetaDialog();
      }}
      onClick={(e) => {
        if (e.target === ref.current) closeMetaDialog();
      }}
      onClose={closeMetaDialog}
    >
      <button className="meta-close" type="button" title="关闭" aria-label="关闭" onClick={closeMetaDialog}>
        <IconX />
      </button>
      <h3>要对这张图做什么？</h3>
      <div className="meta-preview">{metaUrl ? <img src={metaUrl} alt="" /> : null}</div>
      <div className="meta-tools">
        <button type="button" onClick={() => soon("第二波接入：图生图 / Vibe / 精确参考")}>
          图生图
        </button>
        <button type="button" onClick={() => soon("第二波接入：图生图 / Vibe / 精确参考")}>
          Vibe Transfer
        </button>
        <button type="button" onClick={() => soon("第二波接入：图生图 / Vibe / 精确参考")}>
          精确参考
        </button>
      </div>
      <div hidden={!ok}>
        <p className="meta-lead">这张图含有生成参数，要导入吗？</p>
        <div className="meta-import">
          <div className="meta-checks">
            <label>
              <input type="checkbox" checked={importOpts.prompt} onChange={(e) => patchOpts({ prompt: e.target.checked })} /> 主体提示词
            </label>
            <label>
              <input type="checkbox" checked={importOpts.uc} onChange={(e) => patchOpts({ uc: e.target.checked })} /> 负面提示
            </label>
            <label>
              <input type="checkbox" checked={importOpts.chars} onChange={(e) => patchOpts({ chars: e.target.checked, append: e.target.checked ? importOpts.append : false })} /> 角色
            </label>
            <label className="indent">
              <input type="checkbox" disabled={!importOpts.chars} checked={importOpts.append} onChange={(e) => patchOpts({ append: e.target.checked })} /> 追加
            </label>
            <label>
              <input type="checkbox" checked={importOpts.settings} onChange={(e) => patchOpts({ settings: e.target.checked })} /> 设置
            </label>
            <label>
              <input type="checkbox" checked={importOpts.seed} onChange={(e) => patchOpts({ seed: e.target.checked })} /> 种子
            </label>
          </div>
          <div className="meta-side">
            <button className="btn btn-primary" type="button" disabled={!ok} onClick={() => importMeta()}>
              导入元数据
            </button>
            <label className="meta-clean">
              <input type="checkbox" checked={importOpts.clean} onChange={(e) => patchOpts({ clean: e.target.checked })} /> 清理导入
            </label>
          </div>
        </div>
      </div>
      <p className="meta-empty" hidden={ok}>
        {metaStatus === "loading" ? "正在读取元数据…" : metaError || "这张图没有可识别的 NAI 参数。"}
      </p>
    </dialog>
  );
}
