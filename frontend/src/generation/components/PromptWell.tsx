import { useRef, useState, type MouseEvent } from "react";
import { findArtistAt, highlight, tokenFillPercent } from "@/data";
import { useArtistHover } from "@/ui/ArtistHover";
import { indexFromTextareaPoint } from "@/ui/textareaCaret";

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
  const hlRef = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);
  const [overArtist, setOverArtist] = useState(false);
  const hover = useArtistHover();

  function onMove(e: MouseEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget;
    const hit = findArtistAt(ta.value, indexFromTextareaPoint(ta, e.clientX, e.clientY));
    if (hit) {
      hovering.current = true;
      if (!overArtist) setOverArtist(true);
      hover.show(hit.name, new DOMRect(e.clientX, e.clientY - 8, 1, 16));
      return;
    }
    if (hovering.current) {
      hovering.current = false;
      setOverArtist(false);
      hover.delayHide();
    }
  }

  return (
    <div className="prompt-well" hidden={hidden} data-artist-hover={overArtist ? "" : undefined}>
      <div className="prompt-hl" ref={hlRef} dangerouslySetInnerHTML={{ __html: `${highlight(value)}\n\n` }} />
      <textarea
        className="prompt-ta"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onMouseMove={onMove}
        onMouseLeave={() => {
          if (!hovering.current) return;
          hovering.current = false;
          setOverArtist(false);
          hover.delayHide();
        }}
        onScroll={(e) => {
          if (hlRef.current) hlRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}

export function TokenBar({ text }: { text: string }) {
  return (
    <div className="token-bar">
      <i style={{ width: `${tokenFillPercent(text)}%` }} />
    </div>
  );
}
