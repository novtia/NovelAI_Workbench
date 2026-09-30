/**
 * 背景墨水：GPU 上的一张“墨浓度场”。
 * - 墨本身在不停地晕染流动（噪声驱动的基底，四角浓、中间淡淡一层）；
 * - 鼠标划过时，在轨迹两侧给出向外的推力，墨被推开、轨迹上露出纸面，
 *   之后推力衰减、墨慢慢向基底回流合拢。
 * WebGL2，半精度浮点纹理；不支持时返回 null，由静态泼墨底兜底。
 */

const SPLAT_MAX = 16;
const DYE_LONG = 512;
const VEL_LONG = 128;
const RENDER_SCALE = 0.5;
const TIME_SCALE = 3; // 基底墨的流动速度
const RADIUS = 0.1; // 鼠标影响半径，以窗口高度为单位

const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return s;
}

// 基底墨：x = 墨浓度，y = 茶色浓度。uv 原点在左下。
vec2 baseInk(vec2 uv, float t, float asp) {
  vec2 p = uv * vec2(asp, 1.0);
  vec2 w = vec2(fbm(p * 1.7 + vec2(t * 0.045, 3.1)), fbm(p * 1.7 + vec2(8.3, -t * 0.04)));

  // 右下：主墨团，随呼吸缓缓涨落
  float breathe = 1.0 + 0.09 * sin(t * 0.21) + 0.05 * sin(t * 0.37 + 1.3);
  vec2 e1 = (uv - vec2(1.0, 0.0)) / (vec2(0.46, 0.34) * breathe);
  e1 += (w - 0.5) * 0.7;
  float m1 = 1.0 - smoothstep(0.1, 1.0, length(e1));
  m1 *= 0.3 + 1.4 * smoothstep(0.22, 0.78, fbm(p * 3.0 + vec2(t * 0.03, -t * 0.022) + w));
  float core = 1.0 - smoothstep(0.0, 1.0, length((uv - vec2(1.0, 0.0)) / vec2(0.2, 0.16)) + (w.x - 0.5) * 0.6);

  // 左上：淡墨
  float breathe2 = 1.0 + 0.1 * sin(t * 0.17 + 2.0);
  vec2 e2 = (uv - vec2(0.0, 1.0)) / (vec2(0.4, 0.24) * breathe2);
  e2 += (w.yx - 0.5) * 0.7;
  float m2 = 1.0 - smoothstep(0.1, 1.0, length(e2));
  m2 *= 0.3 + 1.4 * smoothstep(0.22, 0.78, fbm(p * 3.2 + vec2(-t * 0.025, t * 0.03) + w.yx));

  // 全屏淡淡一层游动的水墨，让鼠标在任何地方都能划开点什么
  float wash = smoothstep(0.42, 0.8, fbm(p * 1.5 + (w - 0.5) * 1.6 + vec2(t * 0.02, t * 0.013)));

  float ink = 0.8 * m1 + 0.45 * core + 0.32 * m2 + 0.22 * wash;

  // 右上：一抹茶色
  vec2 e3 = (uv - vec2(0.88, 0.88)) / vec2(0.16, 0.13);
  e3 += (w - 0.5) * 0.6;
  float tea = (1.0 - smoothstep(0.1, 1.0, length(e3))) * (0.5 + 0.7 * fbm(p * 4.0 + t * 0.02));
  return vec2(clamp(ink, 0.0, 1.0), clamp(tea, 0.0, 1.0));
}

vec2 ambient(vec2 uv, float t, float asp) {
  vec2 p = uv * vec2(asp, 1.0);
  return vec2(fbm(p * 2.0 + vec2(t * 0.05, 1.7)) - 0.5, fbm(p * 2.0 + vec2(5.3, -t * 0.045)) - 0.5) * 0.045;
}
`;

const FS_VEL = `${COMMON}
uniform sampler2D uVel;
uniform float uDecay;
uniform float uAsp;
uniform float uR;
uniform int uCount;
uniform vec4 uSplat[${SPLAT_MAX}];
uniform float uStr[${SPLAT_MAX}];
void main() {
  vec3 s = texture(uVel, vUv).xyz * uDecay;
  vec2 v = s.xy;
  float wake = s.z; // 鼠标刚划过的“水痕”，会把轨迹上的墨排开
  for (int i = 0; i < ${SPLAT_MAX}; i++) {
    if (i >= uCount) break;
    vec2 d = (vUv - uSplat[i].xy) * vec2(uAsp, 1.0);
    float g = exp(-dot(d, d) / (uR * uR));
    vec2 m = uSplat[i].zw;
    vec2 perp = vec2(-m.y, m.x);
    float side = dot(d, perp);
    // 沿路径两侧向外推，正中间只带一点前进方向的力
    v += g * uStr[i] * (perp * 2.4 * tanh(side / (uR * 0.35)) + m * 0.5);
    wake += g * min(1.0, uStr[i] * 6.0);
  }
  outColor = vec4(v, wake, 1.0);
}`;

const FS_BASE = `${COMMON}
uniform float uT;
uniform float uAsp;
void main() { outColor = vec4(baseInk(vUv, uT, uAsp), 0.0, 1.0); }`;

const FS_DYE = `${COMMON}
uniform sampler2D uDye;
uniform sampler2D uVel;
uniform sampler2D uBase;
uniform float uDt;
uniform float uT;
uniform float uAsp;
uniform float uRelax;
// 纹理里存的是“偏离基底的量”dev（墨 = 基底 + dev）。基底每帧先画进 uBase，这里只采样。
void main() {
  vec3 vs = texture(uVel, vUv).xyz;
  vec2 coord = vUv - uDt * (vs.xy + ambient(vUv, uT, uAsp)) / vec2(uAsp, 1.0);
  vec2 base = texture(uBase, vUv).xy;
  vec2 dye = texture(uDye, coord).xy + texture(uBase, coord).xy;
  // 水痕所在处，墨被排开（露出纸面）
  dye *= 1.0 - clamp(vs.z, 0.0, 1.0) * (1.0 - exp(-7.0 * uDt));
  outColor = vec4((dye - base) * exp(-uRelax * uDt), 0.0, 1.0);
}`;

const FS_DISPLAY = `${COMMON}
uniform sampler2D uDye;
uniform sampler2D uBase;
uniform vec2 uTexel;
uniform float uAsp;
uniform float uT;
void main() {
  vec2 d = texture(uDye, vUv).xy + texture(uBase, vUv).xy;
  float dl = texture(uDye, vUv - vec2(uTexel.x, 0.0)).x;
  float dr = texture(uDye, vUv + vec2(uTexel.x, 0.0)).x;
  float db = texture(uDye, vUv - vec2(0.0, uTexel.y)).x;
  float dt = texture(uDye, vUv + vec2(0.0, uTexel.y)).x;
  float grad = length(vec2(dr - dl, dt - db));
  // 纸纤维让墨色不那么均匀
  float grain = 0.86 + 0.28 * vnoise(vUv * vec2(uAsp, 1.0) * 140.0) * vnoise(vUv * vec2(uAsp, 1.0) * 37.0 + 4.0);
  float ink = clamp(d.x, 0.0, 1.0);
  // 浓度落差大的地方（被推开后堆起的边）墨色更深，像水墨的湿边
  float aInk = clamp((ink * 0.52 + grad * 3.2) * grain, 0.0, 0.7);
  float aTea = clamp(d.y, 0.0, 1.0) * 0.17;
  vec3 inkCol = vec3(0.102, 0.114, 0.106);
  vec3 teaCol = vec3(0.541, 0.416, 0.212);
  float a = 1.0 - (1.0 - aInk) * (1.0 - aTea);
  vec3 rgb = inkCol * aInk + teaCol * aTea * (1.0 - aInk);
  outColor = vec4(rgb, a);
}`;

type Program = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer };
type Pair = { w: number; h: number; a: Target; b: Target };

export function bindInkFluid(canvas: HTMLCanvasElement): (() => void) | null {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return null;

  function compile(type: number, src: string) {
    const s = gl!.createShader(type)!;
    gl!.shaderSource(s, src);
    gl!.compileShader(s);
    if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(s) || "shader");
    return s;
  }
  function program(fs: string, names: string[]): Program {
    const p = gl!.createProgram()!;
    gl!.attachShader(p, compile(gl!.VERTEX_SHADER, VS));
    gl!.attachShader(p, compile(gl!.FRAGMENT_SHADER, fs));
    gl!.linkProgram(p);
    if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) throw new Error(gl!.getProgramInfoLog(p) || "link");
    const u: Program["u"] = {};
    for (const n of names) u[n] = gl!.getUniformLocation(p, n);
    return { p, u };
  }

  let pBase: Program;
  let pVel: Program;
  let pDye: Program;
  let pDisp: Program;
  try {
    pBase = program(FS_BASE, ["uT", "uAsp"]);
    pVel = program(FS_VEL, ["uVel", "uDecay", "uAsp", "uR", "uCount", "uSplat", "uStr"]);
    pDye = program(FS_DYE, ["uDye", "uVel", "uBase", "uDt", "uT", "uAsp", "uRelax"]);
    pDisp = program(FS_DISPLAY, ["uDye", "uBase", "uTexel", "uAsp", "uT"]);
  } catch {
    return null;
  }

  function target(w: number, h: number): Target | null {
    const tex = gl!.createTexture()!;
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA16F, w, h, 0, gl!.RGBA, gl!.HALF_FLOAT, null);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    const fbo = gl!.createFramebuffer()!;
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, tex, 0);
    if (gl!.checkFramebufferStatus(gl!.FRAMEBUFFER) !== gl!.FRAMEBUFFER_COMPLETE) return null;
    gl!.viewport(0, 0, w, h);
    gl!.clearColor(0, 0, 0, 1);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    return { tex, fbo };
  }
  function pair(long: number, asp: number): Pair | null {
    const w = asp >= 1 ? long : Math.round(long * asp);
    const h = asp >= 1 ? Math.round(long / asp) : long;
    const a = target(w, h);
    const b = target(w, h);
    return a && b ? { w, h, a, b } : null;
  }
  function free(pr: Pair | null) {
    if (!pr) return;
    for (const t of [pr.a, pr.b]) {
      gl!.deleteTexture(t.tex);
      gl!.deleteFramebuffer(t.fbo);
    }
  }
  function swap(pr: Pair) {
    const t = pr.a;
    pr.a = pr.b;
    pr.b = t;
  }
  function draw(to: Target | null, w: number, h: number) {
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, to ? to.fbo : null);
    gl!.viewport(0, 0, w, h);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }
  function bindTex(unit: number, t: Target) {
    gl!.activeTexture(gl!.TEXTURE0 + unit);
    gl!.bindTexture(gl!.TEXTURE_2D, t.tex);
  }

  let dye: Pair | null = null;
  let vel: Pair | null = null;
  let base: Target | null = null;
  let asp = 1;

  function setup() {
    canvas.width = Math.max(1, Math.round(window.innerWidth * RENDER_SCALE));
    canvas.height = Math.max(1, Math.round(window.innerHeight * RENDER_SCALE));
    asp = window.innerWidth / Math.max(1, window.innerHeight);
    free(dye);
    free(vel);
    if (base) {
      gl!.deleteTexture(base.tex);
      gl!.deleteFramebuffer(base.fbo);
      base = null;
    }
    dye = pair(DYE_LONG, asp);
    vel = pair(VEL_LONG, asp);
    base = dye ? target(dye.w, dye.h) : null;
    gl!.clearColor(0, 0, 0, 0);
    return Boolean(dye && vel && base); // 新建的纹理全 0：即“与基底没有偏离”
  }
  if (!setup()) return null;

  // ---- 鼠标 ----
  const splats: { x: number; y: number; mx: number; my: number; s: number }[] = [];
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let has = false;
  function onMove(e: PointerEvent) {
    if (e.pointerType === "touch" && e.buttons === 0) return;
    const now = performance.now();
    if (!has) {
      has = true;
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = now;
      return;
    }
    const H = Math.max(1, window.innerHeight);
    const dx = (e.clientX - lastX) / H;
    const dy = -(e.clientY - lastY) / H;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.004) return;
    const speed = dist / Math.max(0.001, (now - lastT) / 1000); // 高度/秒
    const mx = dx / dist;
    const my = dy / dist;
    const strength = Math.min(0.2, 0.05 + speed * 0.045);
    const steps = Math.min(8, Math.max(1, Math.ceil(dist / (RADIUS * 0.5))));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      splats.push({
        x: (lastX + (e.clientX - lastX) * t) / window.innerWidth,
        y: 1 - (lastY + (e.clientY - lastY) * t) / H,
        mx,
        my,
        s: strength,
      });
    }
    if (splats.length > SPLAT_MAX * 3) splats.splice(0, splats.length - SPLAT_MAX * 3);
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = now;
  }
  function onLeave() {
    has = false;
  }

  // ---- 每帧 ----
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  let raf = 0;
  let prev = 0;
  let t = 0;
  const splatBuf = new Float32Array(SPLAT_MAX * 4);
  const strBuf = new Float32Array(SPLAT_MAX);

  gl.disable(gl.BLEND);

  function step(now: number) {
    raf = requestAnimationFrame(step);
    const dt = Math.min(0.033, Math.max(0.001, (now - (prev || now - 16)) / 1000));
    prev = now;
    t += dt * TIME_SCALE;
    if (!dye || !vel || !base) return;
    if (document.hidden || document.body.classList.contains("is-resizing") || document.documentElement.dataset.view !== "studio") {
      prev = now;
      return;
    }

    // 0) 基底墨画进一张纹理，后面的 pass 只采样，不再各算一遍噪声
    gl!.useProgram(pBase.p);
    gl!.uniform1f(pBase.u.uT, t);
    gl!.uniform1f(pBase.u.uAsp, asp);
    draw(base, dye.w, dye.h);

    // 1) 速度场：衰减 + 新的推力
    const take = splats.splice(0, SPLAT_MAX);
    for (let i = 0; i < take.length; i++) {
      splatBuf.set([take[i].x, take[i].y, take[i].mx, take[i].my], i * 4);
      strBuf[i] = take[i].s;
    }
    gl!.useProgram(pVel.p);
    bindTex(0, vel.a);
    gl!.uniform1i(pVel.u.uVel, 0);
    gl!.uniform1f(pVel.u.uDecay, Math.exp(-2.6 * dt));
    gl!.uniform1f(pVel.u.uAsp, asp);
    gl!.uniform1f(pVel.u.uR, RADIUS);
    gl!.uniform1i(pVel.u.uCount, take.length);
    gl!.uniform4fv(pVel.u.uSplat, splatBuf);
    gl!.uniform1fv(pVel.u.uStr, strBuf);
    draw(vel.b, vel.w, vel.h);
    swap(vel);

    // 2) 墨随速度场流动，并慢慢回流向随时间变化的基底
    gl!.useProgram(pDye.p);
    bindTex(0, dye.a);
    bindTex(1, vel.a);
    bindTex(2, base);
    gl!.uniform1i(pDye.u.uDye, 0);
    gl!.uniform1i(pDye.u.uVel, 1);
    gl!.uniform1i(pDye.u.uBase, 2);
    gl!.uniform1f(pDye.u.uDt, dt);
    gl!.uniform1f(pDye.u.uT, t);
    gl!.uniform1f(pDye.u.uAsp, asp);
    gl!.uniform1f(pDye.u.uRelax, 0.6);
    draw(dye.b, dye.w, dye.h);
    swap(dye);

    // 3) 上屏
    display();
  }
  function display() {
    if (!dye) return;
    gl!.useProgram(pDisp.p);
    bindTex(0, dye.a);
    if (base) bindTex(1, base);
    gl!.uniform1i(pDisp.u.uDye, 0);
    gl!.uniform1i(pDisp.u.uBase, 1);
    gl!.uniform2f(pDisp.u.uTexel, 1 / dye.w, 1 / dye.h);
    gl!.uniform1f(pDisp.u.uAsp, asp);
    gl!.uniform1f(pDisp.u.uT, t);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null); // 先切到屏幕再清，否则会把刚算好的墨场清掉
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    draw(null, canvas.width, canvas.height);
  }

  let resizeTimer = 0;
  function onResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (setup() && reduced) display();
    }, 120);
  }
  window.addEventListener("resize", onResize);

  if (reduced) {
    const layer = dye as Pair | null;
    if (layer && base) {
      gl.useProgram(pBase.p);
      gl.uniform1f(pBase.u.uT, 0);
      gl.uniform1f(pBase.u.uAsp, asp);
      draw(base, layer.w, layer.h);
    }
    display(); // 减少动态效果：只画一帧静态的墨
  } else {
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    raf = requestAnimationFrame(step);
  }

  return () => {
    cancelAnimationFrame(raf);
    window.clearTimeout(resizeTimer);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("pointermove", onMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    free(dye);
    free(vel);
    if (base) {
      gl!.deleteTexture(base.tex);
      gl!.deleteFramebuffer(base.fbo);
    }
    dye = vel = base = null;
  };
}
