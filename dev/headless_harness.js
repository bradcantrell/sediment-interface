// Headless harness for the fluvial Sediment Interface.
// Takes index.html, extracts the inline script that defines setup(), mocks p5 + the DOM,
// then drives the real app and asserts on its own state:
//
//   1. setup() completes            — the bug that once shipped: a TypeError in setup()
//                                     left the page loaded, the canvas drawn, and the
//                                     simulation dead, and node --check could not see it
//   2. the draw loop advances time  — proves the loop body ran, not that a page rendered
//   3. particles travel downstream  — transport is actually running
//   4. friction slows the field     — the slider reaches the physics
//   5. a transect edits the bed     — the editor edits
//   6. every visible strip is clickable — draw and hit-test share one geometry
//   7. Space unpauses exactly once  — no double-toggle between keyPressed and the window
//   8. the friction brush is three-state — fric+ adds, fric- takes back toward zero
//   9. nothing has gone non-finite
//
// Exits 0 on pass, 1 on any failure, so it can gate a commit.
//
//   node dev/headless_harness.js index.html
//
// Verified to have teeth: with paintFriction turned into a silent no-op the harness fails
// checks 8a and 8b and exits 1, while node --check still passes.
//
// The p5/DOM mock block is adapted from the coastal interface's harness
// (D:/workspace/coastal_headless_v2.js); the checks below are specific to this app.

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

// ---------------------------------------------------------------- fluvial app bridge
try {
  new Function(src + `
;globalThis.__app = {
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
  }),
  setPaused: (x) => { paused = x; },
  setFriction: (x) => { friction = x; },
  setFricMode: (x) => { fricMode = x; },
  setInflow: (x) => { inflowVel = x; },
  setBedPoints: (pts) => { bedPoints = pts; },
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

// ---------------------------------------------------------------- 3. transport is running
{
  app.setPaused(false);
  const P = S().particles;
  const before = P.length ? P.reduce((s, p) => s + p.x, 0) / P.length : 0;
  for (let i = 0; i < 60; i++) app.draw();
  const after = P.length ? P.reduce((s, p) => s + p.x, 0) / P.length : 0;
  check(P.length > 0 && after > before, "particles travel downstream (+x)", `mean x ${before.toFixed(1)} -> ${after.toFixed(1)}`);
}

// ---------------------------------------------------------------- 4. friction reaches the physics
{
  const meanSpeed = () => {
    const U = S().U, V = S().V;
    let s = 0, n = 0;
    for (let i = 0; i < U.length; i++) {
      const m = Math.abs(U[i]) + Math.abs(V[i]);
      if (isFinite(m)) { s += m; n++; }
    }
    return n ? s / n : 0;
  };
  app.setFriction(0);
  for (let i = 0; i < 30; i++) app.velocityStep();
  const fast = meanSpeed();
  app.setFriction(2.5);
  for (let i = 0; i < 30; i++) app.velocityStep();
  const slow = meanSpeed();
  check(slow < fast, "friction slows the solved field", `mean |u|+|v| ${fast.toFixed(4)} -> ${slow.toFixed(4)}`);
  app.setFriction(0);
}

// ---------------------------------------------------------------- 5. a drawn transect edits the bed
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

// ---------------------------------------------------------------- 6. every visible strip is clickable
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

// ---------------------------------------------------------------- 7. Space toggles pause exactly once
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

// ---------------------------------------------------------------- 8. the friction brush is three-state
// fricGrid holds the painted zone values (0 by default). fricDampGrid is a derived damping
// factor rebuilt only when fricDirty, so it is the wrong array to sum.
{
  const grid = S().fricGrid;
  if (!grid) {
    check(false, "friction brush writes to its paint grid", "fricGrid missing");
  } else {
    const w = S().width, h = S().height;
    app.setFricMode(1);
    const sumBefore = grid.reduce((s, x) => s + x, 0);
    app.paintFriction(w * 0.5, h * 0.5, 1);
    const sumAdded = grid.reduce((s, x) => s + x, 0);
    app.paintFriction(w * 0.5, h * 0.5, 2);
    const sumSub = grid.reduce((s, x) => s + x, 0);
    check(sumAdded > sumBefore, "fric+ adds friction where it is painted", `${sumBefore.toFixed(2)} -> ${sumAdded.toFixed(2)}`);
    check(sumSub < sumAdded, "fric- takes friction back toward zero", `${sumAdded.toFixed(2)} -> ${sumSub.toFixed(2)}`);
    app.setFricMode(0);
  }
}

// ---------------------------------------------------------------- 9. nothing has gone non-finite
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
