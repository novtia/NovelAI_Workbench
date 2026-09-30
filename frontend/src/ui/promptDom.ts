import { formatArtistCard, formatWeight, splitPromptSegments, type ArtistCard } from "@/data/artistCards";
import { highlight, weightStyle } from "@/data/studio";

/**
 * 提示词编辑器的 DOM 工具。
 * 编辑器是一个 contenteditable：普通文字是文本节点，画师 tag 是不可编辑的内联卡片，
 * 末尾固定一个 <br data-end> 让最后一个换行能显示出来。
 * 所有函数都以「序列化后的字符串偏移」为准，卡片按它的原文长度计。
 */

export const CARD_CLASS = "artist-card";
const NEUTRAL_BG = "rgba(21, 20, 15, .06)";

export function isCardEl(n: Node | null | undefined): n is HTMLElement {
  return !!n && n.nodeType === 1 && (n as HTMLElement).classList.contains(CARD_CLASS);
}

function isEndEl(n: Node | null | undefined) {
  return !!n && n.nodeType === 1 && (n as HTMLElement).hasAttribute("data-end");
}

function endEl() {
  const br = document.createElement("br");
  br.setAttribute("data-end", "");
  return br;
}

export function cardWeight(el: HTMLElement): number | null {
  const w = el.dataset.weight;
  return w ? Number(w) : null;
}

export function cardName(el: HTMLElement) {
  return el.dataset.name || "";
}

function paintCard(el: HTMLElement, weight: number | null) {
  el.dataset.weight = weight == null ? "" : String(weight);
  el.style.background = weight == null ? NEUTRAL_BG : weightStyle(weight);
  el.classList.toggle("no-weight", weight == null);
  const input = el.querySelector<HTMLInputElement>("input.ac-w");
  if (input) input.value = weight == null ? "" : formatWeight(weight);
}

function button(act: "dec" | "inc", label: string, title: string) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ac-btn";
  b.dataset.act = act;
  b.tabIndex = -1;
  b.title = title;
  b.textContent = label;
  return b;
}

export function createCardEl(card: Pick<ArtistCard, "raw" | "name" | "weight">) {
  const el = document.createElement("span");
  el.className = CARD_CLASS;
  el.contentEditable = "false";
  el.dataset.raw = card.raw;
  el.dataset.name = card.name;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "ac-w";
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "1";
  input.setAttribute("aria-label", `${card.name} 权重`);

  const name = document.createElement("span");
  name.className = "ac-name";
  name.setAttribute("data-artist-hover", "");
  name.textContent = `artist:${card.name}`;

  // 删除按钮悬浮在卡片右上角，不占宽度，只在悬停时出现。
  const del = document.createElement("button");
  del.type = "button";
  del.className = "ac-del";
  del.dataset.act = "del";
  del.tabIndex = -1;
  del.title = "删除";
  del.setAttribute("aria-label", `删除 ${card.name}`);
  del.textContent = "×";

  el.append(button("dec", "−", "减 0.1"), input, button("inc", "+", "加 0.1"), name, del);
  paintCard(el, card.weight);
  return el;
}

/** 改权重：重写这张卡的原文（null 表示去掉权重）。 */
export function setCardWeight(el: HTMLElement, weight: number | null) {
  el.dataset.raw = formatArtistCard(cardName(el), weight);
  paintCard(el, weight);
}

export function buildEditor(root: HTMLElement, value: string) {
  root.textContent = "";
  for (const seg of splitPromptSegments(value)) {
    if (seg.type === "card") {
      root.appendChild(createCardEl(seg.card));
      continue;
    }
    const tpl = document.createElement("template");
    tpl.innerHTML = highlight(seg.value);
    root.appendChild(tpl.content);
  }
  root.appendChild(endEl());
  refreshEmpty(root);
}

export function refreshEmpty(root: HTMLElement, known?: string) {
  root.toggleAttribute("data-empty", (known ?? serializeNode(root)) === "");
}

/** 保证只有一个末尾占位，且在最后。 */
export function ensureEnd(root: HTMLElement) {
  const marks = root.querySelectorAll("[data-end]");
  if (marks.length === 1 && root.lastChild === marks[0]) return;
  marks.forEach((n) => n.remove());
  root.appendChild(endEl());
}

export function serializeNode(node: Node): string {
  let out = "";
  node.childNodes.forEach((c) => {
    if (c.nodeType === 3) out += (c as Text).data;
    else if (isCardEl(c)) out += c.dataset.raw || "";
    else if (c.nodeName === "BR") return;
    else if (c.nodeType === 1 || c.nodeType === 11) out += serializeNode(c);
  });
  return out;
}

function lenOf(n: Node): number {
  if (n.nodeType === 3) return (n as Text).data.length;
  if (isCardEl(n)) return (n.dataset.raw || "").length;
  if (n.nodeName === "BR") return 0;
  return serializeNode(n).length;
}

export function cardOf(root: HTMLElement, node: Node | null) {
  let n: Node | null = node;
  while (n && n !== root) {
    if (isCardEl(n)) return n;
    n = n.parentNode;
  }
  return null;
}

function offsetOf(root: HTMLElement, node: Node, off: number) {
  let total = 0;
  const visit = (cur: Node): boolean => {
    if (cur === node) {
      if (cur.nodeType === 3) total += off;
      else for (let i = 0; i < off && i < cur.childNodes.length; i++) total += lenOf(cur.childNodes[i]);
      return true;
    }
    if (cur.nodeType === 3 || isCardEl(cur) || cur.nodeName === "BR") {
      total += lenOf(cur);
      return false;
    }
    for (const c of Array.from(cur.childNodes)) if (visit(c)) return true;
    return false;
  };
  visit(root);
  return total;
}

function selectionInEditor(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.focusNode) return null;
  if (!root.contains(sel.focusNode) || cardOf(root, sel.focusNode)) return null;
  return sel;
}

/** 光标（选区终点）在序列化字符串里的偏移；不在编辑器里返回 null。 */
export function getCaretOffset(root: HTMLElement): number | null {
  const sel = selectionInEditor(root);
  if (!sel || !sel.focusNode) return null;
  return offsetOf(root, sel.focusNode, sel.focusOffset);
}

export function positionAt(root: HTMLElement, offset: number): { node: Node; offset: number } {
  let remaining = Math.max(0, offset);
  let found: { node: Node; offset: number } | null = null;
  const visit = (parent: Node): boolean => {
    const kids = Array.from(parent.childNodes);
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 3) {
        const len = (c as Text).data.length;
        if (remaining <= len) {
          found = { node: c, offset: remaining };
          return true;
        }
        remaining -= len;
      } else if (isCardEl(c)) {
        if (remaining === 0) {
          found = { node: parent, offset: i };
          return true;
        }
        remaining -= lenOf(c);
        if (remaining < 0) {
          found = { node: parent, offset: i + 1 };
          return true;
        }
      } else if (isEndEl(c)) {
        found = { node: parent, offset: i };
        return true;
      } else if (c.nodeName !== "BR" && visit(c)) {
        return true;
      }
    }
    return false;
  };
  visit(root);
  return found ?? { node: root, offset: Math.max(0, root.childNodes.length - 1) };
}

export function setCaretOffset(root: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const pos = positionAt(root, offset);
  const range = document.createRange();
  range.setStart(pos.node, pos.offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** 在选区处插入纯文本（替换选区）；选区不在编辑器里则插在末尾。 */
export function insertPlainText(root: HTMLElement, text: string) {
  const sel = window.getSelection();
  if (!sel) return;
  let range: Range;
  if (sel.rangeCount && root.contains(sel.getRangeAt(0).startContainer) && !cardOf(root, sel.getRangeAt(0).startContainer)) {
    range = sel.getRangeAt(0);
  } else {
    range = document.createRange();
    const pos = positionAt(root, Number.MAX_SAFE_INTEGER);
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
  }
  range.deleteContents();
  const tn = document.createTextNode(text);
  range.insertNode(tn);
  range.setStartAfter(tn);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  root.normalize();
}

/** 选区对应的纯文本（卡片按原文）。 */
export function serializeSelection(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return "";
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return "";
  return serializeNode(range.cloneContents());
}

export function deleteSelection(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  root.normalize();
}

/**
 * 光标前面「当前这一段文字」：从上一个逗号 / 换行 / 卡片之后到光标。
 * 只在光标折叠、且不在卡片里时有值。
 */
export function segmentBeforeCaret(root: HTMLElement): string | null {
  const sel = selectionInEditor(root);
  if (!sel || !sel.isCollapsed || !sel.focusNode) return null;
  let text = "";
  const take = (n: Node) => {
    if (n.nodeType === 3) text += (n as Text).data;
    else if (isCardEl(n)) text += "\n";
    else if (n.nodeName !== "BR") n.childNodes.forEach(take);
  };
  const walk = (n: Node): boolean => {
    if (n === sel.focusNode) {
      if (n.nodeType === 3) text += (n as Text).data.slice(0, sel.focusOffset);
      else Array.from(n.childNodes).slice(0, sel.focusOffset).forEach(take);
      return true;
    }
    for (const c of Array.from(n.childNodes)) {
      if (c === sel.focusNode || c.contains(sel.focusNode)) {
        if (walk(c)) return true;
      } else take(c);
    }
    return false;
  };
  if (sel.focusNode !== root) walk(root);
  else Array.from(root.childNodes).slice(0, sel.focusOffset).forEach(take);
  const idx = Math.max(text.lastIndexOf(","), text.lastIndexOf("，"), text.lastIndexOf("\n"));
  return text.slice(idx + 1);
}

/** 光标在屏幕上的位置，用来摆联想列表。 */
export function caretRect(root: HTMLElement): DOMRect {
  const sel = selectionInEditor(root);
  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(false);
    const rects = range.getClientRects();
    const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (r && (r.width || r.height || r.top || r.left)) return r;
    const parent = range.startContainer.nodeType === 1 ? (range.startContainer as HTMLElement) : range.startContainer.parentElement;
    const child = parent?.childNodes[range.startOffset] as HTMLElement | undefined;
    if (child?.getBoundingClientRect) {
      const b = child.getBoundingClientRect();
      if (b.height) return b;
    }
  }
  const b = root.getBoundingClientRect();
  return new DOMRect(b.left + 12, b.top + 10, 1, 18);
}

/** 某个节点结束处在序列化字符串里的偏移。 */
export function offsetAfterNode(root: HTMLElement, node: Node) {
  const parent = node.parentNode;
  if (!parent) return 0;
  return offsetOf(root, parent, Array.prototype.indexOf.call(parent.childNodes, node) + 1);
}

/** 某个节点起点在序列化字符串里的偏移。 */
export function offsetBeforeNode(root: HTMLElement, node: Node) {
  const parent = node.parentNode;
  if (!parent) return 0;
  return offsetOf(root, parent, Array.prototype.indexOf.call(parent.childNodes, node));
}

/** 光标跑出可视区时把它滚回来（程序设置光标不会自动滚动）。 */
export function revealCaret(root: HTMLElement) {
  let box: HTMLElement | null = root;
  while (box && !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) {
    box = box.parentElement;
  }
  if (!box) return;
  const r = caretRect(root);
  const b = box.getBoundingClientRect();
  if (r.bottom > b.bottom - 24) box.scrollTop += r.bottom - b.bottom + 34;
  else if (r.top < b.top + 6) box.scrollTop -= b.top - r.top + 10;
}

export function currentCardNames(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(`.${CARD_CLASS}`)).map(cardName);
}
