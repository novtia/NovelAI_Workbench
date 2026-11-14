import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { mediaApi } from "@/api";
import { queryKeys, type MediaSitePatch } from "@/data";
import { pushToast, useMediaStore } from "@/state";

export function SiteDialog() {
  const dialog = useMediaStore((s) => s.dialog);
  const closeDialog = useMediaStore((s) => s.closeSiteDialog);
  const qc = useQueryClient();

  const ref = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const isEdit = dialog?.mode === "edit";
  const site = isEdit ? dialog.site : undefined;
  const isBuiltin = Boolean(site?.builtin);

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultQuery, setDefaultQuery] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const open = Boolean(dialog);
  const dialogKey = dialog
    ? dialog.mode === "edit"
      ? `edit:${dialog.site.id}`
      : "create"
    : "";

  useEffect(() => {
    if (!dialog) return;
    if (dialog.mode === "edit") {
      setName(dialog.site.name);
      setBaseUrl(dialog.site.baseUrl);
      setDefaultQuery(dialog.site.defaultQuery || "");
      setNote(dialog.site.note || "");
    } else {
      setName("");
      setBaseUrl("");
      setDefaultQuery("");
      setNote("");
    }
  }, [dialog, dialogKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
    if (!open) return;
    queueMicrotask(() => {
      nameRef.current?.focus();
    });
  }, [open, dialogKey]);

  async function onSubmit() {
    if (busy) return;
    const trimUrl = baseUrl.trim();
    if (!trimUrl) {
      pushToast("请填写网页地址（URL）", "error");
      return;
    }
    setBusy(true);
    try {
      const patch: MediaSitePatch = {
        name: name.trim(),
        baseUrl: trimUrl,
        note: note.trim(),
      };
      if (isBuiltin) {
        patch.defaultQuery = defaultQuery.trim();
      } else {
        patch.kind = "webpage";
      }
      await mediaApi.saveSite(site?.id, patch);
      await qc.invalidateQueries({ queryKey: queryKeys.mediaSites });
      pushToast(isEdit ? "已保存修改" : "已添加网页卡片到媒体导航");
      closeDialog();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "保存失败", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      className="modal m-site-dialog"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        closeDialog();
      }}
      onClick={(e) => {
        if (e.target === ref.current) closeDialog();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <h3>
          {isBuiltin
            ? `站点设置 · ${site?.name}`
            : isEdit
              ? "编辑自定义页面"
              : "添加自定义网页"}
        </h3>
        <div className="m-dlg-fields">
          <label className="m-dlg-field">
            <span>页面名称</span>
            <input
              ref={nameRef}
              type="text"
              maxLength={40}
              placeholder={isBuiltin ? site?.name : "例如：Pixiv / Civitai / NovelAI 词典"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="m-dlg-field">
            <span>网页地址 (URL)</span>
            <input
              type="text"
              required
              spellCheck={false}
              placeholder="https://example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          {isBuiltin ? (
            <label className="m-dlg-field">
              <span>默认检索标签（可选）</span>
              <input
                type="text"
                placeholder="进入该站点时默认附带的搜索词，留空则看最新作品"
                value={defaultQuery}
                onChange={(e) => setDefaultQuery(e.target.value)}
              />
            </label>
          ) : null}
          <label className="m-dlg-field">
            <span>备注简介（可选）</span>
            <input
              type="text"
              maxLength={80}
              placeholder="简短备注，显示在导航宫格卡片底部"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button className="btn" type="button" onClick={closeDialog}>
            取消
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy || !baseUrl.trim()}>
            {busy ? "保存中…" : isEdit ? "保存" : "添加到导航"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
