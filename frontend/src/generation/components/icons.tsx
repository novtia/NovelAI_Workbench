import type { ReactNode } from "react";
import type { GenderId } from "@/data/types";

function InkSvg({
  children,
  sw = 1.8,
  className,
}: {
  children: ReactNode;
  sw?: number;
  className?: string;
}) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export function IconChevron() {
  return (
    <InkSvg sw={2.2}>
      <path d="m6 9 6 6 6-6" />
    </InkSvg>
  );
}

export function IconBolt() {
  return (
    <InkSvg className="bolt" sw={1.6}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7Z" />
    </InkSvg>
  );
}

export function IconSpark() {
  return (
    <InkSvg className="spark">
      <path d="M12 3v5M12 16v5M3 12h5M16 12h5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </InkSvg>
  );
}

export function IconSparkles() {
  return (
    <InkSvg>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" />
      <path d="M19 16v5M16.5 18.5h5" />
    </InkSvg>
  );
}

export function IconPlus() {
  return (
    <InkSvg sw={2}>
      <path d="M12 5v14M5 12h14" />
    </InkSvg>
  );
}

export function IconMenu() {
  return (
    <InkSvg>
      <path d="M4 7h16M4 12h10M4 17h16" />
    </InkSvg>
  );
}

export function IconCopy() {
  return (
    <InkSvg>
      <rect x="9" y="9" width="12" height="12" rx="1" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </InkSvg>
  );
}

export function IconX() {
  return (
    <InkSvg sw={2}>
      <path d="M18 6 6 18M6 6l12 12" />
    </InkSvg>
  );
}

export function IconGrid() {
  return (
    <InkSvg sw={1.4}>
      <rect x="3" y="3" width="18" height="18" />
      <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
    </InkSvg>
  );
}

export function IconImage() {
  return (
    <InkSvg>
      <rect x="3" y="3" width="18" height="18" rx="1" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-5-5L5 21" />
    </InkSvg>
  );
}

export function IconCrop() {
  return (
    <InkSvg>
      <path d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2" />
    </InkSvg>
  );
}

export function IconPencil() {
  return (
    <InkSvg>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </InkSvg>
  );
}

export function IconLand() {
  return (
    <InkSvg>
      <rect x="2" y="6" width="20" height="12" rx="1" />
    </InkSvg>
  );
}

export function IconPort() {
  return (
    <InkSvg>
      <rect x="6" y="2" width="12" height="20" rx="1" />
    </InkSvg>
  );
}

export function IconSquare() {
  return (
    <InkSvg>
      <rect x="4" y="4" width="16" height="16" rx="1" />
    </InkSvg>
  );
}

export function IconPlay() {
  return (
    <InkSvg>
      <path d="M8 5v14l11-7Z" />
    </InkSvg>
  );
}

export function IconExpand() {
  return (
    <InkSvg sw={2.2}>
      <path d="m6 15 6-6 6 6" />
    </InkSvg>
  );
}

export function IconCollapse() {
  return (
    <InkSvg sw={2.2}>
      <path d="m6 9 6 6 6-6" />
    </InkSvg>
  );
}

export function IconReset() {
  return (
    <InkSvg>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </InkSvg>
  );
}

export function IconSeed() {
  return (
    <InkSvg className="seed-ico">
      <path d="M12 21c-4-2.5-7-6.5-7-10.5a7 7 0 0 1 14 0c0 4-3 8-7 10.5Z" />
      <path d="M12 21v-9" />
    </InkSvg>
  );
}

export function IconHeart() {
  return (
    <InkSvg>
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
    </InkSvg>
  );
}

export function IconCheck() {
  return (
    <InkSvg sw={2}>
      <path d="M20 6 9 17l-5-5" />
    </InkSvg>
  );
}

export function IconFolderPlus() {
  return (
    <InkSvg>
      <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
      <path d="M12 10v6M9 13h6" />
    </InkSvg>
  );
}

export function IconDownload() {
  return (
    <InkSvg>
      <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
    </InkSvg>
  );
}

export function IconTrash() {
  return (
    <InkSvg>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    </InkSvg>
  );
}

export function IconHistPlay() {
  return (
    <InkSvg>
      <path d="M8 5v14l11-7Z" />
    </InkSvg>
  );
}

export function IconEnhance() {
  return (
    <InkSvg>
      <path d="M5 3v4M3 5h4M6 17v4M4 19h4M14 3l2.2 5.8L22 11l-5.8 2.2L14 19l-2.2-5.8L6 11l5.8-2.2Z" />
    </InkSvg>
  );
}

export function Icon4x() {
  return (
    <InkSvg>
      <rect x="3" y="3" width="18" height="18" />
      <path d="M3 12h9V3" />
    </InkSvg>
  );
}

export function Icon1x() {
  return (
    <InkSvg>
      <rect x="5" y="5" width="14" height="14" />
    </InkSvg>
  );
}

export function IconDirector() {
  return (
    <InkSvg>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </InkSvg>
  );
}

export function IconOutpaint() {
  return (
    <InkSvg>
      <rect x="8" y="8" width="8" height="8" />
      <path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5" />
    </InkSvg>
  );
}

export function IconUp() {
  return (
    <InkSvg sw={2}>
      <path d="m18 15-6-6-6 6" />
    </InkSvg>
  );
}

export function IconDown() {
  return (
    <InkSvg sw={2}>
      <path d="m6 9 6 6 6-6" />
    </InkSvg>
  );
}

export function IconPin() {
  return (
    <InkSvg>
      <path d="M12 17v5M9 10.8V4h6v6.8l3 3.2H6Z" />
    </InkSvg>
  );
}

export function IconDices() {
  return (
    <InkSvg sw={2}>
      <rect x="3" y="3" width="12" height="12" rx="2" />
      <path d="M9 21h9a3 3 0 0 0 3-3V9" />
      <circle cx="7" cy="7" r=".9" fill="currentColor" />
      <circle cx="11" cy="11" r=".9" fill="currentColor" />
    </InkSvg>
  );
}

export function IconCopyPlus() {
  return (
    <InkSvg>
      <rect x="8" y="8" width="13" height="13" rx="1" />
      <path d="M4 16V4h12M14.5 11.5v6M11.5 14.5h6" />
    </InkSvg>
  );
}

export function GenderSvg({ g }: { g: GenderId | string }) {
  if (g === "m") {
    return (
      <InkSvg sw={2}>
        <circle cx="10" cy="14" r="5" />
        <path d="M14 10l6-6M15 4h5v5" />
      </InkSvg>
    );
  }
  if (g === "o") {
    return (
      <InkSvg sw={2}>
        <circle cx="12" cy="12" r="5" />
        <path d="M12 2v5M12 17v5M9 4.5h6" />
      </InkSvg>
    );
  }
  return (
    <InkSvg sw={2}>
      <circle cx="12" cy="9" r="5" />
      <path d="M12 14v8M9 19h6" />
    </InkSvg>
  );
}
