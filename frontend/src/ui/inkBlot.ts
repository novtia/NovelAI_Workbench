/**
 * 泼墨遮罩：一个被噪声层层扭曲的圆（中心全实，外缘毛糙、带细碎飞白和溅出的墨点），只用到 alpha 通道。
 *
 * 用 WebGL2 着色器程序化生成，每次换一个随机种子，所以每次切换主题墨迹的形状都不一样。
 * 生成后是一张位图：给 CSS 当遮罩的 blob 地址（界面/纸面），同一张画布也上传成纹理给背景着色器——两边是同一条边缘。
 * 不支持 WebGL2 时退回 SVG 滤镜生成（形状固定）。
 *
 * 形状约定（themeInk.ts 的放大尺寸依赖它）：半径 0.186 倍边长以内一定是实心的。
 */

export type Blot = { url: string; canvas: HTMLCanvasElement };

const N = 1024;

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// 与原来的 SVG 滤镜同一套结构：圆 + 溅点，经三层位移（大块起伏 / 中等毛边 / 细碎飞白）扭曲，再轻轻柔化。
// 三层位移的幅度上限与原来相同（0.15 / 0.045 / 0.012 倍边长的一半），所以中心实心区的半径保证不变。
const FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform float uSeed;
uniform float uN;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  float t = 0.0;
  for (int i = 0; i < 3; i++) {
    if (i >= oct) break;
    s += a * vn(p);
    t += a;
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return s / t;
}
// 位移量：每个分量夹在 ±0.5 内再乘幅度，保证上限
vec2 warp(vec2 p, float freq, int oct, float amp, float salt) {
  vec2 q = p * freq + uSeed * vec2(1.713, 2.291) + salt;
  vec2 n = vec2(fbm(q, oct), fbm(q + vec2(41.3, 17.9), oct));
  return clamp((n - 0.5) * 1.6, -0.5, 0.5) * amp;
}

const vec3 DROPS[8] = vec3[8](
  vec3(0.84, 0.31, 0.022), vec3(0.15, 0.42, 0.018), vec3(0.62, 0.90, 0.024), vec3(0.36, 0.10, 0.016),
  vec3(0.93, 0.62, 0.014), vec3(0.07, 0.72, 0.020), vec3(0.78, 0.12, 0.012), vec3(0.50, 0.97, 0.014));

float shape(vec2 q) {
  float d = length(q - vec2(0.5)) - 0.29;
  for (int i = 0; i < 8; i++) {
    // 溅点的位置每次略有不同，但始终在圆外、画面内
    vec2 j = vec2(hash(vec2(float(i) + 0.5, uSeed)), hash(vec2(uSeed + 3.7, float(i) + 0.5))) - 0.5;
    vec2 c = clamp(DROPS[i].xy + j * 0.1, 0.03, 0.97);
    d = min(d, length(q - c) - DROPS[i].z);
  }
  return d;
}

void main() {
  // 图像坐标：左上为原点，y 向下
  vec2 p = vec2(gl_FragCoord.x, uN - gl_FragCoord.y) / uN;
  vec2 q = p + warp(p, 220.0, 2, 0.012, 9.0);
  q += warp(q, 31.0, 3, 0.045, 5.0);
  q += warp(q, 5.6, 3, 0.15, 14.0);
  float w = 4.0 / uN; // 柔化
  float a = 1.0 - smoothstep(-w, w, shape(q));
  outColor = vec4(vec3(a), a);
}`;

type Renderer = { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement; prog: WebGLProgram; uSeed: WebGLUniformLocation | null; uN: WebGLUniformLocation | null };
let renderer: Renderer | null | undefined;

function getRenderer(): Renderer | null {
  if (renderer && !renderer.gl.isContextLost()) return renderer;
  if (renderer === null) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = N;
    canvas.height = N;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("webgl2");
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
    renderer = { gl, canvas, prog, uSeed: gl.getUniformLocation(prog, "uSeed"), uN: gl.getUniformLocation(prog, "uN") };
  } catch {
    renderer = null;
  }
  return renderer ?? null;
}

function renderGL(seed: number): HTMLCanvasElement | null {
  const r = getRenderer();
  if (!r) return null;
  const { gl } = r;
  gl.viewport(0, 0, N, N);
  gl.useProgram(r.prog);
  gl.uniform1f(r.uSeed, seed);
  gl.uniform1f(r.uN, N);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const out = document.createElement("canvas");
  out.width = N;
  out.height = N;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(r.canvas, 0, 0);
  return out;
}

function blotSvg() {
  const c = N / 2;
  const R = N * 0.29;
  const drops = [
    [0.84, 0.31, 0.022],
    [0.15, 0.42, 0.018],
    [0.62, 0.9, 0.024],
    [0.36, 0.1, 0.016],
    [0.93, 0.62, 0.014],
    [0.07, 0.72, 0.02],
    [0.78, 0.12, 0.012],
    [0.5, 0.97, 0.014],
  ]
    .map(([x, y, r]) => `<circle cx="${x * N}" cy="${y * N}" r="${r * N}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">
  <filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.0055" numOctaves="3" seed="14" result="n1"/>
    <feDisplacementMap in="SourceGraphic" in2="n1" scale="${N * 0.15}" xChannelSelector="R" yChannelSelector="G" result="d1"/>
    <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="3" seed="5" result="n2"/>
    <feDisplacementMap in="d1" in2="n2" scale="${N * 0.045}" xChannelSelector="G" yChannelSelector="B" result="d2"/>
    <feTurbulence type="fractalNoise" baseFrequency="0.35" numOctaves="2" seed="9" result="n3"/>
    <feDisplacementMap in="d2" in2="n3" scale="${N * 0.012}" xChannelSelector="B" yChannelSelector="R" result="d3"/>
    <feGaussianBlur in="d3" stdDeviation="${N * 0.0025}"/>
  </filter>
  <g filter="url(#f)" fill="#fff"><circle cx="${c}" cy="${c}" r="${R}"/>${drops}</g>
</svg>`;
}

async function renderSvg(): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(blotSvg())}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(img, 0, 0, N, N);
  return canvas;
}

/** 生成一张新的泼墨遮罩（seed 不传则随机）。 */
export async function makeBlot(seed = Math.random() * 100): Promise<Blot> {
  const canvas = renderGL(seed) ?? (await renderSvg());
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("blob");
  return { url: URL.createObjectURL(blob), canvas };
}
