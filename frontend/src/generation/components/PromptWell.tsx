import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  applySuggestionText,
  filterArtistNames,
  formatWeight,
  parseWeightInput,
  stepWeight,
  suggestQueryFromSegment,
  tagKey,
  tokenFillPercent,
  estimateTokens,
  TOKEN_LIMIT,
} from "@/data";
import { armArtistLibrary, useArtistHover, useArtistLibrary, useArtistPreviews } from "@/ui/ArtistHover";
import {
  buildEditor,
  caretRect,
  cardName,
  cardWeight,
  currentCardNames,
  deleteSelection,
  ensureEnd,
  getCaretOffset,
  insertPlainText,
  offsetAfterNode,
  offsetBeforeNode,
  refreshEmpty,
  revealCaret,
  segmentBeforeCaret,
  serializeNode,
  serializeSelection,
  setCaretOffset,
  setCardWeight,
} from "@/ui/promptDom";

type Suggest = { items: string[]; index: number; left: number; top?: number; bottom?: number };
type Snap = { v: string; c: number };

const SUGGEST_W = 260;
const SUGGEST_H = 240;
const PIC_W = 190;

export function PromptWell({
  value,
  onChange,
  placeholder,
  hidden,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hidden?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useArtistHover();
  const library = useArtistLibrary();
  const previews = useArtistPreviews();
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const last = useRef(value);
  const composing = useRef(false);
  const kbNav = useRef(false);
  const selectOnUp = useRef(false);
  const hist = useRef({ stack: [{ v: value, c: value.length }] as Snap[], idx: 0, t: 0, typing: false });
  const [sug, setSug] = useState<Suggest | null>(null);
  const sugRef = useRef(sug);
  sugRef.current = sug;

  const el = () => rootRef.current!;

  function pushSnap(v: string, c: number, coalesce: boolean) {
    const h = hist.current;
    if (h.stack[h.idx]?.v === v) return;
    const now = Date.now();
    h.stack.length = h.idx + 1;
    if (coalesce && h.typing && h.idx > 0 && now - h.t < 700) {
      h.stack[h.idx] = { v, c };
    } else {
      h.stack.push({ v, c });
      h.idx += 1;
      if (h.stack.length > 30) {
        h.stack.shift();
        h.idx -= 1;
      }
    }
    h.t = now;
    h.typing = coalesce;
  }

  /** 把 DOM 当前内容读成字符串并通知外面。 */
  function emit(coalesce: boolean) {
    const root = el();
    ensureEnd(root);
    const s = serializeNode(root);
    refreshEmpty(root, s);
    if (s !== last.current) {
      last.current = s;
      onChangeRef.current(s);
    }
    pushSnap(s, getCaretOffset(root) ?? s.length, coalesce);
  }

  function rebuild(s: string, caret: number | null) {
    const root = el();
    buildEditor(root, s);
    if (caret != null && document.activeElement === root) {
      setCaretOffset(root, Math.min(caret, s.length));
      revealCaret(root);
    }
  }

  /** 提交时机：把文字里写成画师 tag 的部分变成卡片，光标按字符偏移还原。 */
  function commitCards() {
    const root = el();
    const s = serializeNode(root);
    rebuild(s, document.activeElement === root ? getCaretOffset(root) : null);
  }

  function applySnap(snap: Snap) {
    last.current = snap.v;
    el().focus({ preventScroll: true });
    rebuild(snap.v, snap.c);
    onChangeRef.current(snap.v);
    setSug(null);
  }

  function undo() {
    const h = hist.current;
    if (h.idx <= 0) return;
    h.idx -= 1;
    h.typing = false;
    applySnap(h.stack[h.idx]);
  }

  function redo() {
    const h = hist.current;
    if (h.idx >= h.stack.length - 1) return;
    h.idx += 1;
    h.typing = false;
    applySnap(h.stack[h.idx]);
  }

  function insertText(text: string) {
    insertPlainText(el(), text.replace(/\r\n?/g, "\n"));
    emit(false);
  }

  function applyWeight(card: HTMLElement, weight: number | null) {
    setCardWeight(card, weight);
    emit(false);
  }

  function removeCard(card: HTMLElement) {
    const root = el();
    const at = offsetBeforeNode(root, card);
    card.remove();
    root.normalize();
    hover.delayHide();
    emit(false);
    if (document.activeElement === root) setCaretOffset(root, at);
  }

  function commitWeightInput(input: HTMLInputElement) {
    const card = input.closest<HTMLElement>(".artist-card");
    if (!card) return;
    const cur = cardWeight(card);
    const parsed = parseWeightInput(input.value);
    if (parsed === false || parsed === cur) {
      input.value = cur == null ? "" : formatWeight(cur);
      return;
    }
    applyWeight(card, parsed);
  }

  // ---- 联想 ----

  function updateSuggest() {
    const root = el();
    if (composing.current || document.activeElement !== root) return setSug(null);
    const seg = segmentBeforeCaret(root);
    const q = seg == null ? null : suggestQueryFromSegment(seg);
    if (!q) return setSug(null);
    const exclude = new Set(currentCardNames(root).map(tagKey));
    const items = filterArtistNames(libraryRef.current, q.query, exclude);
    if (!items.length) return setSug(null);
    const r = caretRect(root);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - SUGGEST_W - PIC_W - 8));
    const below = window.innerHeight - r.bottom;
    setSug({
      items,
      index: 0,
      left,
      ...(below >= Math.min(SUGGEST_H, 120) || r.top < SUGGEST_H
        ? { top: r.bottom + 4 }
        : { bottom: window.innerHeight - r.top + 4 }),
    });
  }

  function selectSuggestion(name: string) {
    const root = el();
    const seg = segmentBeforeCaret(root) ?? "";
    const q = suggestQueryFromSegment(seg);
    const lead = /^[ \t]*/.exec(seg)?.[0].length ?? 0;
    const s = serializeNode(root);
    const caret = getCaretOffset(root) ?? s.length;
    const next = applySuggestionText(s, caret, seg.length - lead, name, q?.weight ?? null);
    root.focus({ preventScroll: true });
    rebuild(next.text, next.caret);
    emit(false);
    setSug(null);
  }

  // ---- 事件 ----

  useEffect(() => {
    armArtistLibrary();
  }, []);

  useLayoutEffect(() => {
    buildEditor(el(), value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (value === last.current) return;
    const root = el();
    last.current = value;
    if (serializeNode(root) === value) return;
    const caret = document.activeElement === root ? getCaretOffset(root) : null;
    buildEditor(root, value);
    if (caret != null) setCaretOffset(root, Math.min(caret, value.length));
    hist.current = { stack: [{ v: value, c: value.length }], idx: 0, t: 0, typing: false };
    setSug(null);
  }, [value]);

  useEffect(() => {
    if (hidden) setSug(null);
  }, [hidden]);

  useEffect(() => {
    if (!kbNav.current) return;
    kbNav.current = false;
    listRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [sug?.index]);

  // beforeinput 必须用原生监听：回车、粘贴、撤销都要自己接管。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onBefore = (raw: Event) => {
      const e = raw as InputEvent;
      if ((e.target as HTMLElement | null)?.closest?.(".artist-card")) return;
      if (composing.current || e.isComposing) return;
      switch (e.inputType) {
        case "insertParagraph":
        case "insertLineBreak":
          e.preventDefault();
          insertText("\n");
          commitCards();
          setSug(null);
          return;
        case "insertFromPaste":
        case "insertFromPasteAsQuotation": {
          e.preventDefault();
          const text = e.dataTransfer?.getData("text/plain") ?? "";
          if (text) {
            insertText(text);
            commitCards();
          }
          setSug(null);
          return;
        }
        case "historyUndo":
          e.preventDefault();
          undo();
          return;
        case "historyRedo":
          e.preventDefault();
          redo();
          return;
      }
    };
    root.addEventListener("beforeinput", onBefore);
    return () => root.removeEventListener("beforeinput", onBefore);
  }, []);

  function onInput(e: FormEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest(".artist-card")) return;
    const ne = e.nativeEvent as InputEvent;
    const type = ne.inputType || "";
    emit(type === "insertText" || type.startsWith("delete"));
    if (composing.current || ne.isComposing) return;
    if (type === "insertText" && ne.data === ",") commitCards();
    updateSuggest();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (t.matches("input.ac-w")) {
      const input = t as HTMLInputElement;
      const card = input.closest<HTMLElement>(".artist-card");
      if (!card) return;
      if (e.key === "Enter") {
        e.preventDefault();
        commitWeightInput(input);
        const root = el();
        root.focus({ preventScroll: true });
        setCaretOffset(root, offsetAfterNode(root, card));
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const cur = cardWeight(card);
        input.value = cur == null ? "" : formatWeight(cur);
        el().focus({ preventScroll: true });
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const base = parseWeightInput(input.value);
        applyWeight(card, stepWeight(base === false ? cardWeight(card) : base, e.key === "ArrowUp" ? 1 : -1));
      }
      return;
    }
    if (t.closest(".artist-card")) return;
    if (composing.current || e.nativeEvent.isComposing) return;

    const cur = sugRef.current;
    if (cur) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        kbNav.current = true;
        const n = cur.items.length;
        const index = (cur.index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
        setSug({ ...cur, index });
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        selectSuggestion(cur.items[cur.index]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSug(null);
        return;
      }
      if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) setSug(null);
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (k === "y") {
        e.preventDefault();
        redo();
      }
    }
  }

  function onClick(e: MouseEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    const delBtn = t.closest<HTMLElement>("button.ac-del");
    if (delBtn) {
      const card = delBtn.closest<HTMLElement>(".artist-card");
      if (card) removeCard(card);
      return;
    }
    const btn = t.closest<HTMLElement>("button.ac-btn");
    if (btn) {
      const card = btn.closest<HTMLElement>(".artist-card");
      if (card) applyWeight(card, stepWeight(cardWeight(card), btn.dataset.act === "inc" ? 1 : -1));
      return;
    }
    if (t === e.currentTarget) el().focus({ preventScroll: true });
  }

  function onMouseDown(e: MouseEvent<HTMLDivElement>) {
    // 点加减不能抢走编辑器的焦点和光标。
    if ((e.target as HTMLElement).closest("button.ac-btn, button.ac-del")) e.preventDefault();
    else setSug(null);
  }

  function onFocus(e: FocusEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (!t.matches("input.ac-w")) return;
    // 聚焦权重框时全选，方便直接改；mouseup 不能把选区又清掉。
    selectOnUp.current = true;
    (t as HTMLInputElement).select();
  }

  function onMouseUp(e: MouseEvent<HTMLDivElement>) {
    if (!selectOnUp.current) return;
    selectOnUp.current = false;
    if ((e.target as HTMLElement).matches("input.ac-w")) e.preventDefault();
  }

  function onBlur(e: FocusEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (t.matches("input.ac-w")) {
      commitWeightInput(t as HTMLInputElement);
      return;
    }
    if (t !== e.currentTarget) return;
    const rel = e.relatedTarget as Node | null;
    if (rel && (e.currentTarget.contains(rel) || listRef.current?.contains(rel))) return;
    setSug(null);
    if (!composing.current) commitCards();
  }

  function onCopy(e: ClipboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest(".ac-w")) return;
    const text = serializeSelection(el());
    if (!text) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  }

  function onCut(e: ClipboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest(".ac-w")) return;
    const text = serializeSelection(el());
    if (!text) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
    deleteSelection(el());
    emit(false);
    setSug(null);
  }

  function onMouseOver(e: MouseEvent<HTMLDivElement>) {
    const name = (e.target as HTMLElement).closest<HTMLElement>(".ac-name");
    const card = name?.closest<HTMLElement>(".artist-card");
    if (card) hover.show(cardName(card), card.getBoundingClientRect());
  }

  function onMouseOut(e: MouseEvent<HTMLDivElement>) {
    const name = (e.target as HTMLElement).closest<HTMLElement>(".ac-name");
    if (name && !name.contains(e.relatedTarget as Node | null)) hover.delayHide();
  }

  const activeName = sug ? sug.items[sug.index] : null;
  const pic = activeName ? previews.get(tagKey(activeName))?.[0] : undefined;

  return (
    <div className="prompt-well" hidden={hidden}>
      <div
        ref={rootRef}
        className="prompt-ed"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        translate="no"
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder || ""}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onFocus={onFocus}
        onMouseUp={onMouseUp}
        onBlur={onBlur}
        onCopy={onCopy}
        onCut={onCut}
        onMouseOver={onMouseOver}
        onMouseOut={onMouseOut}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          emit(true);
          updateSuggest();
        }}
      />
      {sug &&
        createPortal(
          <div
            ref={listRef}
            className="artist-suggest"
            role="listbox"
            style={{ left: sug.left, top: sug.top, bottom: sug.bottom, width: SUGGEST_W + PIC_W }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="as-list" style={{ width: SUGGEST_W, maxHeight: SUGGEST_H }}>
              {sug.items.map((name, i) => (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={i === sug.index}
                  className={i === sug.index ? "on" : ""}
                  onMouseMove={() => {
                    if (i !== sugRef.current?.index) setSug((s) => (s ? { ...s, index: i } : s));
                  }}
                  onClick={() => selectSuggestion(name)}
                >
                  <span className="pre">artist:</span>
                  {name}
                </button>
              ))}
            </div>
            <div className="as-pic" style={{ width: PIC_W }}>
              {pic ? <img key={pic.thumbUrl} src={pic.thumbUrl} alt="" /> : <span>暂无测试图</span>}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** 只统计传进来的这一个输入框；悬停显示它自己占用的 token。 */
export const TokenBar = memo(function TokenBar({ text, label }: { text: string; label?: string }) {
  const n = estimateTokens(text);
  const tip = `${label ? `${label} ` : ""}占用约 ${n} tokens · 总上限 ${TOKEN_LIMIT}${n > TOKEN_LIMIT ? "（已超出）" : ""}`;
  const p = tokenFillPercent(text);
  return (
    <div className={`token-bar${n > TOKEN_LIMIT ? " over" : ""}`} data-tip={tip} aria-label={tip}>
      <span className="track">
        {/* 渐变按整条轨道铺开，填充多少就露出多少，不会因为填充短就整段变红。 */}
        <i style={{ width: `${p}%`, backgroundSize: p ? `${10000 / p}% 100%` : undefined }} />
      </span>
    </div>
  );
});
