import { useRef } from "react";
import { highlight, tokenFillPercent } from "@/data";

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
  return (
    <div className="prompt-well" hidden={hidden}>
      <div className="prompt-hl" ref={hlRef} dangerouslySetInnerHTML={{ __html: `${highlight(value)}\n\n` }} />
      <textarea
        className="prompt-ta"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
