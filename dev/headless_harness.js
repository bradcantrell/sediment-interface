// Headless harness for the shared Sediment Interface.
// Takes index.html, extracts the inline script that defines setup(), appends model.js and
// site.js the way the page loads them, mocks p5 + the DOM, then drives the real app and
// asserts on its own state.
//
// This file is shared: every repo that uses the interface runs it unchanged. It checks the
// interface. What is specific to a model or a site lives next to it:
//
//   1. setup() completes            — the bug that once shipped: a TypeError in setup()
//                                     left the page loaded, the canvas drawn, and the
//                                     simulation dead, and node --check could not see it
//   2. the draw loop advances time  — proves the loop body ran, not that a page rendered
//   3. sediment particles move      — transport is actually running
//   4. a transect edits the bed     — the editor edits
//   5. every visible strip is clickable — draw and hit-test share one geometry
//  5b. the bed editor              — bed mode restores the pause state, a click lands where
//                                     it is aimed, the model's elevation range is honoured,
//                                     a cross-section point can be grabbed where it is drawn
//   6. Space unpauses exactly once  — no double-toggle between keyPressed and the window
//   7. the model extension point works — the interface steps the model once per frame,
//                                     mounts its controls, tells it when the bed changes,
//                                     lets its tool take the pointer, asks it for the scene,
//                                     and uses each optional hook (bed layers, default bed,
//                                     non-solid objects, own object kinds, keys, clock,
//                                     bed rendering, readouts, sediment rules, setup hooks)
//   8. the model's own checks       — dev/model_checks.js, if there is one
//   9. the site extension point works — a backend mounts once, runs every frame, gets its
//                                     keys, and sceneState() describes the drawn scene
//  9b. tabs and the saved scene    — one tab per listed model with this page's marked, a
//                                     scene saved on leaving comes back in setup() and
//                                     round-trips (obstacles, clips, bed, controls through
//                                     their own listeners), stretches to another canvas size,
//                                     is filed per tab, and a damaged one is thrown away
//  9c. the guide and the key list  — the guide's steps (the model's and the site's placed
//                                     after the step each names), its ways in and out, that
//                                     it holds keys and clicks, and the key list showing only
//                                     while the run is stopped
//  9d. streaks and resizing        — grains drawn as streaks along their path (dots when the
//                                     toggle is off, the choice saved), and a resize stretching
//                                     the scene so a save after it comes back in place, and a
//                                     model's own view toggles saved with the scene
//  9e. the sidebar scrolls          — the wheel scrolls the sidebar, zooms the canvas, turns
//                                     objects with shift; p5 configured after it loads
//  9f. zoom and pan                 — the wheel zooms 1x-10x about the pointer, clicks land in
//                                     world coordinates, the middle button pans inside the
//                                     scene, the thumbnail shows the zoom, 0 and the bed editor
//                                     reset it
//  10. the site's own checks        — dev/site_checks.js, if there is one
//  11. nothing has gone non-finite
//
// Exits 0 on pass, 1 on any failure, so it can gate a commit.
//
//   node dev/headless_harness.js index.html
//
// The p5/DOM mock block is adapted from the coastal interface's harness.

const fs = require("fs");
const path = require("path");

const HTML = process.argv[2] || "index.html";
const html = fs.readFileSync(HTML, "utf8");

// The page loads model.js and then site.js after its own script. The harness does the same:
// both are appended to the inline script, in that order and in the same scope, so the model
// and the site's backend are loaded and exercised exactly as the page would load them.
const ROOT = path.dirname(path.resolve(HTML));
const sibling = (name) => {
  const want = html.includes('<script src="' + name + '"></script>');
  const file = path.join(ROOT, name);
  if (want && !fs.existsSync(file)) console.log(`note: the page loads ${name} but there is none next to it`);
  return want && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};
const modelSrc = sibling("model.js");
const siteSrc = sibling("site.js");

// ---------------------------------------------------------------- defaults from the markup
const DEFAULTS = {};
// A model's controls are markup inside model.js, so its defaults are read from there too.
for (const m of (html + modelSrc + siteSrc).matchAll(/id="([^"]+)"[^>]*?value="([^"]*)"/g)) DEFAULTS[m[1]] = m[2];
// select elements carry no value=; take the first option
for (const m of html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const opt = m[2].match(/value="([^"]*)"/);
  if (opt && !(m[1] in DEFAULTS)) DEFAULTS[m[1]] = opt[1];
}
const SELECT_IDS = new Set([...(html + modelSrc + siteSrc).matchAll(/<select[^>]*id="([^"]+)"/g)].map(m => m[1]));

// ---------------------------------------------------------------- p5 / DOM mocks
const noop = () => {};
const ctx = () => ({
  remove: noop,                 // p5.Graphics.remove(), called when a buffer is rebuilt
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
    tagName: SELECT_IDS.has(id) ? "SELECT" : (id in DEFAULTS ? "INPUT" : "DIV"),
    type: SELECT_IDS.has(id) ? "select-one" : (id in DEFAULTS ? "range" : ""),
    // Listeners are kept and dispatchEvent() calls them, so a check can move a control the
    // way the page does and see the variable behind it change.
    __listeners: {},
    addEventListener(t, fn) { (this.__listeners[t] = this.__listeners[t] || []).push(fn); },
    dispatchEvent(ev) { for (const fn of (this.__listeners[ev.type] || [])) fn.call(this, ev); return true; },
    removeEventListener: noop, appendChild: noop, removeChild: noop,
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
// A localStorage that stores, so the saved scene can be written and read back.
global.__store = new Map();
global.__pagehide = [];
global.__reloads = 0;
global.window = {
  addEventListener: (t, fn) => { if (t === 'keydown') global.__keydown.push(fn); if (t === 'pagehide') global.__pagehide.push(fn); },
  removeEventListener: noop,
  innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
  location: { href: "http://localhost/", search: "", reload: () => { global.__reloads++; } },
  requestAnimationFrame: noop,
  localStorage: {
    getItem: (k) => (global.__store.has(k) ? global.__store.get(k) : null),
    setItem: (k, v) => { global.__store.set(k, String(v)); },
    removeItem: (k) => { global.__store.delete(k); },
  },
};
global.document = {
  getElementById: el, createElement: () => el("created"),
  addEventListener: noop, removeEventListener: noop,
  body: el("body"), documentElement: el("html"),
  querySelector: () => el("q"),
  // The sidebar's controls are the ids the markup gives a value (and the selects). Only
  // those already on the page: a site's controls exist once its backend has mounted them.
  querySelectorAll: (sel) => (/#sidebar/.test(sel) && /input/.test(sel)
    ? Object.keys(DEFAULTS).filter(id => els.has(id) || SELECT_IDS.has(id)).map(el) : []),
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

// ---------------------------------------------------------------- app bridge
try {
  new Function(src + "\n;" + modelSrc + "\n;" + siteSrc + `
;globalThis.__app = {
  // Evaluate in the app's own scope. Site checks use this to reach whatever their site.js
  // defines, so the harness does not have to list each site's functions.
  run: (code) => eval(code),
  keyPressed: typeof keyPressed==='function'?keyPressed:null,
  setup: typeof setup==='function'?setup:null,
  draw: typeof draw==='function'?draw:null,
  updateParticles: typeof updateParticles==='function'?updateParticles:null,
  velocityStep: typeof velocityStep==='function'?velocityStep:null,
  updateBedBuffer: typeof updateBedBuffer==='function'?updateBedBuffer:null,
  updateBedThumb: typeof updateBedThumb==='function'?updateBedThumb:null,
  rebuildUserBedGrid: typeof rebuildUserBedGrid==='function'?rebuildUserBedGrid:null,
  paintFriction: typeof paintFriction==='function'?paintFriction:null,
  bedZ: typeof bedZ==='function'?bedZ:null,
  userBedZ: typeof userBedZ==='function'?userBedZ:null,
  xsStrip: typeof xsStrip==='function'?xsStrip:null,
  xsStripAt: typeof xsStripAt==='function'?xsStripAt:null,
  getState: () => ({
    particles: typeof particles!=='undefined'?particles:null,
    obstacles: typeof obstacles!=='undefined'?obstacles:null,
    bedPoints: typeof bedPoints!=='undefined'?bedPoints:null,
    U: typeof u!=='undefined'?u:null,
    V: typeof v!=='undefined'?v:null,
    friction: typeof friction!=='undefined'?friction:null,
    fricMode: typeof fricMode!=='undefined'?fricMode:null,
    fricGrid: typeof fricGrid!=='undefined'?fricGrid:null,
    fricDampGrid: typeof fricDampGrid!=='undefined'?fricDampGrid:null,
    settleThresh: typeof settleThresh!=='undefined'?settleThresh:null,
    inflowVel: typeof inflowVel!=='undefined'?inflowVel:null,
    paused: typeof paused!=='undefined'?paused:null,
    simTime: typeof simTime!=='undefined'?simTime:null,
    frameCount: typeof frameCount!=='undefined'?frameCount:null,
    elevMode: typeof elevMode!=='undefined'?elevMode:null,
    thumbBig: typeof thumbBig!=='undefined'?thumbBig:null,
    bedMode: typeof bedMode!=='undefined'?bedMode:null,
    width: typeof width!=='undefined'?width:null,
    height: typeof height!=='undefined'?height:null,
    GW: typeof GW!=='undefined'?GW:null,
    GH: typeof GH!=='undefined'?GH:null,
    NX: typeof NX!=='undefined'?NX:null,
    NY: typeof NY!=='undefined'?NY:null,
    solid: typeof solid!=='undefined'?solid:null,
    P: typeof p!=='undefined'?p:null,
    divArr: typeof divArr!=='undefined'?divArr:null,
    cellW: typeof cellW!=='undefined'?cellW:null,
    cellH: typeof cellH!=='undefined'?cellH:null,
  }),
  setPaused: (x) => { paused = x; },
  setFriction: (x) => { friction = x; },
  setFricMode: (x) => { fricMode = x; },
  setInflow: (x) => { inflowVel = x; },
  setBedPoints: (pts) => { bedPoints = pts; },
  setObstacles: (obs) => { obstacles = obs; },
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

// Count what the interface asks of the model, by wrapping the registered model's hooks
// before setup(). The model still does its work; the wrappers only watch.
globalThis.__model = { step: 0, bedChanged: 0, scene: 0, pointer: 0, take: null, gridsReady: 0, sceneReady: 0, spinUp: 0, stepsAtSpinUp: -1, hud: 0, obstaclesAtSceneReady: -1, gwAtGridsReady: 0 };
app.run(`(function () {
  const w = globalThis.__model;
  if (!model) return;
  const step = model.step; model.step = function () { w.step++; return step.apply(model, arguments); };
  const bc = model.bedChanged; model.bedChanged = function () { w.bedChanged++; if (bc) return bc.apply(model, arguments); };
  const sc = model.scene; model.scene = function () { w.scene++; if (sc) return sc.apply(model, arguments); };
  const pt = model.pointer; model.pointer = function () { w.pointer++; if (w.take !== null) return w.take; return pt ? pt.apply(model, arguments) : false; };
  // Setup-time hooks. Watching one the model does not have is harmless, except spinUp, which
  // replaces the default spin-up when present, so it is only wrapped if the model has it.
  const gr = model.bedGridsReady; model.bedGridsReady = function () { w.gridsReady++; w.gwAtGridsReady = GW; if (gr) return gr.apply(model, arguments); };
  const sr = model.sceneReady; model.sceneReady = function () { w.sceneReady++; w.obstaclesAtSceneReady = obstacles.length; const r = sr ? sr.apply(model, arguments) : undefined;
    w.defaultObstacles = obstacles.map(o => Object.assign({}, o, { clips: (o.clips || []).map(c => Object.assign({}, c)) })); return r; };
  const su = model.spinUp; if (su) model.spinUp = function () { w.spinUp++; return su.apply(model, arguments); };
  const hd = model.hud; model.hud = function () { w.hud++; if (hd) return hd.apply(model, arguments); };
})()`);

// A probe backend, registered before setup() the way a site.js would be. It records what the
// interface calls, so the extension point is tested whatever site.js this page has.
globalThis.__probe = { mounts: 0, slot: null, frames: 0, keyHits: 0 };
app.run(`registerBackend({
  id: '__probe',
  mount(slot) { globalThis.__probe.mounts++; globalThis.__probe.slot = slot; },
  frame() { globalThis.__probe.frames++; },
  keys: { q: () => { globalThis.__probe.keyHits++; }, f: () => { globalThis.__probe.keyHits += 100; } },
  help: 'Q probe',
})`);

// A scene saved before this page loaded, the way a browser would hold one from the last
// visit. Its obstacles are the default three in the default places (so the flow spins up as
// it always has) with a mark on the first, a slider off its default, and the grid on. Section
// 9b checks that setup() put it back, then puts the model's own defaults back.
const SEED = { trailFade: "9" };
{
  const inf = [{ start: 0, dur: "inf" }];
  const before = app.run("saveScene()");
  globalThis.__savedBeforeSetup = before;
  global.__store.set(app.run("savedSceneKey()"), JSON.stringify({
    v: 1, width: W, height: H,
    obstacles: [{ type: "circle", x: W * 0.2, y: H * 0.35, w: 40, h: 40, rotation: 0, clips: inf, mark: "seeded" },
                { type: "rect", x: W * 0.35, y: H * 0.6, w: 40, h: 40, rotation: 30, clips: inf },
                { type: "rect", x: W * 0.55, y: H * 0.4, w: 40, h: 40, rotation: -15, clips: inf }],
    bedPoints: [], bedXSections: [], controls: { "trail-fade": SEED.trailFade }, view: { showGrid: true },
  }));
}

// ---------------------------------------------------------------- 1. setup
try {
  app.setup();
  // What setup() restored, looked at now, before any check moves it. The model's own
  // default scene then goes back, so every check below starts where it always has.
  globalThis.__restored = {
    mark: (S().obstacles[0] || {}).mark, n: S().obstacles.length, dur: ((S().obstacles[0] || {}).clips || [{}])[0].dur,
    trailFade: app.run("trailFade"), showGrid: app.run("showGrid"),
  };
  app.setObstacles(globalThis.__model.defaultObstacles || S().obstacles);
  app.run("solidMaskDirty = true; showGrid = false");
  { const tf = el("trail-fade"); tf.value = DEFAULTS["trail-fade"]; tf.dispatchEvent(new Event("input")); }
  globalThis.__model.stepsAtSpinUp = globalThis.__model.step;
  check(true, "setup() completes without throwing", "clean");
} catch (e) {
  check(false, "setup() completes without throwing", e.message);
  console.log("HARNESS FAIL — setup aborted, nothing else can run");
  process.exit(1);
}

// ---------------------------------------------------------------- 2. the draw loop is alive
// p5 owns frameCount and the mock never advances it, so count the draws here and treat
// advancing simulation time as the evidence that the loop body actually ran.
{
  // The app launches paused by design, so the loop only advances once it is running.
  app.setPaused(false);
  const t0 = S().simTime;
  let drew = 0;
  for (let i = 0; i < 60; i++) { app.draw(); drew++; }
  const t1 = S().simTime;
  check(drew === 60 && t1 > t0, "the draw loop runs", `${drew} draws, simTime ${t0.toFixed(2)} -> ${t1.toFixed(2)} s`);
}

// ---------------------------------------------------------------- 3. sediment is moving
// Which way it should go is the model's business (dev/model_checks.js). Here: it moves.
{
  app.setPaused(false);
  const P = S().particles, before = new Map(P.map(p => [p, [p.x, p.y]]));
  for (let i = 0; i < 60; i++) app.draw();
  let n = 0, d = 0;
  for (const p of S().particles) { const b = before.get(p); if (b) { n++; d += Math.abs(p.x - b[0]) + Math.abs(p.y - b[1]); } }
  check(n > 0 && d / n > 1, "sediment particles move", `${n} tracked, mean displacement ${(n ? d / n : 0).toFixed(1)} px in 60 frames`);
}

// ---------------------------------------------------------------- 4. a drawn transect edits the bed
{
  const w = S().width, h = S().height;
  const pts = [{ x: w * 0.25, z: 40 }, { x: w * 0.5, z: 90 }, { x: w * 0.75, z: 50 }];
  app.setBedPoints(pts);
  app.rebuildUserBedGrid();
  const midX = w * 0.5, midY = h * 0.5;
  const z = app.userBedZ(midX, midY);
  check(z > 0, "a drawn transect raises the bed along the line", `userBedZ(${midX.toFixed(0)},${midY.toFixed(0)}) = ${z.toFixed(1)}`);
  check(isFinite(app.bedZ(midX, midY)), "bedZ is finite over the drawn bed", `${app.bedZ(midX, midY).toFixed(1)}`);
}

// ---------------------------------------------------------------- 5. every visible strip is clickable
// A strip is drawn as rect(sx, 0, w, stripY) — from the top of the canvas down to the
// chart — so the point to test is inside that band, above stripY. Testing below stripY
// would be testing the chart, where nothing is clickable by design.
{
  const bp = S().bedPoints;
  let ok = true, bad = null;
  for (let si = 0; si < bp.length; si++) {
    const g = app.xsStrip(si);
    const cx = g.sx + g.w * 0.5;
    const cy = g.stripY * 0.5;
    const hit = app.xsStripAt(cx, cy);
    if (hit !== si) { ok = false; bad = `station ${si} at (${cx.toFixed(0)},${cy.toFixed(0)}) -> hit ${hit}`; break; }
  }
  check(ok, "every visible profile strip is clickable", bad || `${bp.length} stations agree`);
}

// ---------------------------------------------------------------- 5b. the bed editor
// Driven through mousePressed/mouseDragged, the paths a person uses, with p5's mouse globals
// set by hand.
{
  const st = S(), w = st.width, h = st.height, CH = 160;
  const savedBed = st.bedPoints, savedXS = app.run("bedXSections");
  const at = (x, y) => { globalThis.mouseX = x; globalThis.mouseY = y; };
  const press = (x, y) => { at(x, y); app.run("mousePressed")({}); };
  const drag = (x, y) => { at(x, y); app.run("mouseDragged")({}); };
  const release = () => app.run("mouseReleased()");
  const fresh = () => { app.setBedPoints([]); app.run("bedXSections = []; activeXSection = -1"); };

  // Entering bed mode pauses; leaving restores what it was, whichever way it was.
  app.run("if (bedMode) toggleBedMode()");
  app.setPaused(false); app.run("toggleBedMode()"); const inRun = S().paused; app.run("toggleBedMode()"); const outRun = S().paused;
  app.setPaused(true);  app.run("toggleBedMode()"); app.run("toggleBedMode()"); const outHeld = S().paused;
  check(inRun === true && outRun === false && outHeld === true, "bed mode pauses, and leaving it restores the run as it was",
        `running: paused ${inRun} inside, ${outRun} after; paused before: ${outHeld} after`);

  app.run("toggleBedMode()");                       // stay in bed mode for the editing checks
  fresh();
  press(w * 0.3, h - CH / 2); release();
  const zMid = S().bedPoints.length === 1 ? S().bedPoints[0].z : NaN;
  const rLo = app.run("bedZMin()"), rHi = app.run("bedZMax()");      // this model's range
  check(Math.abs(zMid - (rLo + rHi) / 2) < 0.01, "a click in the transect chart lands at the elevation under the pointer", `half-way up a ${rLo}..${rHi} chart gives z = ${zMid}`);

  // Drag that point far above the chart: it stops at the top of the range.
  press(w * 0.3, h - CH / 2); drag(w * 0.3, h - CH - 300); release();
  const zTop = S().bedPoints[0].z;
  check(zTop === rHi, "a transect point dragged past the chart stops at the top of the range", `z = ${zTop}`);

  // A model can widen the range to both sides of zero (a coast). Same chart, same mapping.
  const m = app.run("model"), savedRange = m.bed;
  m.bed = { zMin: -150, zMax: 170, datumLabel: "still water" };
  fresh();
  press(w * 0.3, h - 10); release();                 // near the bottom of the chart
  press(w * 0.6, h - CH + 10); release();            // near the top
  const lo = S().bedPoints[0].z, hi = S().bedPoints[1].z;
  const yLo = app.run("bedChartYOf")(lo), yHi = app.run("bedChartYOf")(hi);
  check(Math.abs(lo - (-130)) < 0.01 && Math.abs(hi - 150) < 0.01 && Math.abs(yLo - (h - 10)) < 1e-6 && Math.abs(yHi - (h - CH + 10)) < 1e-6,
        "with a signed range the transect goes below zero, and is drawn where it was clicked", `z ${lo.toFixed(1)} and ${hi.toFixed(1)} in -150..170`);
  press(w * 0.3, h - 10); drag(w * 0.3, h + 400); release();
  check(S().bedPoints[0].z === -150, "a transect point dragged below the chart stops at the bottom of the range", `z = ${S().bedPoints[0].z}`);
  app.rebuildUserBedGrid();
  const zLine = app.userBedZ(w * 0.32, h * 0.5);
  check(zLine < -100, "a bed drawn below zero is below zero in the bed itself", `userBedZ just past the low point = ${zLine.toFixed(1)}`);
  let threw = null; try { for (let i = 0; i < 3; i++) app.draw(); } catch (e) { threw = e; }
  check(!threw, "the chart draws with a signed range", threw ? threw.message : "clean");
  m.bed = savedRange;

  // A cross-section point must be grabbable where it is drawn.
  fresh();
  press(w * 0.5, h - 40); release();                 // one station, high on the transect (z = 40)
  const g = app.xsStrip(0), yClick = g.stripY * 0.4, xClick = g.sx + g.w * 0.25;
  press(xClick, yClick); release();                  // add a profile point in its strip
  const xs = app.run("bedXSections")[0];
  const n1 = xs ? xs.points.length : 0;
  press(xClick, yClick);                             // press again on the same spot
  const grabbed = app.run("editingXSStation"), n2 = app.run("bedXSections")[0].points.length;
  release();
  check(n1 === 1 && n2 === 1 && grabbed && grabbed.pointIdx === 0, "a cross-section point can be grabbed where it is drawn",
        `points after first click ${n1}, after pressing on it again ${n2}, grabbed: ${!!grabbed}`);

  app.run("toggleBedMode()");
  app.setBedPoints(savedBed); globalThis.__xs = savedXS; app.run("bedXSections = globalThis.__xs; activeXSection = -1"); app.rebuildUserBedGrid();
  app.setPaused(false);
}

// ---------------------------------------------------------------- 6. Space toggles pause exactly once
{
  app.setPaused(true);
  const before = S().paused;
  const handlers = global.__keydown || [];
  for (const h of handlers) {
    try { h({ key: " ", code: "Space", keyCode: 32, preventDefault() {} }); } catch (e) {}
  }
  const after = S().paused;
  check(handlers.length > 0 && before === true && after === false,
        "Space unpauses exactly once", `${handlers.length} keydown handler(s), ${before} -> ${after}`);
}

// ---------------------------------------------------------------- 7. model extension point
{
  const w = globalThis.__model, m = app.run("model");
  check(!!m && typeof m.id === "string", "a model is registered", m ? `model: ${m.id}` : "none");

  app.setPaused(false);
  const s0 = w.step; for (let i = 0; i < 25; i++) app.draw();
  const running = w.step - s0;
  app.setPaused(true);
  const s1 = w.step; for (let i = 0; i < 10; i++) app.draw();
  check(running === 25 && w.step === s1, "the interface steps the model once per running frame, and not while paused", `${running} steps in 25 frames, ${w.step - s1} while paused`);
  app.setPaused(false);

  const slot = app.run("document.getElementById('model-controls')"), c = m.controls || {};
  check(!c.html || slot.innerHTML === c.html, "the model's controls are mounted in the sidebar", c.html ? `${c.html.length} chars of markup` : "this model has no controls");

  const b0 = w.bedChanged; app.rebuildUserBedGrid();
  check(w.bedChanged === b0 + 1, "the model is told when the bed changes", `${w.bedChanged - b0} call(s) for one bed rebuild`);

  // A model tool (the river's friction brush) can take the pointer. When it does the click
  // must not also place an obstacle; when it does not, the click goes on to the interface.
  const press = () => { globalThis.mouseX = 400; globalThis.mouseY = 300; app.run("mousePressed")({}); };
  const n0 = S().obstacles.length;
  w.take = true; press(); const taken = S().obstacles.length - n0;
  w.take = false; press(); const passed = S().obstacles.length - n0;
  w.take = null;
  check(taken === 0 && passed === 1, "a model tool can take the pointer, and otherwise the click reaches the interface", `obstacles added: ${taken} when taken, ${passed} when not`);
  app.setObstacles(S().obstacles.slice(0, n0)); app.run("solidMaskDirty = true; selectedIdx = -1");

  const k0 = w.scene; app.run("sceneState()");
  check(w.scene === k0 + 1, "sceneState() asks the model for its part", `${w.scene - k0} call(s)`);

  // ---- setup-time hooks
  check(w.gridsReady === 1 && w.gwAtGridsReady > 0, "the model is told once when the bed grids exist", `${w.gridsReady} call(s), GW ${w.gwAtGridsReady} at the time`);
  check(w.sceneReady === 1 && w.obstaclesAtSceneReady === 3, "the model is handed the default scene once, after its obstacles exist", `${w.sceneReady} call(s), ${w.obstaclesAtSceneReady} obstacles at the time`);
  check(m.spinUp ? (w.spinUp === 1) : (w.stepsAtSpinUp === 80),
        "the flow is developed before the first frame, by the model's spin-up if it has one", m.spinUp ? `model spin-up ran ${w.spinUp} time(s)` : `${w.stepsAtSpinUp} default steps`);
  const h0 = w.hud; for (let i = 0; i < 5; i++) app.draw();
  check(w.hud - h0 === 5, "the model's readouts are refreshed every frame", `${w.hud - h0} calls in 5 frames`);
  {
    const el = (id) => app.run(`document.getElementById('${id}')`), c2 = m.controls || {};
    const okStats = !c2.stats || el("model-stats").innerHTML === c2.stats;
    const okHelp = !m.help || el("help-site").innerHTML.includes(m.help);
    const okRender = !m.render || (app.run("slowColor") === m.render.slowColor && app.run("flowOpacity") === m.render.flowOpacity && el("slow-color").value === m.render.slowColor);
    const okTl = !m.timeline || (app.run("timelineDuration") === m.timeline.duration && app.run("DEFAULT_OBJ_DUR") === m.timeline.objectDuration && String(el("timeline-dur").max) === String(m.timeline.max));
    check(okStats && okHelp && okRender && okTl, "what the model declares (stats line, help, render defaults, timeline) is applied at setup",
          `stats ${okStats}, help ${okHelp}, render ${okRender}, timeline ${okTl}` + (!c2.stats && !m.help && !m.render && !m.timeline ? " (this model declares none)" : ""));
  }

  // ---- hooks a model may or may not have: put a known one in, see the interface use it,
  // and put the model's own back.
  const withHook = (owner, name, fn, body) => { const had = Object.prototype.hasOwnProperty.call(owner, name), old = owner[name]; owner[name] = fn; try { return body(); } finally { if (had) owner[name] = old; else delete owner[name]; } };
  const W2 = S().width, H2 = S().height;

  const base = app.bedZ(W2 * 0.5, H2 * 0.5);
  const lifted = withHook(m, "bedTotal", (z) => z + 7, () => app.bedZ(W2 * 0.5, H2 * 0.5));
  const plain = withHook(m, "bedTotal", undefined, () => app.bedZ(W2 * 0.5, H2 * 0.5));
  check(Math.abs(lifted - plain - 7) < 1e-9 && isFinite(base), "a model's bed layers are added to the bed", `bed ${plain.toFixed(2)} -> ${lifted.toFixed(2)} with a layer of 7`);

  {
    const savedBed = S().bedPoints, savedXS = app.run("bedXSections");
    app.setBedPoints([]);
    const d = withHook(m, "defaultBedZ", () => -5, () => [app.userBedZ(W2 * 0.3, H2 * 0.4), app.run("computeUserBedZ")(W2 * 0.3, H2 * 0.4)]);
    const none = withHook(m, "defaultBedZ", undefined, () => app.userBedZ(W2 * 0.3, H2 * 0.4));
    check(d[0] === -5 && d[1] === -5 && none === 0, "with nothing drawn the bed is the model's default, or flat", `default ${d[0]}, without one ${none}`);
    app.setBedPoints(savedBed); globalThis.__xs = savedXS; app.run("bedXSections = globalThis.__xs"); app.rebuildUserBedGrid();
  }

  {
    const saved = S().obstacles, ob = { type: "rect", x: W2 * 0.5, y: H2 * 0.5, w: 120, h: 120, size: 120, rotation: 0, clips: [{ start: 0, dur: Infinity }] };
    const count = () => { app.run("buildSolidMask()"); let n = 0; for (const x of S().solid) n += x; return n; };
    app.setObstacles([ob]);
    const solidN = withHook(m, "isSolid", () => true, count), softN = withHook(m, "isSolid", () => false, count);
    check(solidN > 50 && softN === 0, "an object the model calls not solid is left out of the flow's obstacle mask", `${solidN} cells when solid, ${softN} when not`);

    app.setObstacles([]);
    const made = withHook(m, "makeObstacle", (type, x, y) => type === "__kind" ? { type: "rect", kind: "__kind", x, y, w: 10, h: 10, rotation: 0, clips: [{ start: 0, dur: Infinity }] } : null, () => {
      app.run("addObstacle")(100, 100, "__kind", 0); app.run("addObstacle")(200, 200, "rect", 0);
      return S().obstacles.map(o => (o.kind || "plain") + ":" + o.type + ":" + o.w).join(", ");
    });
    const gs = app.run("ghostSize");
    check(made === `__kind:rect:10, plain:rect:${gs}`, "a model builds objects of its own kind, and the rest are built as usual", made);
    app.setObstacles(saved); app.run("solidMaskDirty = true; selectedIdx = -1");
  }

  {
    let got = 0;
    const flow0 = app.run("showFlow");
    withHook(m, "key", (k) => { if (k === "9") { got++; return true; } return false; }, () => { globalThis.key = "9"; app.keyPressed(); globalThis.key = "f"; app.keyPressed(); });
    check(got === 1 && app.run("showFlow") !== flow0, "a model receives its keys, and the interface keeps its own", `model key hits ${got}`);
    globalThis.key = "f"; app.keyPressed();
  }

  {
    const T = app.run("timelineDuration"), pp = app.run("timelinePingPong");
    app.run("timelinePingPong = false");
    const lt = withHook(m, "clock", () => T * 2.25, () => app.run("timelineLoopTime()"));
    const fd = withHook(m, "formatDuration", (t) => "<" + t + ">", () => app.run("fmtDur")(3));
    globalThis.__pp = pp; app.run("timelinePingPong = globalThis.__pp");
    check(Math.abs(lt - T * 0.25) < 1e-9 && fd === "<3>", "the timeline runs on the model's clock and prints in its units", `loop time ${lt} of ${T}, label ${fd}`);
  }

  {
    let calls = 0, arg = null;
    withHook(m, "renderBed", (g) => { calls++; arg = g; }, () => app.updateBedBuffer());
    check(calls === 1 && arg === app.run("bedSurface"), "a model that draws the bed surface is asked to, with the surface", `${calls} call(s)`);
    app.updateBedBuffer();
  }

  {
    // Sediment's response to the bed can be the model's. Counted over one particle update
    // with a bed drawn, so every branch that asks is reached.
    const R = m.rules, savedBed = S().bedPoints;
    app.setBedPoints([{ x: 0, z: 60 }, { x: W2, z: 60 }]); app.rebuildUserBedGrid();
    const n = { slope: 0, chance: 0, boost: 0 };
    withHook(R, "slope", () => { n.slope++; }, () => withHook(R, "bedSettleChance", () => { n.chance++; return 0; }, () => withHook(R, "settleBoost", () => { n.boost++; return 1; }, () => {
      app.run("for (const p of particles) { p.born = simTime - 5; p.x = Math.max(p.x, 150); }");
      app.updateParticles();
    })));
    const P = S().particles.length;
    check(n.slope >= P * 0.9 && n.chance >= P * 0.9 && n.boost >= P * 0.9, "sediment's response to the bed comes from the model's rules when it has them", `${P} particles: slope ${n.slope}, bed settle ${n.chance}, boost ${n.boost}`);
    app.setBedPoints(savedBed); app.rebuildUserBedGrid();
  }

  {
    // A model can size a grain's deposit (the coast ties it to model time). The grain keeps
    // its amount, so when the water lifts it again the bed loses what it gained.
    const res = withHook(m.rules, "depositAmount", () => 10, () => app.run(`(() => {
      const keep = { depo: depoGrid.slice(), dep: deposited.slice(), parts: particles.slice(), et: erosionThresh, ep: erosionProb };
      const i = Math.floor(GW / 2), j = Math.floor(GH / 2), q = j * GW + i;
      const before = depoGrid[q];
      deposited.length = 0;
      settleParticle({ x: (i + 0.5) * DEPO_CELL, y: (j + 0.5) * DEPO_CELL }, 0);
      const added = depoGrid[q] - before, amt = deposited.length === 1 ? deposited[0].amt : null;
      // Every chance taken: a high bed resists lifting, and that is a dice roll too.
      particles = []; erosionThresh = -1; erosionProb = 1;
      const r0 = globalThis.random; globalThis.random = (a, b) => (a === undefined ? 0 : b === undefined ? 0 : a);
      try { updateParticles(); } finally { globalThis.random = r0; }
      const back = depoGrid[q] - before, lifted = deposited.length === 0;
      depoGrid.set(keep.depo); deposited = keep.dep; particles = keep.parts; erosionThresh = keep.et; erosionProb = keep.ep;
      return { added, amt, back, lifted };
    })()`));
    check(Math.abs(res.added - 5) < 1e-6 && res.amt === 10 && res.lifted && Math.abs(res.back) < 1e-6,
          "a model can size a grain's deposit, and lifting the grain takes back the same amount",
          `deposit 10 -> ${res.added.toFixed(2)} at the centre (half), kept ${res.amt}, after lifting ${res.back.toFixed(3)}`);
  }
}

// ---------------------------------------------------------------- 8. the model's own checks
// Everything about how the water moves belongs to the model, so its checks do too:
// dev/model_checks.js next to the page (for the river: transport direction, friction, the
// bed in the flow, still water).
{
  const modelChecks = path.join(ROOT, "dev", "model_checks.js");
  if (fs.existsSync(modelChecks)) {
    require(modelChecks)({ app, S, check, ROOT });
  } else {
    console.log("  (no dev/model_checks.js for this model)");
  }
}

// ---------------------------------------------------------------- 9. site extension point
{
  const pr = globalThis.__probe;
  check(pr.mounts === 1 && pr.slot && pr.slot.id === "site-slot",
        "a backend is mounted once, into the sidebar slot", `${pr.mounts} mount(s), slot ${pr.slot ? pr.slot.id : "none"}`);

  const f0 = pr.frames;
  for (let i = 0; i < 25; i++) app.draw();
  check(pr.frames - f0 === 25, "a backend's frame() runs once per drawn frame", `${pr.frames - f0} calls in 25 draws`);

  // p5 sets the global \`key\` before calling keyPressed(). A backend gets its own keys, and
  // never a key the interface already uses (F toggles the flow field).
  const flow0 = app.run("showFlow");
  globalThis.key = "Q"; app.keyPressed();
  globalThis.key = "f"; app.keyPressed();
  check(pr.keyHits === 1 && app.run("showFlow") !== flow0,
        "a backend receives its keys, and the interface keeps its own", `probe hits ${pr.keyHits}`);
  globalThis.key = "f"; app.keyPressed();          // put the flow overlay back

  app.setObstacles([{ type: "circle", x: 300, y: 200, w: 50, h: 50, size: 50, rotation: 0, clips: [{ start: 0, dur: Infinity }] },
                    { type: "poly", x: 500, y: 300, rotation: 15, points: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 0, y: 25 }], clips: [{ start: 0, dur: Infinity }] }]);
  const sc = app.run("sceneState()");
  const okScene = sc && sc.obstacles.length === 2 && sc.obstacles[0].points === undefined &&
                  (sc.obstacles[1].points || []).length === 3 &&
                  sc.width === S().width && sc.height === S().height &&
                  sc.bed_profile === S().bedPoints && Array.isArray(sc.bed_xsections);
  check(okScene, "sceneState() describes the drawn scene", sc ? `${sc.obstacles.length} obstacles, ${sc.bed_profile.length} bed points` : "nothing returned");
  app.setObstacles([]);
  app.run("solidMaskDirty = true");
}

// ---------------------------------------------------------------- 9b. tabs and the saved scene
{
  const key = () => app.run("savedSceneKey()");
  const setCtl = (id, v) => { const e = el(id); e.value = String(v); e.dispatchEvent(new Event("input")); };
  const r = globalThis.__restored;

  check(globalThis.__savedBeforeSetup === false, "nothing is saved before setup() has finished", `saveScene() returned ${globalThis.__savedBeforeSetup}`);
  check(r.mark === "seeded" && r.n === 3 && r.dur === Infinity && r.trailFade === 9 && r.showGrid === true,
        "setup() puts back the scene saved on the last visit",
        `first obstacle ${r.mark || "default"}, ${r.n} obstacles, clip ${r.dur}, trail fade ${r.trailFade}, grid ${r.showGrid}`);

  // Leaving the page saves.
  global.__store.clear();
  for (const fn of global.__pagehide) fn();
  const left = global.__store.get(key());
  check(global.__pagehide.length === 1 && !!left && JSON.parse(left).v === 1, "leaving the page saves the scene",
        `${global.__pagehide.length} pagehide listener(s), ${left ? left.length + " bytes" : "nothing"} stored`);

  // Round trip: draw a scene, save it, wreck it, read it back.
  const bed0 = S().bedPoints, xs0 = app.run("bedXSections"), flow0 = app.run("showFlow"), Wc = S().width, Hc = S().height;
  app.setObstacles([{ type: "circle", x: 300, y: 200, w: 50, h: 70, rotation: 0, clips: [{ start: 0, dur: Infinity }] },
                    { type: "poly", x: 500, y: 300, rotation: 15, points: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 0, y: 25 }], clips: [{ start: 4, dur: 12 }, { start: 30 }] },
                    { type: "rect", kind: "__own", x: 700, y: 400, w: 30, h: 20, rotation: 0, clips: [{ start: 0, dur: Infinity }] }]);
  app.setBedPoints([{ x: 100, z: 20 }, { x: 600, z: 55 }, { x: 1000, z: 10 }]);
  globalThis.__xs = [{ x: 600, points: [{ y: 100, z: -5 }, { y: 500, z: 12 }] }]; app.run("bedXSections = globalThis.__xs");
  setCtl("trail-fade", 13); app.run("showFlow = " + !flow0);
  const wrote = app.run("saveScene()");
  const wreck = () => { app.setObstacles([]); app.setBedPoints([]); app.run("bedXSections = []"); setCtl("trail-fade", 3); app.run("showFlow = " + flow0); };
  wreck();
  app.run("applySavedScene(readSavedScene())");
  {
    const o = S().obstacles, b = S().bedPoints, x = app.run("bedXSections");
    const ok = wrote === true && o.length === 3 && o[0].type === "circle" && o[0].x === 300 && o[0].h === 70 && o[0].clips[0].dur === Infinity &&
               o[1].points.length === 3 && o[1].points[2].y === 25 && o[1].clips[0].dur === 12 && o[1].clips[1].dur === undefined && o[2].kind === "__own" &&
               b.length === 3 && b[1].x === 600 && b[1].z === 55 && x.length === 1 && x[0].x === 600 && x[0].points[1].z === 12 &&
               app.run("trailFade") === 13 && el("trail-fade").value === "13" && app.run("showFlow") === !flow0;
    check(ok, "a saved scene comes back as it was: obstacles, clips, bed, a slider through its own listener, a view toggle",
          `${o.length} obstacles, clips ${o[0] ? o[0].clips[0].dur : "-"}/${o[1] ? o[1].clips[0].dur : "-"}, ${b.length} bed points, ${x.length} cross-section, trail fade ${app.run("trailFade")}`);
  }

  // A scene saved in a window twice as wide and half as tall lands on the same cells.
  {
    const sv = JSON.parse(global.__store.get(key())); sv.width = Wc * 2; sv.height = Hc / 2;
    global.__store.set(key(), JSON.stringify(sv));
    wreck(); app.run("applySavedScene(readSavedScene())");
    const o = S().obstacles, b = S().bedPoints, x = app.run("bedXSections");
    const ok = o[0].x === 150 && o[0].y === 400 && o[0].w === 25 && o[0].h === 140 && o[1].points[2].y === 50 &&
               b[1].x === 300 && b[1].z === 55 && x[0].x === b[1].x && x[0].points[1].y === 1000 && x[0].points[1].z === 12;
    check(ok, "a scene saved at another canvas size is stretched to this one, and elevations are left alone",
          o[0] ? `circle at ${o[0].x},${o[0].y} size ${o[0].w}x${o[0].h}; bed point x ${b[1].x} z ${b[1].z}; cross-section still on its station: ${x[0].x === b[1].x}` : "nothing restored");
  }

  // A damaged save is thrown away whole and the scene on screen is not touched.
  {
    const live = S().obstacles, good = JSON.parse(global.__store.get(key()));
    const bads = { "not JSON": "{{{", "unknown version": JSON.stringify(Object.assign({}, good, { v: 99 })),
                   "an obstacle with no position": JSON.stringify(Object.assign({}, good, { obstacles: [{ type: "rect", x: null, y: 5 }] })),
                   "no bed": JSON.stringify(Object.assign({}, good, { bedPoints: "x" })) };
    const res = [];
    for (const name in bads) {
      global.__store.set(key(), bads[name]);
      const got = app.run("readSavedScene()");
      res.push(name + ": " + (got === null && !global.__store.has(key()) ? "discarded" : "KEPT"));
    }
    check(res.every(x => /discarded$/.test(x)) && S().obstacles === live, "a damaged saved scene is thrown away and the scene is left alone", res.join("; "));
  }

  // Tabs: one per listed model, this page's marked, the others links. A scene is filed per tab.
  {
    const tabs = app.run("SITE_TABS"), mid = app.run("model.id"), bar = el("site-tabs");
    app.run("mountTabs()");
    // A site that names its own tab through its backend (the bridge) is on that tab, not on
    // its model's; every listed tab it is not on is then a link.
    const ownTab = app.run("(backends.find(b => b.tab && b.tab.id) || {}).tab || null");
    const listed = tabs.find(t => t.model === mid);
    const mine = ownTab ? { id: ownTab.id } : listed;
    const links = tabs.filter(t => !mine || t.id !== mine.id).every(t => bar.innerHTML.includes(`<a class="tab" data-tab="${t.id}" href="${t.url}">`));
    const cur = !mine || bar.innerHTML.includes(`<span class="tab tab-on" data-tab="${mine.id}">`);
    const ids = new Set(tabs.map(t => t.id)), models = new Set(tabs.map(t => t.model));
    check(tabs.length >= 2 && ids.size === tabs.length && models.size === tabs.length && links && cur && tabs.every(t => /^https:\/\//.test(t.url)),
          "the tab bar lists every model once, marks this page's and links the others",
          `${tabs.map(t => t.id).join(", ")}; this page: ${mine ? mine.id + (ownTab ? " (named by its backend)" : "") : "not listed (model " + mid + ")"}`);

    const k0 = key();
    app.run("saveScene()");
    // The site's own tab, if it has one, steps aside so the probe's tab is the one in force.
    app.run("globalThis.__ownB = backends.find(b => b.tab && b.tab.id) || null; if (globalThis.__ownB) { globalThis.__ownT = globalThis.__ownB.tab; globalThis.__ownB.tab = null; }");
    app.run("registerBackend({ id: '__tab', tab: { id: '__here', label: 'here' } })");
    const k1 = key(), seen = app.run("readSavedScene()");
    const own = bar.innerHTML.includes('<span class="tab tab-on" data-tab="__here">here</span>') &&
                tabs.every(t => bar.innerHTML.includes(`data-tab="${t.id}" href="${t.url}"`));
    app.run("backends.splice(backends.findIndex(b => b.id === '__tab'), 1); if (globalThis.__ownB) globalThis.__ownB.tab = globalThis.__ownT; mountTabs()");
    check(k1 !== k0 && seen === null && own && key() === k0 && app.run("readSavedScene()") !== null,
          "a site names its own tab through its backend, and a scene saved under one tab is not seen under another",
          `keys ${k0} / ${k1}`);
  }

  // The "new" button forgets the scene, reloads, and does not save it straight back.
  {
    app.run("saveScene()");
    const had = global.__store.has(key()), n0 = global.__reloads;
    app.run("resetSavedScene()");
    for (const fn of global.__pagehide) fn();
    check(had && !global.__store.has(key()) && global.__reloads === n0 + 1, "\"new\" forgets the saved scene and reloads the page",
          `stored before ${had}, after ${global.__store.has(key())}, ${global.__reloads - n0} reload(s)`);
    app.run("sceneSaveArmed = true");
  }

  // The scene as a file: what sceneFileText() writes opens again through the same road as
  // a scene left on the last visit; a scene from another tab or a damaged file changes nothing.
  {
    // The file differs from the scene on screen, so a save on the way out would show.
    const live = JSON.parse(app.run("sceneFileText()"));
    live.view.thumbAngleX = (live.view.thumbAngleX || 0) + 7;
    const text = JSON.stringify(live), n0 = global.__reloads;
    global.__store.clear();
    const r = app.run("openSceneText")(text);
    const filed = global.__store.get(key());
    for (const fn of global.__pagehide) fn();        // leaving for the reload must not save over it
    const kept = global.__store.get(key()) === filed;
    const back = app.run("readSavedScene()");
    check(r.ok && !!filed && kept && global.__reloads === n0 + 1 && back && JSON.stringify(back) === JSON.stringify(JSON.parse(text)),
          "a scene file opens as this tab's saved scene and the page loads again",
          `${text.length} bytes, ok ${r.ok}, filed ${!!filed}, kept through pagehide ${kept}, ${global.__reloads - n0} reload(s)`);
    app.run("sceneSaveArmed = true");

    const n1 = global.__reloads, before = global.__store.get(key());
    const other = JSON.stringify(Object.assign(JSON.parse(text), { tab: "__elsewhere" }));
    const bads = { "another tab's scene": other, "not JSON": "PK{{", "an unknown version": JSON.stringify(Object.assign(JSON.parse(text), { v: 99 })) };
    const res = Object.keys(bads).map(name => { const q = app.run("openSceneText")(bads[name]); return name + ": " + (q.ok ? "OPENED" : q.why); });
    check(res.every(x => !/OPENED/.test(x)) && /__elsewhere tab/.test(res[0]) && global.__reloads === n1 && global.__store.get(key()) === before,
          "a scene from another tab, or a file that is not a scene, is refused and nothing changes", res.join("; "));
  }

  // scene.json is found inside a ZIP: stored at the top (as the sites write it) and deflated
  // inside a folder (a case unpacked and zipped again). A ZIP without one gives null.
  {
    const zlib = require("zlib");
    const zip = (entries) => {
      const parts = [], cds = []; let off = 0;
      for (const en of entries) {
        const name = Buffer.from(en.name), raw = Buffer.from(en.text);
        const data = en.deflate ? zlib.deflateRawSync(raw) : raw;
        const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(en.deflate ? 8 : 0, 8);
        lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
        const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(en.deflate ? 8 : 0, 10);
        cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
        parts.push(lh, name, data); cds.push(cd, name); off += 30 + name.length + data.length;
      }
      const cdBuf = Buffer.concat(cds), eo = Buffer.alloc(22);
      eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(entries.length, 8); eo.writeUInt16LE(entries.length, 10);
      eo.writeUInt32LE(cdBuf.length, 12); eo.writeUInt32LE(off, 16);
      return new Uint8Array(Buffer.concat([...parts, cdBuf, eo]));
    };
    const text = app.run("sceneFileText()"), find = app.run("findSceneInZip");
    const a = find(zip([{ name: "params.txt", text: "x = 1\n" }, { name: "scene.json", text }]));
    const b = find(zip([{ name: "case/README.md", text: "hello" }, { name: "case/scene.json", text, deflate: true }]));
    const c = find(zip([{ name: "params.txt", text: "x = 1\n" }, { name: "myscene.json", text }]));
    const okA = !!a && a.method === 0 && Buffer.from(a.data).toString() === text;
    const okB = !!b && b.method === 8 && zlib.inflateRawSync(Buffer.from(b.data)).toString() === text;
    check(okA && okB && c === null && find(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])) === null,
          "scene.json is found inside an exported ZIP, stored or deflated, and nowhere else",
          `stored at the top: ${okA}; deflated in a folder: ${okB}; a ZIP without one: ${c === null ? "null" : "FOUND"}`);
  }

  // Put the scene back the way section 9 left it.
  app.setObstacles([]); app.setBedPoints(bed0); globalThis.__xs = xs0;
  app.run("bedXSections = globalThis.__xs; solidMaskDirty = true; showFlow = " + flow0);
  setCtl("trail-fade", DEFAULTS["trail-fade"]);
  app.rebuildUserBedGrid(); app.updateBedBuffer();
  global.__store.clear();
}

// ---------------------------------------------------------------- 9c. the guide and the key list
{
  // The steps: the interface's own in their order, each complete, ids unique, and every step
  // the model or a backend adds placed after the step it names.
  const steps = app.run("guideSteps()"), ids = steps.map(s => s.id), shared = app.run("GUIDE_STEPS.map(s => s.id)");
  const inOrder = shared.every((id, k) => ids.includes(id) && (k === 0 || ids.indexOf(id) > ids.indexOf(shared[k - 1])));
  const complete = steps.every(s => s.id && s.title && s.text) && new Set(ids).size === ids.length;
  // Directly after the step it names, or after earlier steps added after that same step.
  const added = steps.filter(s => s.from), placed = added.every(s => {
    let k = ids.indexOf(s.id) - 1;
    while (k >= 0 && steps[k].from && steps[k].after === s.after) k--;
    return k >= 0 && steps[k].id === s.after;
  });
  check(inOrder && complete && placed && steps.orphans.length === 0,
        "the guide has the interface's steps in order, each complete, and every added step after the one it names",
        `${steps.length} steps, ${added.length} added (${[...new Set(added.map(s => s.from))].join(", ") || "none"})` +
        (steps.orphans.length ? `, orphans ${steps.orphans.join(", ")}` : ""));

  // Opening runs the model and holds every key and click, and each way out closes it and puts
  // the pause back.
  const el = (id) => app.run(`document.getElementById('${id}')`);
  const n0 = S().obstacles.length, grid0 = app.run("showGrid");
  app.setPaused(true);
  el("guide-btn").dispatchEvent({ type: "click" });
  const opened = app.run("guide.open") === true && S().paused === false;
  globalThis.key = "g"; app.keyPressed();
  globalThis.mouseX = 400; globalThis.mouseY = 300; app.run("mousePressed")({});
  const held = app.run("showGrid") === grid0 && S().obstacles.length === n0;
  app.run("guideKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} })");
  const escClosed = app.run("guide.open") === false && S().paused === true;
  app.run("guideKey({ key: '?', target: { tagName: 'DIV' }, preventDefault() {} })");
  const qOpened = app.run("guide.open") === true;
  el("guide-x").dispatchEvent({ type: "click" });
  const xClosed = app.run("guide.open") === false;
  app.run("guideKey({ key: '?', target: { tagName: 'INPUT' }, preventDefault() {} })");
  const fieldIgnored = app.run("guide.open") === false;
  el("guide-btn").dispatchEvent({ type: "click" }); app.run("guideGo(guide.steps.length - 1)");
  el("guide-next").dispatchEvent({ type: "click" });
  const doneClosed = app.run("guide.open") === false && S().paused === true;
  el("guide-btn").dispatchEvent({ type: "click" }); el("guide-btn").dispatchEvent({ type: "click" });
  const btnToggles = app.run("guide.open") === false;
  check(opened && held && escClosed && qOpened && xClosed && fieldIgnored && doneClosed && btnToggles,
        "the guide opens from its button and ?, runs the model, holds keys and clicks, and closes from ✕, Esc, done and the button",
        `open ${opened}, held ${held}, Esc ${escClosed}, ? ${qOpened}, ✕ ${xClosed}, ? in a field ignored ${fieldIgnored}, done ${doneClosed}, button ${btnToggles}`);

  // The key list: out of the way while the run goes, back when it stops, hidden by H, and
  // shown by the guide on the step about it.
  const op = () => { app.run("updateHUD()"); return el("help").style.opacity; };
  app.run("showHelp = true"); app.setPaused(false); const running = op();
  app.setPaused(true); const stopped = op();
  app.run("showHelp = false"); const hidden = op(); app.run("showHelp = true");
  el("guide-btn").dispatchEvent({ type: "click" }); app.run("guideGo(guide.steps.findIndex(s => s.id === 'keys'))");
  const onStep = op(); app.run("guideClose()"); app.setPaused(true);
  check(running === "0" && stopped === "1" && hidden === "0" && onStep === "1",
        "the key list hides while the run goes, shows when it stops, hides with H, and shows on the guide's step about it",
        `running ${running}, stopped ${stopped}, H ${hidden}, guide step ${onStep}`);
}

// ---------------------------------------------------------------- 9d. streaks and resizing
{
  // Streaks: on by default; each grain is a line from where it was last frame to where it is
  // now, added (lighter), with the buffer faded by erasing. Off: dots, no lines.
  const el = (id) => app.run(`document.getElementById('${id}')`);
  const spy = () => app.run(`(() => { const r = { line: [], ellipse: 0, blend: [], erase: 0 }, b = trailBuffer;
    b.line = (x1, y1, x2, y2) => r.line.push([x1, y1, x2, y2]); b.ellipse = () => { r.ellipse++; };
    b.blendMode = (m) => r.blend.push(m); b.erase = () => { r.erase++; }; return r; })()`);
  app.setPaused(false);
  const onAtStart = app.run("showStreaks") === true;
  app.draw();                                     // every grain now has a last position
  const before = new Map(S().particles.map(p => [p, [p.x, p.y]]));
  // One grain jumps across the canvas, as a model that moves a grain itself might do: that
  // is not a path, and no streak may cross the gap.
  const jumper = S().particles.find(p => p.x < app.run("width") / 2);
  jumper.x += app.run("width") / 2; before.delete(jumper);
  let r = spy(); app.draw();
  const after = S().particles.filter(p => before.has(p));
  const ends = new Set(r.line.map(l => l[2].toFixed(3) + ',' + l[3].toFixed(3)));
  const starts = new Set(r.line.map(l => l[0].toFixed(3) + ',' + l[1].toFixed(3)));
  const matched = after.filter(p => ends.has(p.x.toFixed(3) + ',' + p.y.toFixed(3)) &&
    starts.has(before.get(p)[0].toFixed(3) + ',' + before.get(p)[1].toFixed(3))).length;
  const longest = r.line.reduce((m, l) => Math.max(m, Math.hypot(l[2] - l[0], l[3] - l[1])), 0);
  const streakOk = onAtStart && r.line.length > 0 && matched >= 0.9 * after.length && r.ellipse === 0 &&
    r.blend.includes(app.run("ADD")) && r.erase > 0 && longest <= app.run("STREAK_JUMP");
  el("toggle-streak").dispatchEvent({ type: "click" });
  r = spy(); app.draw();
  const dotsOk = app.run("showStreaks") === false && r.line.length === 0 && r.ellipse > 0;
  const saved = app.run("captureScene()");
  el("toggle-streak").dispatchEvent({ type: "click" });
  app.run("applySavedScene")(saved);
  const kept = app.run("showStreaks") === false;
  app.run("showStreaks = true");
  check(streakOk && dotsOk && kept,
        "grains draw as streaks from where they were to where they are, dots when the toggle is off, and the choice is saved",
        `on at start ${onAtStart}, ${r.line.length === 0 ? '' : ''}streaks ${matched}/${after.length} matched, longest ${longest.toFixed(1)} px, ` +
        `dots when off ${dotsOk}, kept in the scene ${kept}`);

  // Resizing stretches the scene with the canvas, so a save after a resize comes back in the
  // same place on a canvas of the first size. Before, objects stayed put through the resize
  // and the save recorded the new size with the old positions.
  const W0 = app.run("width"), H0 = app.run("height");
  const obs0 = S().obstacles.map(o => Object.assign({}, o)), bed0 = S().bedPoints.map(p => Object.assign({}, p));
  app.setObstacles([{ type: 'rect', x: W0 * 0.5, y: H0 * 0.25, w: 40, h: 30, rotation: 0, clips: [{ start: 0, dur: Infinity }] }]);
  app.setBedPoints([{ x: W0 * 0.2, z: 20 }, { x: W0 * 0.8, z: 40 }]);
  const frac = () => { const o = S().obstacles[0], w = app.run("width"), h = app.run("height");
    return [o.x / w, o.y / h, S().bedPoints[1].x / w]; };
  const f0 = frac();
  app.run("windowResized()");               // the mock's window is the canvas, so this narrows it by the sidebar
  const f1 = frac(), resized = app.run("width") !== W0;
  app.run("saveScene()");
  app.run(`resizeCanvas(${W0}, ${H0})`);
  app.run("applySavedScene")(app.run("readSavedScene()"));
  const f2 = frac();
  const same = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-6);
  check(resized && same(f0, f1) && same(f0, f2),
        "resizing the window stretches the scene with the canvas, and a save after it comes back in the same place",
        `fractions ${f0.map(v => v.toFixed(3)).join("/")} -> resized ${f1.map(v => v.toFixed(3)).join("/")} -> reloaded ${f2.map(v => v.toFixed(3)).join("/")}`);
  app.run(`resizeCanvas(${W0}, ${H0}); cellW = width / (NX + 2); cellH = height / (NY + 2)`);
  app.setObstacles(obs0); app.setBedPoints(bed0); app.run("solidMaskDirty = true");

  // A model's own view toggles (the coast's waves and smooth) go into the scene through
  // viewState() and come back through applyViewState(). A stand-in model state is used here
  // so the check runs on every site, whether or not its model has toggles of its own.
  const hadVS = app.run("model.viewState"), hadAVS = app.run("model.applyViewState");
  app.run("globalThis.__mv = { a: true, b: 3 }; model.viewState = () => Object.assign({}, __mv); model.applyViewState = (v) => { __mv = Object.assign({}, v); }");
  app.run("saveScene()");
  app.run("__mv = { a: false, b: 0 }");
  app.run("applySavedScene")(app.run("readSavedScene()"));
  const mv = app.run("__mv");
  check(mv.a === true && mv.b === 3, "a model's own view toggles are saved with the scene and put back",
        `got ${JSON.stringify(mv)}`);
  app.run("model.viewState = undefined; model.applyViewState = undefined; delete globalThis.__mv");
  if (hadVS) app.run("model").viewState = hadVS;
  if (hadAVS) app.run("model").applyViewState = hadAVS;
  global.__store.clear(); app.setPaused(true);
}

// ---------------------------------------------------------------- 9e. the sidebar scrolls
// The wheel over the sidebar scrolls it; over the canvas it zooms, and with shift it turns the
// object. The handler used to cancel every wheel event on the page, so a sidebar taller than
// the window (the coast's) could not scroll. And p5 is told to skip its friendly errors only
// after it has loaded.
{
  const inSide = { closest: (q) => (q === '#sidebar' ? {} : null), id: 'x' };
  const onCanvas = { closest: () => null, id: 'defaultCanvas0' };
  globalThis.mouseX = 300; globalThis.mouseY = 200;
  const r0 = app.run("ghostRotation");
  const side = app.run("mouseWheel")({ target: inSide, delta: 100, deltaY: 100 });
  const r1 = app.run("ghostRotation"), z1 = app.run("viewZ");
  const canv = app.run("mouseWheel")({ target: onCanvas, delta: 100, deltaY: 100, shiftKey: true });
  const r2 = app.run("ghostRotation"), z2 = app.run("viewZ");
  // Shift + wheel in a browser that makes it a sideways wheel.
  const sideways = app.run("mouseWheel")({ target: onCanvas, delta: 0, deltaY: 0, deltaX: 100, shiftKey: true });
  const r3 = app.run("ghostRotation");
  app.run(`ghostRotation = ${r0}`);
  const p5At = html.indexOf('p5.min.js'), feAt = html.indexOf('p5.disableFriendlyErrors');
  const css = (html.match(/#sidebar\s*\{[^}]*\}/) || [''])[0];
  check(side === true && r1 === r0 && z1 === 1 && canv === false && r2 !== r0 && z2 === 1 && sideways === false && r3 !== r2 &&
        p5At > 0 && feAt > p5At && /overflow-y:\s*auto/.test(css),
        "the wheel scrolls the sidebar, shift + wheel turns the object over the canvas; p5 is configured after it loads",
        `over the sidebar returns ${side} (rotation ${r0} -> ${r1}, zoom ${z1}), shift over the canvas ${canv} (-> ${r2}, zoom ${z2}), sideways shift -> ${r3}; p5 script at ${p5At}, friendly-errors line at ${feAt}`);
}

// ---------------------------------------------------------------- 9f. zoom and pan
// The wheel zooms the view 1x to 10x about the pointer, a click while zoomed lands on the world
// point under it, the middle button pans and the view stays inside the scene, the thumbnail
// shows while zoomed with the zoom written under it, and 0 or the bed editor go back to 1x.
{
  const onCanvas = { closest: () => null, id: 'defaultCanvas0' };
  const W = app.run("width"), H = app.run("height");
  const wheel = (dy, x, y) => { globalThis.mouseX = x; globalThis.mouseY = y; return app.run("mouseWheel")({ target: onCanvas, delta: dy, deltaY: dy }); };
  app.setPaused(true); app.run("resetView()");
  const obs0 = JSON.parse(JSON.stringify(app.run("obstacles"))), sel0 = app.run("selectedIdx"), rot0 = app.run("ghostRotation");
  // One notch in at (300, 200): the world point under the pointer stays under it.
  wheel(-100, 300, 200);
  const z1 = app.run("viewZ"), under1 = [app.run("viewX") + 300 / z1, app.run("viewY") + 200 / z1];
  for (let i = 0; i < 30; i++) wheel(-100, 300, 200);
  const zMax = app.run("viewZ"), under2 = [app.run("viewX") + 300 / zMax, app.run("viewY") + 200 / zMax];
  const anchored = Math.abs(under1[0] - 300) < 1e-6 && Math.abs(under1[1] - 200) < 1e-6 && Math.abs(under2[0] - 300) < 1e-6 && Math.abs(under2[1] - 200) < 1e-6;
  // A click at screen (100, 100) places a circle at the world point under it.
  app.run("obstacles.length = 0; selectedIdx = -1; ghostType = 'circle'; polyPoints = []");
  globalThis.mouseX = 100; globalThis.mouseY = 100;
  const vx = app.run("viewX"), vy = app.run("viewY");
  app.run("mousePressed")({ button: 0 }); app.run("mouseReleased")();
  const placed = app.run("obstacles")[0];
  const clickOk = !!placed && Math.abs(placed.x - (vx + 100 / zMax)) < 1e-6 && Math.abs(placed.y - (vy + 100 / zMax)) < 1e-6;
  // The middle button does not place anything (pressed over empty water, not the new circle).
  globalThis.mouseX = 600; globalThis.mouseY = 500;
  app.run("mousePressed")({ button: 1 }); app.run("mouseReleased")();
  const midNone = app.run("obstacles.length") === 1;
  // A click 4 screen pixels outside the circle's edge still picks it (the grab margin is in
  // screen pixels), 12 outside does not.
  const r = placed.w / 2;
  app.run("selectedIdx = -1");
  globalThis.mouseX = 100 + (r * zMax + 4); globalThis.mouseY = 100; app.run("updatePointer()");
  const near = app.run("hitTestObstacle(wmX, wmY)");
  globalThis.mouseX = 100 + (r * zMax + 12); app.run("updatePointer()");
  const far = app.run("hitTestObstacle(wmX, wmY)");
  // Pan: a 100 px middle-drag moves the view 10 world px; a huge one stops at the edge.
  app.run("panStart(500, 500); panMove(400, 450)");
  const pvx = app.run("viewX"), pvy = app.run("viewY");
  const panOk = Math.abs(pvx - (vx + 100 / zMax)) < 1e-6 && Math.abs(pvy - (vy + 50 / zMax)) < 1e-6;
  app.run("panMove(-1e6, -1e6); panEnd()");
  const edge = Math.abs(app.run("viewX") - (W - W / zMax)) < 1e-6 && Math.abs(app.run("viewY") - (H - H / zMax)) < 1e-6;
  app.run("panStart(0, 0); panMove(1e6, 1e6); panEnd()");
  const edge0 = app.run("viewX") === 0 && app.run("viewY") === 0;
  // The thumbnail and the zoom written under it.
  app.run("drawZoomMap()");
  const el = (id) => app.run(`document.getElementById('${id}')`);
  const mapOn = el('zoom-box').style.display === 'block' && /zoom 10\.0\u00d7/.test(el('zoom-text').textContent);
  // Zooming out all the way returns to 1x with no offset; 0 resets; the bed editor resets and
  // its wheel does not zoom.
  for (let i = 0; i < 40; i++) wheel(100, 300, 200);
  const out = app.run("viewZ") === 1 && app.run("viewX") === 0 && app.run("viewY") === 0;
  app.run("drawZoomMap()");
  const mapOff = el('zoom-box').style.display === 'none';
  wheel(-300, 300, 200); globalThis.key = "0"; app.keyPressed();
  const key0 = app.run("viewZ") === 1;
  wheel(-300, 300, 200); app.run("toggleBedMode()");
  const bedReset = app.run("viewZ") === 1; wheel(-300, 300, 200);
  const bedNoZoom = app.run("viewZ") === 1; app.run("toggleBedMode()");
  const markup = /id="zoom-box"/.test(html) && /id="zoom-map"/.test(html) && /id="zoom-text"/.test(html);
  // Put the scene back.
  app.run("resetView(); drawZoomMap()");
  app.setObstacles(obs0); app.run(`selectedIdx = ${sel0}; ghostRotation = ${rot0}; solidMaskDirty = true`);
  check(Math.abs(z1 - Math.exp(100 * app.run("ZOOM_PER_WHEEL"))) < 1e-9 && zMax === 10 && anchored && clickOk && midNone &&
        near === 0 && far === -1 && panOk && edge && edge0 && mapOn && out && mapOff && key0 && bedReset && bedNoZoom && markup,
        "the wheel zooms 1x-10x about the pointer, clicks land where they point, the middle button pans inside the scene, the thumbnail shows the zoom",
        `one notch ${z1.toFixed(3)}x, max ${zMax}x, pointer anchored ${anchored}; click placed ${clickOk}, middle places nothing ${midNone}; ` +
        `grab 4 px out ${near}, 12 px out ${far}; pan ${panOk}, stops at the edges ${edge}/${edge0}; thumbnail ${mapOn}/${mapOff}; ` +
        `out to 1x ${out}; 0 resets ${key0}; bed editor resets ${bedReset}, no zoom in it ${bedNoZoom}; markup ${markup}`);
}

// ---------------------------------------------------------------- 10. the site's own checks
{
  const siteChecks = path.join(ROOT, "dev", "site_checks.js");
  if (fs.existsSync(siteChecks)) {
    require(siteChecks)({ app, S, check, ROOT, HTML: path.resolve(HTML), html, siteSrc });
  } else {
    console.log("  (no dev/site_checks.js for this site)");
  }
}

// ---------------------------------------------------------------- 11. nothing has gone non-finite
{
  for (let i = 0; i < 30; i++) app.draw();
  const P = S().particles;
  const bad = P.filter(p => !isFinite(p.x) || !isFinite(p.y)).length;
  const badU = S().U.reduce((n, x) => n + (isFinite(x) ? 0 : 1), 0);
  check(bad === 0 && badU === 0, "particle and velocity state stay finite", `${P.length} particles, ${bad} bad, ${badU} bad velocities`);
}

console.log("");
if (failures === 0) console.log("HARNESS PASS");
else console.log(`HARNESS FAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
