const COPY_PROPS = [
  "boxSizing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "lineHeight",
  "fontFamily",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "textAlign",
  "tabSize",
] as const;

let mirror: HTMLPreElement | null = null;

function ensureMirror() {
  if (mirror?.isConnected) return mirror;
  mirror = document.createElement("pre");
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.position = "fixed";
  mirror.style.margin = "0";
  mirror.style.overflow = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.color = "transparent";
  mirror.style.caretColor = "transparent";
  mirror.style.background = "transparent";
  mirror.style.zIndex = "2147483646";
  mirror.style.pointerEvents = "none";
  document.body.appendChild(mirror);
  return mirror;
}

function offsetIn(root: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, offset);
  } catch {
    return root.textContent?.length || 0;
  }
  return range.toString().length;
}

export function indexFromTextareaPoint(ta: HTMLTextAreaElement, clientX: number, clientY: number) {
  const cs = getComputedStyle(ta);
  const r = ta.getBoundingClientRect();
  const el = ensureMirror();
  for (const prop of COPY_PROPS) {
    el.style[prop] = cs[prop];
  }
  el.style.left = `${r.left}px`;
  el.style.top = `${r.top}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
  el.style.opacity = "0";
  el.style.pointerEvents = "auto";
  el.textContent = ta.value.endsWith("\n") ? `${ta.value} ` : ta.value || " ";
  el.scrollTop = ta.scrollTop;
  el.scrollLeft = ta.scrollLeft;

  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let index = 0;
  if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(clientX, clientY);
    if (pos && el.contains(pos.offsetNode)) index = offsetIn(el, pos.offsetNode, pos.offset);
  } else if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(clientX, clientY);
    if (range && el.contains(range.startContainer)) index = offsetIn(el, range.startContainer, range.startOffset);
  }
  el.style.pointerEvents = "none";
  return Math.max(0, Math.min(index, ta.value.length));
}
