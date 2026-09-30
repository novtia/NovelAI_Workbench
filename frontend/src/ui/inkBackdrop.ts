/** 宣纸纹理与泼墨底，取自 demo/jiangnan-ink.html。 */

export const ACTIVITY_RAIL = 78;

function rng(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function svgUri(markup: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

const SEARCH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#6c675c" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

function fiberMarkup() {
  const r = rng(20260929);
  const T = 520;
  let p = "";
  for (let i = 0; i < 420; i++) {
    const x = r() * T;
    const y = r() * T;
    const a = r() * Math.PI * 2;
    const len = 6 + r() * r() * 46;
    const bend = (r() - 0.5) * len * 0.6;
    const x2 = x + Math.cos(a) * len;
    const y2 = y + Math.sin(a) * len;
    const cx = (x + x2) / 2 - Math.sin(a) * bend;
    const cy = (y + y2) / 2 + Math.cos(a) * bend;
    p += `<path d="M${x.toFixed(1)} ${y.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke-opacity="${(0.12 + r() * 0.3).toFixed(2)}" stroke-width="${(0.35 + r() * 0.5).toFixed(2)}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${T}" height="${T}"><g fill="none" stroke="#6b5836" stroke-linecap="round">${p}</g></svg>`;
}

const TEXTURES: Record<string, string> = {
  grain:
    '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .32  0 0 0 0 .27  0 0 0 0 .18  0 0 0 .55 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>',
  fiber: fiberMarkup(),
  blob: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><filter id="r" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency=".05" numOctaves="3" seed="4"/><feDisplacementMap in="SourceGraphic" scale="14"/></filter><path filter="url(#r)" fill="#15140f" d="M22 30C30 12 58 6 74 16s22 34 12 52-30 26-50 20S6 64 10 48s6-10 12-18Z"/><circle cx="84" cy="22" r="4" fill="#15140f" filter="url(#r)"/></svg>',
  enso: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><filter id="r" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="3" seed="2"/><feDisplacementMap in="SourceGraphic" scale="7"/></filter><g filter="url(#r)" fill="none" stroke="#15140f" stroke-linecap="round"><path d="M145 46.4A70 70 0 1 1 112.2 31.1" stroke-width="11" opacity=".88"/><path d="M144 51A66 66 0 1 1 118 36" stroke-width="3" opacity=".35" stroke-dasharray="40 6 18 9"/></g></svg>',
  stroke:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 20" preserveAspectRatio="none"><filter id="r"><feTurbulence type="fractalNoise" baseFrequency=".08 .5" numOctaves="2" seed="5"/><feDisplacementMap in="SourceGraphic" scale="5"/></filter><path filter="url(#r)" d="M4 11C40 5 90 4 140 6s50 3 56 5c-30 5-90 6-140 5S8 14 4 11Z" fill="#b3261e"/></svg>',
};

export function installInkTextures() {
  const style = document.documentElement.style;
  for (const key of ["grain", "fiber", "blob", "enso", "stroke"]) {
    style.setProperty(`--${key}`, `url("${svgUri(TEXTURES[key])}")`);
  }
  style.setProperty("--i-search", `url("${svgUri(SEARCH_ICON)}")`);
}

/** a：纸面斑驳与暗角；b：泼墨（WebGL 活墨可用时由 inkFluid 取代，仅作兜底）。 */
function inkScape(W: number, H: number, part: "a" | "b") {
  const sx = W / 1600;
  const sy = H / 1000;
  const s = Math.min(sx, sy);
  const bleed = (id: string, seed: number, big: number, fine: number) => `
    <filter id="${id}" filterUnits="userSpaceOnUse" x="${-W * 0.2}" y="${-H * 0.2}" width="${W * 1.4}" height="${H * 1.4}" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="${(0.005 / s).toFixed(4)}" numOctaves="3" seed="${seed}" result="n1"/>
      <feDisplacementMap in="SourceGraphic" in2="n1" scale="${big * s}" xChannelSelector="R" yChannelSelector="B" result="d1"/>
      <feTurbulence type="fractalNoise" baseFrequency="${(0.03 / s).toFixed(4)}" numOctaves="3" seed="${seed + 3}" result="n2"/>
      <feDisplacementMap in="d1" in2="n2" scale="${fine * s}" xChannelSelector="G" yChannelSelector="R" result="shape"/>
      <feGaussianBlur in="shape" stdDeviation="${60 * s}" result="halo"/>
      <feColorMatrix in="halo" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .55 0" result="haloL"/>
      <feGaussianBlur in="shape" stdDeviation="${26 * s}" result="body"/>
      <feMorphology in="shape" operator="erode" radius="${4 * s}" result="er"/>
      <feGaussianBlur in="er" stdDeviation="${12 * s}" result="erb"/>
      <feComposite in="shape" in2="erb" operator="out" result="rim"/>
      <feGaussianBlur in="rim" stdDeviation="${3.2 * s}" result="rimS"/>
      <feColorMatrix in="rimS" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .6 0" result="rimL"/>
      <feTurbulence type="fractalNoise" baseFrequency="${(0.009 / s).toFixed(4)}" numOctaves="4" seed="${seed + 7}" result="n3"/>
      <feColorMatrix in="n3" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1.5 -0.3" result="tex"/>
      <feComposite in="body" in2="tex" operator="in" result="bodyTex"/>
      <feMerge><feMergeNode in="haloL"/><feMergeNode in="bodyTex"/><feMergeNode in="rimL"/></feMerge>
    </filter>`;
  const E = (cx: number, cy: number, rx: number, ry: number, o: number, rot = 0) =>
    `<ellipse cx="${cx * sx}" cy="${cy * sy}" rx="${rx * sx}" ry="${ry * sy}" fill-opacity="${o}" transform="rotate(${rot} ${cx * sx} ${cy * sy})"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      ${bleed("ink", 8, 300, 16)}
      ${bleed("ink2", 21, 220, 14)}
      ${bleed("tea", 40, 160, 10)}
      <filter id="mottle" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
        <feTurbulence type="fractalNoise" baseFrequency="${(0.0022 / s).toFixed(4)}" numOctaves="4" seed="3"/>
        <feColorMatrix type="matrix" values="0 0 0 0 .45  0 0 0 0 .36  0 0 0 0 .2  0 0 0 .32 -.14"/>
      </filter>
      <radialGradient id="vig" cx="50%" cy="45%" r="75%"><stop offset=".55" stop-color="#6b5530" stop-opacity="0"/><stop offset="1" stop-color="#6b5530" stop-opacity=".14"/></radialGradient>
    </defs>
    ${
      part === "a"
        ? `<rect width="${W}" height="${H}" filter="url(#mottle)"/>
    <rect width="${W}" height="${H}" fill="url(#vig)"/>`
        : `<g filter="url(#tea)" fill="#8a6a36">${E(1400, 120, 200, 120, 0.06, -12)}${E(1300, 190, 70, 46, 0.04)}</g>
    <g filter="url(#ink2)" fill="#1e2828">${E(90, 20, 340, 130, 0.045, 8)}${E(60, 30, 160, 60, 0.05)}</g>
    <g filter="url(#ink)" fill="#1a1d1b">
      ${E(1460, 1010, 600, 240, 0.07, -8)}${E(1500, 1010, 380, 150, 0.09, -6)}${E(1560, 990, 180, 90, 0.15)}${E(1600, 980, 80, 50, 0.12)}${E(1180, 1060, 260, 90, 0.05)}
    </g>`
    }
  </svg>`;
}

export async function paintBackdrop() {
  const W = Math.min(2400, window.innerWidth);
  const H = Math.min(1500, window.innerHeight);
  await Promise.all([paintLayer("bg-ink", "a", W, H), paintLayer("bg-ink-b", "b", W, H)]);
}

async function paintLayer(hostId: string, part: "a" | "b", W: number, H: number) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const src = inkScape(W, H, part);
  try {
    const img = new Image();
    img.src = svgUri(src);
    await img.decode();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("blob");
    const next = URL.createObjectURL(blob);
    const prev = host.dataset.blobUrl;
    if (prev) URL.revokeObjectURL(prev);
    host.dataset.blobUrl = next;
    host.style.backgroundImage = `url("${next}")`;
  } catch {
    host.style.backgroundImage = `url("${svgUri(src)}")`;
  }
  host.classList.add("ready");
}

export function bindInkDrop() {
  function onPointerDown(e: PointerEvent) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const button = target.closest(".btn-primary, .gen, .add-btn, .sbtn.primary");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const drop = document.createElement("span");
    drop.className = "ink-drop";
    drop.style.left = `${e.clientX}px`;
    drop.style.top = `${e.clientY}px`;
    document.body.appendChild(drop);
    window.setTimeout(() => drop.remove(), 820);
  }
  document.addEventListener("pointerdown", onPointerDown);
  return () => document.removeEventListener("pointerdown", onPointerDown);
}
