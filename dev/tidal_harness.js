// Headless harness for the tidal Sediment Interface (tidal-prototype.html).
// Takes the page, extracts the inline script that defines setup(), mocks p5 + the DOM,
// then drives the real app and asserts on its own state:
//
//   1. setup() completes                    — a TypeError in setup kills every later listener
//   2. the draw loop advances tidal time    — proves the loop body ran, not that pixels drew
//   3. etaLevel repeats exactly one period  — everything downstream derives from it
//   4. etaLevel stays in its amplitude      — the analytic bound is A(1 + asym)
//   5. flowAt is finite and non-trivial     — the field the particles follow is usable
//   6. the flow reverses flood/ebb          — it tracks d(eta)/dt, not a fixed bias
//   7. net transport is one-signed          — the M4 asymmetry mechanism actually holds
//   8. particle count holds, positions finite
//   9. the deposition field stays finite
//
// Exits 0 on pass, 1 on any failure, so it can gate a commit.
//
//   node dev/tidal_harness.js tidal-prototype.html
//
// Verified to have teeth: adding a 1e-6·t drift inside etaLevel fails check 3 alone, with
// max drift 1.08e-3, and exits 1 — every other check still passes, so the check is specific.
// A syntax error in the page is caught at load and reported as such rather than crashing.
//
// WHAT THIS MODEL IS NOT. It is an analytic tidal-prism model, not a solver: etaLevel() is
// prescribed, flowAt() is d(eta)/dt scaled by a landward decay and a channel envelope, and
// the bed is never compared against the water level anywhere. etaLevel() is called in exactly
// one place — the tide gauge in draw() — and the bed runs 40 (channel) to 130 (marsh) in
// pixel units against an eta of ±3. So there is no moving shoreline here.
//
// That matters for the research note's recommendation #1: the Thacker benchmark is entirely
// about a moving shoreline, and this interface has no wet/dry field to measure it against.
// A Thacker test needs a shallow-water solve with an evolving water surface, which this is
// not. What can be tested is what is above, and that is what this harness does.
//
// The p5/DOM mock block is adapted from the fluvial harness's mock, which came from the
// coastal harness; the checks below are specific to this app.

const fs = require("fs");
const path = require("path");

const HTML = process.argv[2] || "index.html";
const html = fs.readFileSync(HTML, "utf8");

// ---------------------------------------------------------------- defaults from the markup
const DEFAULTS = {};
for (const m of html.matchAll(/id="([^"]+)"[^>]*?value="([^"]*)"/g)) DEFAULTS[m[1]] = m[2];
// select elements carry no value=; take the first option
for (const m of html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const opt = m[2].match(/value="([^"]*)"/);
  if (opt && !(m[1] in DEFAULTS)) DEFAULTS[m[1]] = opt[1];
}

// ---------------------------------------------------------------- p5 / DOM mocks
const noop = () => {};
const ctx = () => ({
  background: noop, clear: noop, fill: noop, stroke: noop, noStroke: noop, noFill: noop,
  rect: noop, ellipse: noop, line: noop, circle: noop, text: noop, textSize: noop,
  textAlign: noop, push: noop, pop: noop, translate: noop, rotate: noop, scale: noop,
  image: noop, beginShape: noop, endShape: noop, vertex: noop, strokeWeight: noop,
  point: noop, quad: noop, triangle: noop, arc: noop, curve: noop, bezier: noop,
  curveVertex: noop, bezierVertex: noop, curveTightness: noop, endContour: noop,
  rectMode: noop, ellipseMode: noop, imageMode: noop, angleMode: noop,
  strokeCap: noop, strokeJoin: noop, blendMode: noop, tint: noop, noTint: noop,
  textLeading: noop, textStyle: noop, textWrap: noop,
  rotateX: noop, rotateY: noop, rotateZ: noop, applyMatrix: noop, resetMatrix: noop,
  shearX: noop, shearY: noop, erase: noop, noErase: noop,
  save: noop, restore: noop, createImageData: () => ({ data: new Uint8ClampedArray(4) }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
  putImageData: noop, drawImage: noop,
  clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop, closePath: noop,
  moveTo: noop, lineTo: noop, arc2: noop, quadraticCurveTo: noop,
  setTransform: noop, resetTransform: noop, transform: noop, clip: noop,
  fillText: noop, strokeText: noop, measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop: noop }),
  createRadialGradient: () => ({ addColorStop: noop }),
  createPattern: () => ({}), isPointInPath: () => false,
  fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "10px sans-serif",
  globalAlpha: 1, lineCap: "butt", lineJoin: "miter", globalCompositeOperation: "source-over",
  canvas: { width: 1200, height: 800 },
});

const els = new Map();
function el(id) {
  if (els.has(id)) return els.get(id);
  const e = {
    id, textContent: "", innerHTML: "", checked: false,
    value: id in DEFAULTS ? DEFAULTS[id] : "0",
    width: 200, height: 120, style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop, appendChild: noop, removeChild: noop,
    getContext: () => ctx(), setAttribute: noop, getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 120 }),
    querySelector: () => el(id + "-child"), querySelectorAll: () => [],
    focus: noop, blur: noop, scrollTo: noop,
  };
  els.set(id, e);
  return e;
}

global.__keydown = [];
global.__keyup = [];
global.window = {
  addEventListener: (t, fn) => { if (t === 'keydown') global.__keydown.push(fn); },
  removeEventListener: noop,
  innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
  location: { href: "http://localhost/", search: "" },
  requestAnimationFrame: noop, localStorage: { getItem: () => null, setItem: noop },
};
global.document = {
  getElementById: el, createElement: () => el("created"),
  addEventListener: noop, removeEventListener: noop,
  body: el("body"), documentElement: el("html"),
  querySelector: () => el("q"), querySelectorAll: () => [],
};
global.navigator = { userAgent: "node", language: "en" };


// ============================================================ software rasterizer (PRECISION=1)
function makeRaster(w, h) {
  const buf = new Float32Array(w * h * 4);          // RGBA, 0..255, source-over composited
  let fillCol = [0, 0, 0, 255], strokeCol = [0, 0, 0, 255];
  let doFill = true, doStroke = true;

  const norm = (a) => {
    if (a.length === 1) return [a[0], a[0], a[0], 255];
    if (a.length === 2) return [a[0], a[0], a[0], a[1]];
    if (a.length === 3) return [a[0], a[1], a[2], 255];
    return [a[0], a[1], a[2], a[3]];
  };

  const px = (x, y, c) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = ((y | 0) * w + (x | 0)) * 4;
    const a = c[3] / 255;
    if (a <= 0) return;
    buf[i]     = buf[i]     * (1 - a) + c[0] * a;
    buf[i + 1] = buf[i + 1] * (1 - a) + c[1] * a;
    buf[i + 2] = buf[i + 2] * (1 - a) + c[2] * a;
    buf[i + 3] = Math.min(255, buf[i + 3] + c[3]);
  };

  const g = {
    width: w, height: h, _buf: buf,
    clear() { buf.fill(0); },
    background(...a) { const c = norm(a); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px(x, y, c); },
    fill(...a) { fillCol = norm(a); doFill = true; },
    noFill() { doFill = false; },
    stroke(...a) { strokeCol = norm(a); doStroke = true; },
    noStroke() { doStroke = false; },
    strokeWeight() {},
    rect(x, y, ww, hh) {
      if (!doFill) return;
      const x0 = Math.round(x), y0 = Math.round(y);
      const x1 = Math.round(x + ww), y1 = Math.round(y + hh);
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) px(xx, yy, fillCol);
    },
    point(x, y) { if (doStroke) px(Math.round(x), Math.round(y), strokeCol); },
    ellipse(x, y, d) { if (doFill) px(Math.round(x), Math.round(y), fillCol); },
    line(x1, y1, x2, y2) { if (doStroke) { px(x1, y1, strokeCol); px(x2, y2, strokeCol); } },
    push() {}, pop() {}, translate() {}, rotate() {}, scale() {},
    image() {}, text() {}, textAlign() {}, textSize() {}, triangle() {}, quad() {},
    beginShape() {}, endShape() {}, vertex() {}, bezier() {}, arc() {}, curve() {},
    loadPixels() {}, updatePixels() {},
  };
  return g;
}

globalThis.__rasters = [];

let W = 1200, H = 800;
Object.defineProperty(global, "windowWidth",  { get: () => W, set: v => W = v });
Object.defineProperty(global, "windowHeight", { get: () => H, set: v => H = v });
Object.defineProperty(global, "width",        { get: () => W, set: v => W = v });
Object.defineProperty(global, "height",       { get: () => H, set: v => H = v });

Object.assign(global, {
  PI: Math.PI, TWO_PI: Math.PI * 2, HALF_PI: Math.PI / 2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2, asin: Math.asin,
  sqrt: Math.sqrt, pow: Math.pow, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  round: Math.round, min: Math.min, max: Math.max, exp: Math.exp, log: Math.log,
  dist: (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1),
  radians: d => d * Math.PI / 180, degrees: r => r * 180 / Math.PI,
  constrain: (v, a, b) => Math.min(Math.max(v, a), b),
  lerp: (a, b, t) => a + (b - a) * t,
  map: (v, a, b, c, d) => c + ((v - a) / ((b - a) || 1)) * (d - c),
  // Under PRECISION the RNG must be seeded: particle deposition is random, and an unstable
  // bed makes a rendering comparison measure noise instead of the code change.
  random: (() => {
    let seed = 12345;
    const rnd = () => {
      if (process.env.PRECISION || process.env.SCORE) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
      return Math.random();
    };
    return (a, b) => (a === undefined ? rnd() : (b === undefined ? rnd() * a : a + rnd() * (b - a)));
  })(),
  noise: () => 0.5, noiseDetail: noop, randomSeed: noop, frameRate: noop,
  keyIsDown: () => false, key: "", keyCode: 0, mouseIsPressed: false, mouseX: 0, mouseY: 0,
  mouseButton: "left", touches: [], cursor: noop, noCursor: noop,
  mag: (x, y) => Math.hypot(x, y), sq: x => x * x, sign: Math.sign,
  norm: (v, a, b) => (v - a) / ((b - a) || 1), fract: x => x - Math.floor(x),
  int: v => Math.trunc(v), float: v => parseFloat(v),
  red: () => 0, green: () => 0, blue: () => 0, alpha: () => 255,
  color: () => ({ levels: [0, 0, 0, 255] }), lerpColor: () => ({ levels: [0, 0, 0, 255] }),
  // p5 drawing API, at global scope (the app calls these bare, not on a context)
  createCanvas: () => ({ parent: noop, style: {}, elt: el("canvas"), id: () => "c" }),
  pixelDensity: noop, background: noop, noFill: noop, textFont: noop,
  textWidth: () => 10,
  createGraphics: (w, h) => {
    if (process.env.PRECISION) {
      const g = makeRaster(w || W, h || H);
      globalThis.__rasters.push(g);
      return g;
    }
    return Object.assign(ctx(), { width: W, height: H });
  },
  loadImage: noop, redraw: noop, frameCount: 0, noLoop: noop, loop: noop,
  resizeCanvas: (w, h) => { W = w; H = h; },
  clear: noop, fill: noop, stroke: noop, noStroke: noop, strokeWeight: noop,
  rect: noop, ellipse: noop, line: noop, circle: noop, point: noop, quad: noop,
  triangle: noop, arc: noop, curve: noop, bezier: noop, image: noop,
  text: noop, textSize: noop, textAlign: noop, textLeading: noop, textStyle: noop,
  push: noop, pop: noop, translate: noop, rotate: noop, scale: noop,
  // drawGhost() styles the 2D context directly for shadow effects; the mock needs one.
  // drawGhost() and friends drive the 2D context directly. A Proxy no-ops any method and
  // stores any property, so the mock does not need to enumerate the canvas API.
  drawingContext: new Proxy({ shadowBlur: 0, shadowColor: "", globalAlpha: 1,
                              globalCompositeOperation: "source-over",
                              canvas: { width: 1200, height: 800 } }, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  }),
  beginShape: noop, endShape: noop, vertex: noop, curveVertex: noop, bezierVertex: noop,
  curveTightness: noop, endContour: noop, rectMode: noop, ellipseMode: noop,
  imageMode: noop, angleMode: noop, strokeCap: noop, strokeJoin: noop, blendMode: noop,
  tint: noop, noTint: noop, applyMatrix: noop, resetMatrix: noop, shearX: noop, shearY: noop,
  erase: noop, noErase: noop, rotateX: noop, rotateY: noop, rotateZ: noop,
  CENTER: "center", LEFT: "left", RIGHT: "right", TOP: "top", BOTTOM: "bottom",
  BASELINE: "alphabetic", CORNER: "corner", CORNERS: "corners", RADIUS: "radius",
  CLOSE: "close", OPEN: "open", CHORD: "chord", PIE: "pie", PROJECT: "square",
  ROUND: "round", SQUARE: "butt", MITER: "miter", BEVEL: "bevel", RGB: "rgb", HSB: "hsb",
  HSL: "hsl", ADD: "lighter", MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay",
  REPLACE: "source-over", DIFFERENCE: "difference", EXCLUSION: "exclusion",
  UP_ARROW: 38, DOWN_ARROW: 40, LEFT_ARROW: 37, RIGHT_ARROW: 39,
  ENTER: 13, RETURN: 13, ESCAPE: 27, BACKSPACE: 8, DELETE: 46, TAB: 9, SHIFT: 16,
  CONTROL: 17, ALT: 18, OPTION: 18, SPACE: 32,
});
global.p5 = { disableFriendlyErrors: true, prototype: {}, Vector: function () {} };

// ---------------------------------------------------------------- load the app
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(function (b) { return b[1]; });
const src = blocks.find(function (b) { return b.indexOf('function setup') >= 0; });
if (!src) { console.error('FAIL: no inline <script> containing setup()'); process.exit(1); }

// ---------------------------------------------------------------- tidal app bridge
try {
  new Function(src + `
;globalThis.__app = {
  setup: typeof setup==='function'?setup:null,
  draw: typeof draw==='function'?draw:null,
  etaLevel: typeof etaLevel==='function'?etaLevel:null,
  dEtaDt: typeof dEtaDt==='function'?dEtaDt:null,
  flowAt: typeof flowAt==='function'?flowAt:null,
  flowAmplitude: typeof flowAmplitude==='function'?flowAmplitude:null,
  netTransport: typeof netTransport==='function'?netTransport:null,
  bedZ: typeof bedZ==='function'?bedZ:null,
  defaultBed: typeof defaultBed==='function'?defaultBed:null,
  updateParticles: typeof updateParticles==='function'?updateParticles:null,
  getState: () => ({
    particles: typeof particles!=='undefined'?particles:null,
    simTime: typeof simTime!=='undefined'?simTime:null,
    tidalAmp: typeof tidalAmp!=='undefined'?tidalAmp:null,
    tidalPeriod: typeof tidalPeriod!=='undefined'?tidalPeriod:null,
    asym: typeof asym!=='undefined'?asym:null,
    paused: typeof paused!=='undefined'?paused:null,
    GW: typeof GW!=='undefined'?GW:null,
    GH: typeof GH!=='undefined'?GH:null,
    depoGrid: typeof depoGrid!=='undefined'?depoGrid:null,
    structures: typeof structures!=='undefined'?structures:null,
    width: typeof width!=='undefined'?width:null,
    height: typeof height!=='undefined'?height:null,
  }),
  setSimTime: (t) => { simTime = t; },
  setPaused: (p) => { paused = p; },
};
`)();
} catch (e) {
  console.error("SCRIPT THREW ON LOAD:\n" + e.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
}

const app = globalThis.__app;
const S = () => app.getState();

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

console.log(`defaults from markup: ${Object.keys(DEFAULTS).length} controls`);

// ---------------------------------------------------------------- 1. setup
try {
  app.setup();
  check(true, "setup() completes without throwing", "clean");
} catch (e) {
  check(false, "setup() completes without throwing", e.message);
  console.log("HARNESS FAIL — setup aborted, nothing else can run");
  process.exit(1);
}

// ---------------------------------------------------------------- 2. the loop runs
{
  app.setPaused(false);
  const t0 = S().simTime;
  for (let i = 0; i < 60; i++) app.draw();
  const t1 = S().simTime;
  check(t1 > t0, "the draw loop advances tidal time", `${t0.toFixed(2)} -> ${t1.toFixed(2)} s`);
}

// ---------------------------------------------------------------- 3. the tide is periodic
// etaLevel is the analytic forcing everything else is derived from. If it does not repeat
// exactly one period later, nothing downstream means anything.
{
  const P = S().tidalPeriod;
  let worst = 0;
  for (const t of [0, 37.5, 90, 180, 271.3, 359]) {
    app.setSimTime(t);
    const a = app.etaLevel();
    app.setSimTime(t + P);
    const b = app.etaLevel();
    worst = Math.max(worst, Math.abs(a - b));
  }
  check(worst < 1e-9, "etaLevel repeats exactly one tidal period later", `max drift ${worst.toExponential(2)} over 6 phases`);
}

// ---------------------------------------------------------------- 4. the tide stays in range
{
  const { tidalAmp, asym } = S();
  let lo = Infinity, hi = -Infinity;
  for (let t = 0; t < 720; t += 1.5) {
    app.setSimTime(t);
    const e = app.etaLevel();
    if (e < lo) lo = e;
    if (e > hi) hi = e;
  }
  const bound = tidalAmp * (1 + asym);
  check(lo >= -bound - 1e-9 && hi <= bound + 1e-9,
        "etaLevel stays inside its analytic amplitude", `range [${lo.toFixed(3)}, ${hi.toFixed(3)}] vs ±${bound.toFixed(3)}`);
}

// ---------------------------------------------------------------- 5. the flow field is usable
// flowAt returns a scalar (along-channel px/s), not a vector — it is dEtaDt scaled by the
// landward decay and the channel envelope, plus net transport.
{
  const w = S().width, h = S().height;
  let bad = 0, peak = 0, samples = 0;
  for (let t = 0; t < 360; t += 30) {
    app.setSimTime(t);
    for (let gx = 0; gx <= 10; gx++) {
      for (let gy = 0; gy <= 10; gy++) {
        const f = app.flowAt(w * gx / 10, h * gy / 10);
        samples++;
        if (!isFinite(f)) bad++;
        else if (Math.abs(f) > peak) peak = Math.abs(f);
      }
    }
  }
  check(bad === 0 && peak > 0, "flowAt is finite everywhere and non-trivial somewhere",
        `${samples} samples, ${bad} bad, peak |flow| ${peak.toFixed(4)} px/s`);
}

// ---------------------------------------------------------------- 6. the tide reverses the flow
// What CAN be tested here: the along-channel flow follows d(eta)/dt, so it must change sign
// across a tidal cycle — flood landward, ebb seaward. And with flood dominance (asym > 0)
// the net transport must be one-signed, which is the whole mechanism the model is built on.
//
// What CANNOT be tested: a moving shoreline. There is no waterline in this model. etaLevel()
// is called in exactly one place — the tide gauge in draw() — and nothing anywhere compares
// water level against bedZ. The bed runs 40 (channel) to 130 (marsh) in pixel units while
// eta oscillates within ±tidalAmp. So the Thacker benchmark, which is entirely about a
// moving shoreline, has no wet/dry field here to measure. That is a finding about the
// model, not a gap in the harness.
{
  const w = S().width, h = S().height;
  const xMid = w * 0.5, yMid = h * 0.5;
  // dEtaDt = A·w·cos(wt), so it peaks at t = 0 and is most negative at t = P/2.
  // Sampling at P/4 and 3P/4 gives cos = 0 at both, which measures net transport twice.
  app.setSimTime(0);
  const flood = app.flowAt(xMid, yMid);
  app.setSimTime(S().tidalPeriod * 0.5);
  const ebb = app.flowAt(xMid, yMid);
  check(flood > 0 && ebb < 0, "the flow reverses between flood and ebb",
        `flood +${flood.toFixed(2)}, ebb ${ebb.toFixed(3)} px/s`);

  let netMin = Infinity, netMax = -Infinity;
  for (let t = 0; t < 360; t += 45) {
    app.setSimTime(t);
    for (const gx of [0.1, 0.3, 0.5, 0.7]) {
      const n = app.netTransport(w * gx, yMid);
      if (n < netMin) netMin = n;
      if (n > netMax) netMax = n;
    }
  }
  check(netMin >= 0 && netMax > 0, "net transport is one-signed for a flood-dominant tide",
        `asym ${S().asym}, net range [${netMin.toExponential(2)}, ${netMax.toExponential(2)}]`);

  console.log("  ....  no waterline in this model: etaLevel() is display-only, so a Thacker");
  console.log("        moving-shoreline test has no wet/dry field to measure");
}

// ---------------------------------------------------------------- 7. particle bookkeeping
{
  const P = S().particles;
  const n0 = P.length;
  app.setPaused(false);
  for (let i = 0; i < 60; i++) app.draw();
  const n1 = S().particles.length;
  const bad = S().particles.filter(p => !isFinite(p.x) || !isFinite(p.y)).length;
  check(n0 > 0 && n1 === n0 && bad === 0, "particle count holds and positions stay finite",
        `${n0} -> ${n1}, ${bad} bad`);
}

// ---------------------------------------------------------------- 8. deposition is finite
{
  const d = S().depoGrid;
  const bad = d ? d.reduce((n, x) => n + (isFinite(x) ? 0 : 1), 0) : -1;
  check(d && bad === 0, "the deposition field stays finite", `${d ? d.length : 0} cells, ${bad} bad`);
}

console.log("");
if (failures === 0) console.log("HARNESS PASS");
else console.log(`HARNESS FAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
