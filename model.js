// model.js: the river model for the Sediment Interface.
//
// index.html is the shared interface: the canvas, the sediment particles, the drawn bed, the
// obstacles and their timeline, the 3D view, the sidebar. It knows nothing about how water
// moves. This file is the model that tells it: a real-time 2D depth-averaged flow solver on a
// staggered (MAC) grid for a channel with an inflow on the left and an open outflow on the
// right, with the bed, drawn and deposited, acting on the flow as depth.
//
// It runs in index.html's scope, after it, and registers itself at the bottom of this file
// with registerModel(). See MODEL EXTENSION POINT in index.html for what the interface asks
// of a model. What it shares with the interface: the flow grid (NX, NY, IX, SIZE, cellW,
// cellH), the fields it writes (u, v), the obstacle mask it reads (solid), the bed it reads
// (bedPoints, computeUserBedZ, depoZ, depoGrid, GW, GH, DEPO_CELL), and DT.
//
// Other repos can use this same file unchanged, vendored with index.html. A different
// kind of water (waves, tide) is a different model.js.

// ─────────────────────────────────────────────
// PARAMETERS
// ─────────────────────────────────────────────
const VISC = 0.00005;
// Sediment rules the interface's particle code reads through model.rules.
const MIN_PARTICLE_AGE = 0.8;
const MIN_TRAVEL_X = 100;
const MAX_PARTICLE_AGE = 30;

// Tunable simulation parameters
let inflowVel = 2.5;
let settleThresh = 0.20;
let erosionThresh = 1.0;
let settleProb = 0.012;
// Bed friction (1/s), the slider. A drag on the flow before the pressure solve (macDrag()):
// the river still carries all its water, but shallow and rough ground turn it aside. It also
// slows the water nearest the bed, where the grains travel (nearBed()), so more settles and
// less is lifted.
let friction = 0.0;
// Friction zones: a per-cell coefficient ADDED to the global friction, painted with a brush.
// The water goes around a rough patch, and the grains crossing it slow down, so it gathers
// deposit and resists erosion relative to its surroundings.
let fricGrid = null, fricDampGrid = null, fricDirty = true;
let fricUsed = NaN;   // the global friction fricDampGrid was built with
let fricMode = 0, fricPaint = 1.0, fricRadius = 40;   // 0 = off, 1 = add, 2 = subtract
let fricBuffer = null;

function ensureFricGrid() {
  let n = GW * GH;
  if (!fricGrid || fricGrid.length !== n) {
    fricGrid = new Float32Array(n);
    fricDampGrid = new Float32Array(n);
    fricDirty = true;
  }
  if (!fricBuffer) fricBuffer = createGraphics(width, height);
}

// Bilinear friction at a point (used for display and for anything sampled per particle).
function frictionAt(x, y) {
  if (!fricGrid) return 0;
  let fx = x / DEPO_CELL - 0.5, fy = y / DEPO_CELL - 0.5;
  let i = Math.floor(fx), j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= GW - 1 || j >= GH - 1) return 0;
  let tx = fx - i, ty = fy - j;
  let a = fricGrid[j*GW+i], b = fricGrid[j*GW+i+1];
  let c = fricGrid[(j+1)*GW+i], d = fricGrid[(j+1)*GW+i+1];
  return (a*(1-tx)+b*tx)*(1-ty) + (c*(1-tx)+d*tx)*ty;
}

function paintFriction(x, y, mode) {
  ensureFricGrid();
  let r = Math.max(1, fricRadius / DEPO_CELL), r2 = r*r;
  let ci = x / DEPO_CELL, cj = y / DEPO_CELL;
  let i0 = Math.max(0, Math.floor(ci - r)), i1 = Math.min(GW-1, Math.ceil(ci + r));
  let j0 = Math.max(0, Math.floor(cj - r)), j1 = Math.min(GH-1, Math.ceil(cj + r));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      let dx = i - ci, dy = j - cj, d2 = dx*dx + dy*dy;
      if (d2 > r2) continue;
      let w = 1 - Math.sqrt(d2) / r;         // soft edge
      let k = j * GW + i;
      let target = (mode === 2) ? 0 : fricPaint;   // subtract blends back toward zero
      fricGrid[k] = fricGrid[k] * (1 - w) + target * w;
    }
  }
  fricDirty = true;
  redrawFricBuffer();
}

function redrawFricBuffer() {
  if (!fricBuffer) return;
  fricBuffer.clear();
  if (!fricGrid) return;
  let step = 8;
  fricBuffer.noStroke();
  for (let py = 0; py < height; py += step) {
    for (let px = 0; px < width; px += step) {
      let f = frictionAt(px, py);
      if (f <= 0.01) continue;
      let t = Math.min(1, f / 3);
      fricBuffer.fill(255, 120, 40, 25 + t * 95);
      fricBuffer.rect(px, py, step, step);
    }
  }
}
// Fraction of settleProb used by the on-bed settle chance (see updateParticles). Sized so a
// particle entering at the inflow can cross the reach rather than depositing within a second.
const BED_SETTLE_ON_BED = 0.25;
let erosionProb = 0.02;

// ─────────────────────────────────────────────
// FLUID SOLVER
// ─────────────────────────────────────────────
// Boundary copy for the cell fields the interface reads (u, v): the inflow and outflow
// columns copy their neighbour, the banks mirror v (b = 2) so nothing crosses them.
function setBnd(b, x) {
  for (let j = 1; j <= NY; j++) { x[IX(0, j)] = x[IX(1, j)]; x[IX(NX+1, j)] = x[IX(NX, j)]; }
  for (let i = 1; i <= NX; i++) {
    x[IX(i, 0)] = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
    x[IX(i, NY+1)] = b === 2 ? -x[IX(i, NY)] : x[IX(i, NY)];
  }
  x[IX(0, 0)] = 0.5 * (x[IX(1, 0)] + x[IX(0, 1)]);
  x[IX(0, NY+1)] = 0.5 * (x[IX(1, NY+1)] + x[IX(0, NY)]);
  x[IX(NX+1, 0)] = 0.5 * (x[IX(NX, 0)] + x[IX(NX+1, 1)]);
  x[IX(NX+1, NY+1)] = 0.5 * (x[IX(NX, NY+1)] + x[IX(NX+1, NY)]);
}

// ── The drawn bed in the flow ──
// The solver is depth-averaged: it conserves discharge (div(h u) = 0, h = water depth), so
// flow speeds up over shallows and more of it goes through the deep part of a section.
//
// Depth is relative, 1 = the full water column, from the same mapping the OpenFOAM export
// uses (bridge/case_generator.js: a 2.0 m channel, and 160 px of drawn bed is 0.5 m of
// relief, clamped there). So 640 px of bed would be the surface, and a drawn bed takes away
// at most a quarter of the depth. Accumulated deposit sits on top of the drawn bed at the
// same scale (up to DEPO_MAX, another quarter), so the flow responds as sediment builds up:
// it runs faster over a growing bar, which in turn slows the settling there.
// The depth is refreshed whenever the bed surface is (every 0.5 s of running, and on edits).
// With no bed drawn and nothing deposited depthGrid is null and every depth is 1.
const WATER_DEPTH_PX = 640;
const BED_RELIEF_MAX_PX = 160;
let depthGrid = null, depthDirty = true;
let depthVersion = 0;                      // counts rebuilds, so the solver knows its face depths are stale
const MIN_DEPTH = 0.05;                    // the shallowest water over a submerged object (10 cm)

function rebuildDepthGrid() {
  depthDirty = false;
  depthVersion++;
  let hasDepo = false;
  if (depoGrid) { for (let k = 0; k < depoGrid.length; k++) { if (depoGrid[k] > 0) { hasDepo = true; break; } } }
  if (bedPoints.length < 2 && !hasDepo && !objHasSub) { depthGrid = null; return; }
  if (!depthGrid) depthGrid = new Float32Array(SIZE);
  let qx = cellW / 4, qy = cellH / 4;
  for (let j = 0; j <= NY + 1; j++) {
    let y = Math.min(NY, Math.max(1, j)) * cellH;          // boundary cells copy their neighbour
    for (let i = 0; i <= NX + 1; i++) {
      let x = Math.min(NX, Math.max(1, i)) * cellW;
      let z = Math.min(BED_RELIEF_MAX_PX, Math.max(0, computeUserBedZ(x, y)));
      // Deposit is stored on a finer grid than the flow and is spiky particle by particle.
      // Average it over the flow cell so one grain does not put a step in the depth.
      // A submerged object is bed as high as its top; deposit settles on whichever is higher.
      let c = IX(i, j), sub = objHasSub ? objSub[IX(Math.min(NX, Math.max(1, i)), Math.min(NY, Math.max(1, j)))] * WATER_DEPTH_PX : 0;
      if (sub > z) z = sub;
      if (hasDepo) z += 0.25 * (depoZ(x - qx, y - qy) + depoZ(x + qx, y - qy) + depoZ(x - qx, y + qy) + depoZ(x + qx, y + qy));
      depthGrid[c] = Math.max(MIN_DEPTH, 1 - z / WATER_DEPTH_PX);
    }
  }
}

// Friction: global plus painted zones, precomputed into fricDampGrid (a damping factor per
// bed cell, exp(-f DT)) when either the global value or a zone changes, so the solver's inner
// loop is a lookup rather than an exp() per cell per step. False when there is no friction.
function updateFricDamp() {
  if (!(friction > 0 || fricGrid)) return false;
  ensureFricGrid();
  // Any change of the global value (slider, reset, a restored scene) rebuilds the grid.
  if (friction !== fricUsed) fricDirty = true;
  if (fricDirty) {
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        let f = friction + fricGrid[j * GW + i];
        fricDampGrid[j * GW + i] = f > 0 ? Math.exp(-f * DT) : 1;
      }
    }
    fricDirty = false; fricUsed = friction;
  }
  return true;
}

// ── The staggered (MAC) solver ──
// The normal velocity lives on each face (Harlow and Welch's marker-and-cell grid):
//
//   uF[IX(i, j)]  the face between cells (i, j) and (i+1, j), i = 0..NX. Face 0 is the inflow
//                 edge, face NX the outflow edge.
//   vF[IX(i, j)]  the face between cells (i, j) and (i, j+1), j = 0..NY. Faces 0 and NY are
//                 the banks and stay closed.
//   mac.p         pressure at cell centres.
//
// A face is open only if both of its cells are water and that water is connected to the
// outflow. Closed faces carry nothing. Each step:
//
//   1. inflow on face 0;
//   2. semi-Lagrangian advection of the faces at the particles' speed (MAC_ADV), the
//      backtrace stopping at the first solid cell it meets;
//   3. a small explicit diffusion;
//   4. drag: bed friction (the slider and the painted zones, stronger in shallow water) and
//      the head loss of a narrow opening;
//   5. a pressure solve that drives div(h u) to zero in every cell, h being the face depth
//      from depthGrid (1 with no bed), less what a dammed pond is storing (see below);
//   6. the faces averaged to cell centres into u and v, which is all the interface sees.
//
// The solve is preconditioned conjugate gradients (macSolve()) run to a fixed residual, so the
// answer does not depend, beyond that residual, on where it started. Summed over a column of
// cells, div(h u) = 0 says the discharge through one column of faces equals the discharge
// through the next: conservation along the channel is exact to the solver tolerance, with or
// without obstacles. The collocated solver this replaced (Stam's stable fluids, until
// 2026-11-18) measured divergence across two cells and let water through faces that touch a
// wall; a gap in a wall passed 12-45% of the flow (2026-11-17 stress test, items 5, 20, 21).
// dev/MAC-GRID.md has the comparison.
const MAC_TOL = 1e-3;          // largest |div(h u)| left in any cell, index units (a face at inflow speed carries ~2.5)
const MAC_MAX_ITERS = 400;     // a cap, not the stopping rule; macStats.iters says how many were used
const MAC_MIC_TAU = 0.97, MAC_MIC_SIGMA = 0.25;   // modified incomplete Cholesky, as in Bridson's Fluid Simulation for Computer Graphics
// Advection moves the field as far per step as a particle moves: the interface steps a grain
// by vx * DT * 4 px with vx = u * cellW, so u * 4 * DT cells. (The collocated solver used
// DT * NX, 12.8 cells per unit speed, 40 times as far, which copied a jet far downstream.)
const MAC_ADV = 4 * DT;
// Head loss in a narrow opening. Wall friction and the loss where a flow is squeezed act as a
// drag du/dt = -K_OPEN |u| u / b, b the opening's width across the flow in cells (solid to
// solid, or solid to bank). K_OPEN = 0.25 loses about half the velocity head over each width
// of an opening, an entrance loss of K = 0.5 as in a sharp-edged contraction. In the open
// channel (b = NY) it is a side-wall drag of about 0.2% per step, which the solve gives back.
// (A let, so a check can switch it off and see what it does.)
let K_OPEN = 0.25;
// Object heights. Every object has a top (ob.top, metres above the water surface, set with the
// slider that comes up beside a selected object; obTop() gives OBJECT_TOP_M to objects from
// before 2026-11-18). One with its top under the water is not solid: it is raised bed, which
// the water and the grains pass over (riverObjects(), rebuildDepthGrid()). One standing above
// it is a wall.
//
// Overtopping. In this rigid-lid model water cannot pile up, except behind walls that block
// the whole channel: there the inflow is stored as a pond whose level rises. Sediment settling
// in the pond takes up room too and lifts the water the same way. Once the level passes a
// wall's top (its freeboard, mac.fb, in depth units) the wall spills there, as a broad-crested
// weir, q = WEIR_C * H^1.5 per unit width, H the level above that crest. WEIR_C is the
// textbook 1.705 m^0.5/s, in this model's units (depth 1 = 2 m, speeds in m/s, as the OpenFOAM
// export reads them): 1.705 * 2^1.5 / 2 = 2.41. The wall's cells then carry water H deep, so
// the lowest wall of a blockage spills first.
const WATER_DEPTH_M = 2.0;
const OBJECT_TOP_M = 0.5;          // the default top: half a metre above the water
const WALL_FREEBOARD = OBJECT_TOP_M / WATER_DEPTH_M;   // the default's freeboard, in depth units
const WEIR_C = 2.41;

// Per flow cell, from the active objects: fb, the freeboard of a wall's cell (depth units,
// the tallest object there), and subTop, the top of submerged objects as a fraction of the
// depth above the channel floor (0 where there is none). Rebuilt when the objects change.
let objFb = null, objSub = null, objSig = '', objHasSub = false;
function riverObjects() {
  if (!objFb || objFb.length !== SIZE) { objFb = new Float32Array(SIZE); objSub = new Float32Array(SIZE); objSig = null; }
  const act = obstacles.filter(isObstacleActive);
  const sig = JSON.stringify(act.map(o => [o.type, o.x, o.y, o.w, o.h, o.size, o.rotation, obTop(o), o.points]));
  if (sig === objSig) return false;
  objSig = sig;
  const sub0 = objSub.slice();
  objFb.fill(0); objSub.fill(0); objHasSub = false;
  for (const ob of act) {
    const top = obTop(ob);
    if (top > 0) { const fb = top / WATER_DEPTH_M; obstacleCells(ob, (c) => { if (fb > objFb[c]) objFb[c] = fb; }); }
    else {
      const z = Math.max(0, 1 + top / WATER_DEPTH_M);
      obstacleCells(ob, (c) => { if (z > objSub[c]) objSub[c] = z; });
      objHasSub = true;
    }
  }
  for (let c = 0; c < SIZE; c++) if (objSub[c] !== sub0[c]) { depthDirty = true; break; }
  if (mac) mac.fbVersion = (mac.fbVersion || 0) + 1;
  return true;
}
let mac = null;
let macStats = { iters: 0, residual: 0, active: 0 };

function macAlloc() {
  const f64 = () => new Float64Array(SIZE);
  mac = {
    uF: f64(), vF: f64(), uN: f64(), vN: f64(),
    hU: f64(), hV: f64(), openU: new Uint8Array(SIZE), openV: new Uint8Array(SIZE),
    active: new Uint8Array(SIZE), cells: new Int32Array(NX * NY), nCells: 0,
    Adiag: f64(), Ax: f64(), Ay: f64(), precon: f64(), Lx: f64(), Ly: f64(), colOf: new Int32Array(NX * NY),
    p: f64(), r: f64(), z: f64(), s: f64(), q: f64(),
    dist: new Float32Array(SIZE), bU: new Float32Array(SIZE), bV: new Float32Array(SIZE),
    colD: new Float64Array(NX + 2), colO: new Float64Array(NX + 2), colR: new Float64Array(NX + 2),
    colC: new Float64Array(NX + 2), colX: new Float64Array(NX + 2),
    solidSeen: new Uint8Array(SIZE), depthSeen: -1, built: false,
    uLast: new Float32Array(SIZE), vLast: new Float32Array(SIZE),
    // The pond behind a full blockage (see macPond()).
    pond: new Uint8Array(SIZE), crest: new Uint8Array(SIZE), pondCells: new Int32Array(NX * NY),
    nPond: 0, weirWidth: 0, weirFb: new Float32Array(4 * NX * NY), h0: new Float32Array(SIZE), fbSeen: -1, fbVersion: 0,
    store: 0, level: 0, head: 0, headBuilt: 0, spilling: false, qIn: 0, qSpill: 0,
  };
}

// The freeboard of a wall's cell (the default for a cell no object has claimed yet).
function cellFb(c) { return objFb && objFb[c] > 0 ? objFb[c] : WALL_FREEBOARD; }
function macWet(c) { return !solid[c] || (mac.spilling && mac.crest[c] && mac.level > cellFb(c) + 1e-4); }

// The pond: water reached from the inflow but not connected to the outflow through water,
// and the crest: the solid cells of every obstacle that touches it. Found when the mask
// changes. weirWidth is the number of faces between the pond and its crest (the crest's
// length, in cells), and weirFb the freeboard of the wall on each. The stored volume is kept
// while a pond stays; it goes when the blockage does.
function macPond() {
  const M = mac, W = NX + 2, { pond, crest } = M;
  const reach = new Uint8Array(SIZE), out = new Uint8Array(SIZE), stack = [];
  const fill = (seen, seed) => {
    for (const c of seed) if (!solid[c] && !seen[c]) { seen[c] = 1; stack.push(c); }
    while (stack.length) {
      let c = stack.pop(), i = c % W, j = (c - i) / W;
      if (i > 1 && !solid[c-1] && !seen[c-1]) { seen[c-1] = 1; stack.push(c-1); }
      if (i < NX && !solid[c+1] && !seen[c+1]) { seen[c+1] = 1; stack.push(c+1); }
      if (j > 1 && !solid[c-W] && !seen[c-W]) { seen[c-W] = 1; stack.push(c-W); }
      if (j < NY && !solid[c+W] && !seen[c+W]) { seen[c+W] = 1; stack.push(c+W); }
    }
  };
  const left = [], right = [];
  for (let j = 1; j <= NY; j++) { left.push(IX(1, j)); right.push(IX(NX, j)); }
  fill(reach, left); fill(out, right);
  pond.fill(0); crest.fill(0);
  let n = 0;
  for (let j = 1; j <= NY; j++) for (let i = 1; i <= NX; i++) { let c = IX(i, j); if (reach[c] && !out[c]) { pond[c] = 1; M.pondCells[n++] = c; } }
  const had = M.nPond > 0;
  M.nPond = n; M.weirWidth = 0;
  if (!n) { M.store = 0; M.level = 0; M.head = 0; M.spilling = false; return; }
  // The crest: solid cells joined to the pond, through solid cells.
  for (let k = 0; k < n; k++) {
    let c = M.pondCells[k];
    for (const d of [c-1, c+1, c-W, c+W]) {
      let i = d % W, j = (d - i) / W;
      if (i < 1 || i > NX || j < 1 || j > NY || !solid[d]) continue;
      M.weirFb[M.weirWidth++] = cellFb(d);
      if (!crest[d]) { crest[d] = 1; stack.push(d); }
    }
  }
  while (stack.length) {
    let c = stack.pop(), i = c % W, j = (c - i) / W;
    for (const [d, ok] of [[c-1, i > 1], [c+1, i < NX], [c-W, j > 1], [c+W, j < NY]])
      if (ok && solid[d] && !crest[d]) { crest[d] = 1; stack.push(d); }
  }
  // The bed as it was when the pond formed: sediment settling after that lifts the level.
  if (!had) {
    M.store = 0;
    for (let k = 0; k < n; k++) { let c = M.pondCells[k]; M.h0[c] = depthGrid ? depthGrid[c] : 1; }
  }
}

// The pond's level, from the inflow stored this step and the sediment settled in it, and the
// head over the crest that sets the spill. Run each step while there is a pond.
function macPondStep(qIn) {
  const M = mac, n = M.nPond;
  let sed = 0;
  for (let k = 0; k < n; k++) { let c = M.pondCells[k]; sed += M.h0[c] - (depthGrid ? depthGrid[c] : 1); }
  M.qIn = qIn;
  // Each face of the crest spills by its own wall's height.
  let q = 0;
  for (let f = 0; f < M.weirWidth; f++) { const h = M.level - M.weirFb[f]; if (h > 0) q += Math.pow(h, 1.5); }
  M.qSpill = M.head > 0 ? WEIR_C * q : 0;
  M.store = Math.max(0, M.store + (qIn - M.qSpill) * MAC_ADV);
  M.level = (M.store + Math.max(0, sed)) / n;
  let low = Infinity;
  for (let f = 0; f < M.weirWidth; f++) if (M.weirFb[f] < low) low = M.weirFb[f];
  M.head = Math.max(0, M.level - low);   // over the lowest crest
  if (M.head > 1e-4 && M.weirWidth > 0) {
    if (!M.spilling) { M.spilling = true; M.headBuilt = 0; }
  } else if (M.spilling) { M.spilling = false; M.headBuilt = 0; }
}

// The faces, the connected water, the face depths, the pressure matrix and its
// preconditioner, the distance to the nearest solid cell and the width of the opening at
// each face. Rebuilt when the solid mask or the depth grid changes, and while a dam spills
// whenever the depth over its crest has moved by more than 2%.
function macRebuild() {
  const M = mac, H = depthGrid, W = NX + 2;
  M.depthSeen = depthVersion; M.built = true; M.headBuilt = M.spilling ? M.head : 0; M.fbSeen = M.fbVersion;
  const { openU, openV, hU, hV, active } = M;
  // Over a crest the water stands as deep as the level is above that wall's top.
  const hCell = (c) => (solid[c] ? (M.spilling ? Math.min(1, Math.max(0, M.level - cellFb(c))) : 0) : (H ? H[c] : 1));
  // Face depth: the mean of its two cells, or over a crest the depth on the crest (the
  // control of a weir is the water on its crest, not the pond behind it).
  const hFace = (a, b) => (solid[a] || solid[b]) ? Math.min(hCell(a), hCell(b)) : 0.5 * (hCell(a) + hCell(b));
  openU.fill(0); openV.fill(0); active.fill(0);
  // Water connected to the outflow, found by a flood fill from the last column. Water cut off
  // from it (a pond inside an obstacle, or a dam's pond until it spills) stands still.
  const stack = [];
  for (let j = 1; j <= NY; j++) { let c = IX(NX, j); if (macWet(c)) { active[c] = 1; stack.push(c); } }
  while (stack.length) {
    let c = stack.pop(), i = c % W, j = (c - i) / W;
    if (i > 1 && macWet(c-1) && !active[c-1]) { active[c-1] = 1; stack.push(c-1); }
    if (i < NX && macWet(c+1) && !active[c+1]) { active[c+1] = 1; stack.push(c+1); }
    if (j > 1 && macWet(c-W) && !active[c-W]) { active[c-W] = 1; stack.push(c-W); }
    if (j < NY && macWet(c+W) && !active[c+W]) { active[c+W] = 1; stack.push(c+W); }
  }
  for (let j = 1; j <= NY; j++) {
    for (let i = 0; i <= NX; i++) {
      let c = IX(i, j);
      openU[c] = (i === 0) ? active[c+1] : (i === NX ? active[c] : (active[c] && active[c+1] ? 1 : 0));
      hU[c] = i === 0 ? hCell(c+1) : (i === NX ? hCell(c) : hFace(c, c+1));
    }
  }
  for (let j = 1; j < NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      openV[c] = active[c] && active[c+W] ? 1 : 0;
      hV[c] = hFace(c, c+W);
    }
  }
  // A p = -div: for each cell, the sum over its open faces of h_f (p_c - p_neighbour). The
  // inflow face has its speed given, so it holds no pressure; the outflow face sees p = 0 one
  // half cell out (the ghost is -p_c), so it counts twice.
  const { Adiag, Ax, Ay, precon, cells } = M;
  Adiag.fill(0); Ax.fill(0); Ay.fill(0); precon.fill(0); M.Lx.fill(0); M.Ly.fill(0);
  let n = 0;
  for (let j = 1; j <= NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (!active[c]) continue;
      cells[n++] = c;
      let d = 0;
      if (openU[c-1] && i > 1) d += hU[c-1];
      if (openU[c]) { if (i < NX) { d += hU[c]; Ax[c] = -hU[c]; } else d += 2 * hU[c]; }
      if (openV[c-W]) d += hV[c-W];
      if (openV[c]) { d += hV[c]; Ay[c] = -hV[c]; }
      Adiag[c] = d;
    }
  }
  M.nCells = n;
  for (let k = 0; k < n; k++) {
    let c = cells[k];
    let a = Ax[c-1] * precon[c-1], b = Ay[c-W] * precon[c-W];
    let e = Adiag[c] - a * a - b * b
          - MAC_MIC_TAU * (Ax[c-1] * Ay[c-1] * precon[c-1] * precon[c-1] + Ay[c-W] * Ax[c-W] * precon[c-W] * precon[c-W]);
    if (e < MAC_MIC_SIGMA * Adiag[c]) e = Adiag[c];
    precon[c] = e > 0 ? 1 / Math.sqrt(e) : 0;
  }
  for (let k = 0; k < n; k++) { let c = cells[k]; M.Lx[c] = Ax[c] * precon[c]; M.Ly[c] = Ay[c] * precon[c]; M.colOf[k] = c % W; }
  // The column-sum system, for the preconditioner's coarse correction (see macSolve()):
  // A summed over each column of cells, a tridiagonal matrix with one unknown per column.
  // colD is its diagonal, colO couples column i to column i+1.
  M.colD.fill(0); M.colO.fill(0);
  for (let k = 0; k < n; k++) {
    let c = cells[k], i = c % W;
    M.colD[i] += Adiag[c] + 2 * Ay[c];
    M.colO[i] += Ax[c];
  }
  // Chebyshev distance, in cells, from each cell to the nearest cell that blocks the flow
  // (capped), two chamfer passes. The advection backtrace uses it to take long steps through
  // open water. A spilling crest does not block.
  const D = M.dist, CAP = 1e4;
  for (let c = 0; c < SIZE; c++) D[c] = macWet(c) ? CAP : 0;
  for (let j = 1; j <= NY; j++)
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (!D[c]) continue;
      D[c] = Math.min(D[c], D[c-1] + 1, D[c-W] + 1, D[c-W-1] + 1, D[c-W+1] + 1);
    }
  for (let j = NY; j >= 1; j--)
    for (let i = NX; i >= 1; i--) {
      let c = IX(i, j);
      if (!D[c]) continue;
      D[c] = Math.min(D[c], D[c+1] + 1, D[c+W] + 1, D[c+W+1] + 1, D[c+W-1] + 1);
    }
  // The width of the opening across the flow at each face, in cells: for a u face the run of
  // water down its column (the smaller of its two cells' runs), for a v face the run along
  // its row. The banks bound a run as a solid does.
  const run = M.r;   // free outside macSolve()
  for (let i = 1; i <= NX; i++) {
    let j = 1;
    while (j <= NY) {
      if (!macWet(IX(i, j))) { run[IX(i, j)] = 0; j++; continue; }
      let j1 = j; while (j1 + 1 <= NY && macWet(IX(i, j1 + 1))) j1++;
      for (let q = j; q <= j1; q++) run[IX(i, q)] = j1 - j + 1;
      j = j1 + 1;
    }
  }
  for (let j = 1; j <= NY; j++)
    for (let i = 0; i <= NX; i++) {
      let c = IX(i, j);
      M.bU[c] = i === 0 ? run[c+1] : (i === NX ? run[c] : Math.min(run[c], run[c+1]));
    }
  for (let j = 1; j <= NY; j++) {
    let i = 1;
    while (i <= NX) {
      if (!macWet(IX(i, j))) { run[IX(i, j)] = 0; i++; continue; }
      let i1 = i; while (i1 + 1 <= NX && macWet(IX(i1 + 1, j))) i1++;
      for (let q = i; q <= i1; q++) run[IX(q, j)] = i1 - i + 1;
      i = i1 + 1;
    }
  }
  for (let j = 1; j < NY; j++)
    for (let i = 1; i <= NX; i++) { let c = IX(i, j); M.bV[c] = Math.min(run[c], run[c+W]); }
  M.r.fill(0);
}

// Bilinear samples of the face fields at a point in cell-index coordinates (cell (i, j) has
// its centre at (i, j)). u faces sit at (i + 0.5, j), v faces at (i, j + 0.5).
function macSampleU(F, x, y) {
  let fx = Math.min(NX, Math.max(0, x - 0.5)), fy = Math.min(NY, Math.max(1, y));
  let i0 = Math.min(NX - 1, Math.floor(fx)), j0 = Math.min(NY - 1, Math.floor(fy));
  let sx = fx - i0, sy = fy - j0, c = IX(i0, j0), W = NX + 2;
  return (1-sx)*(1-sy)*F[c] + sx*(1-sy)*F[c+1] + (1-sx)*sy*F[c+W] + sx*sy*F[c+W+1];
}
function macSampleV(F, x, y) {
  let fx = Math.min(NX, Math.max(1, x)), fy = Math.min(NY, Math.max(0, y - 0.5));
  let i0 = Math.min(NX - 1, Math.floor(fx)), j0 = Math.min(NY - 1, Math.floor(fy));
  let sx = fx - i0, sy = fy - j0, c = IX(i0, j0), W = NX + 2;
  return (1-sx)*(1-sy)*F[c] + sx*(1-sy)*F[c+1] + (1-sx)*sy*F[c+W] + sx*sy*F[c+W+1];
}

// Where the water now at (x, y) came from, moving back by (dx, dy). The path is walked in
// steps no longer than the distance to the nearest blocking cell allows, and stops at the
// last point before one, so a backtrace never jumps a wall.
const macTrace = { x: 0, y: 0 };
function macBacktrace(x, y, dx, dy) {
  const D = mac.dist, L = Math.max(Math.abs(dx), Math.abs(dy));
  let t = 0;
  // A non-finite speed would make every step zero long and never finish. It gives a
  // non-finite point instead, which carries through to u and v, where the interface sees it
  // and restarts the flow.
  if (!Number.isFinite(L)) { macTrace.x = NaN; macTrace.y = NaN; return macTrace; }
  while (t < 1 && L > 1e-9) {
    let ci = Math.min(NX, Math.max(1, Math.floor(x + 0.5))), cj = Math.min(NY, Math.max(1, Math.floor(y + 0.5)));
    let d = D[IX(ci, cj)];
    let s = d >= 2 ? d - 1.01 : 0.5;                 // cells this step may cover
    let f = Math.min(1 - t, s / L);
    let nx = x + f * dx, ny = y + f * dy;
    if (nx < 0.5 || nx > NX + 0.5 || ny < 0.5 || ny > NY + 0.5) {
      // Leaving the domain: stop at its edge (the inflow, the outflow or a bank).
      nx = Math.min(NX + 0.5, Math.max(0.5, nx)); ny = Math.min(NY + 0.5, Math.max(0.5, ny));
      let ni = Math.min(NX, Math.max(1, Math.floor(nx + 0.5))), nj = Math.min(NY, Math.max(1, Math.floor(ny + 0.5)));
      if (D[IX(ni, nj)] > 0) { x = nx; y = ny; }
      break;
    }
    let ni = Math.floor(nx + 0.5), nj = Math.floor(ny + 0.5);
    if (D[IX(ni, nj)] === 0) break;
    x = nx; y = ny; t += f;
  }
  macTrace.x = x; macTrace.y = y;
  return macTrace;
}

// Conjugate gradients on A p = b over the connected water, preconditioned with MIC(0),
// started from the last step's pressure, stopped when no cell is left with more than MAC_TOL.
// Because it is run to a residual, carrying the pressure over only saves iterations.
function macSolve(b) {
  const M = mac, { Adiag, Ax, Ay, Lx, Ly, precon, cells, colOf, p, r, z, s, q } = M, n = M.nCells, W = NX + 2;
  const { colD, colO, colR, colC, colX } = M;
  // MIC(0) alone handles short-range error well and the channel-long part badly: the
  // pressure that tells water upstream about an obstacle took 60 of 85 iterations. So the
  // preconditioner also solves the column-sum system exactly (one unknown per column) and
  // adds that correction, uniform down each column (an additive two-level preconditioner;
  // still symmetric, so CG holds). Returns r . z, which CG needs next.
  const applyPrecon = (rr, out) => {
    colR.fill(0);
    for (let k = 0; k < n; k++) colR[colOf[k]] += rr[cells[k]];
    let prevC = 0, prevX = 0;
    for (let i = 1; i <= NX; i++) {
      let lo = colO[i-1], den = colD[i] - lo * prevC;
      if (!(den > 1e-12)) { colC[i] = 0; colX[i] = 0; prevC = 0; prevX = 0; continue; }
      colC[i] = colO[i] / den;
      colX[i] = (colR[i] - lo * prevX) / den;
      prevC = colC[i]; prevX = colX[i];
    }
    for (let i = NX - 1; i >= 1; i--) colX[i] -= colC[i] * colX[i+1];
    for (let k = 0; k < n; k++) {
      let c = cells[k];
      out[c] = (rr[c] - Lx[c-1] * out[c-1] - Ly[c-W] * out[c-W]) * precon[c];
    }
    for (let k = n - 1; k >= 0; k--) {
      let c = cells[k];
      out[c] = (out[c] - Lx[c] * out[c+1] - Ly[c] * out[c+W]) * precon[c];
    }
    let dot = 0;
    for (let k = 0; k < n; k++) { let c = cells[k]; out[c] += colX[colOf[k]]; dot += out[c] * rr[c]; }
    return dot;
  };
  // Inactive cells hold zero in every vector, so the stencils can read them freely.
  z.fill(0); s.fill(0); q.fill(0); r.fill(0);
  for (let c = 0; c < SIZE; c++) if (!M.active[c]) p[c] = 0;
  let rmax = 0, bmax = 0;
  for (let k = 0; k < n; k++) {
    let c = cells[k];
    r[c] = b[c] - (Adiag[c] * p[c] + Ax[c] * p[c+1] + Ax[c-1] * p[c-1] + Ay[c] * p[c+W] + Ay[c-W] * p[c-W]);
    let a = Math.abs(r[c]); if (a > rmax) rmax = a;
    a = Math.abs(b[c]); if (a > bmax) bmax = a;
  }
  // Start from zero when that is the better guess. Always when there is nothing to solve:
  // still water started from the last pressure was left moving at the tolerance, about 1e-3.
  if (bmax <= MAC_TOL || bmax < rmax) {
    for (let k = 0; k < n; k++) { let c = cells[k]; p[c] = 0; r[c] = b[c]; }
    rmax = bmax;
  }
  let it = 0;
  if (rmax > MAC_TOL) {
    let rho = applyPrecon(r, z);
    for (let k = 0; k < n; k++) { let c = cells[k]; s[c] = z[c]; }
    for (it = 1; it <= MAC_MAX_ITERS; it++) {
      let sq = 0;
      for (let k = 0; k < n; k++) {
        let c = cells[k];
        let y = Adiag[c] * s[c] + Ax[c] * s[c+1] + Ax[c-1] * s[c-1] + Ay[c] * s[c+W] + Ay[c-W] * s[c-W];
        q[c] = y; sq += s[c] * y;
      }
      if (!(sq > 0)) break;
      let alpha = rho / sq;
      rmax = 0;
      for (let k = 0; k < n; k++) { let c = cells[k]; p[c] += alpha * s[c]; r[c] -= alpha * q[c]; let a = Math.abs(r[c]); if (a > rmax) rmax = a; }
      if (rmax <= MAC_TOL) break;
      let rhoNew = applyPrecon(r, z);
      let beta = rhoNew / rho; rho = rhoNew;
      for (let k = 0; k < n; k++) { let c = cells[k]; s[c] = z[c] + beta * s[c]; }
    }
  }
  macStats.iters = it; macStats.residual = rmax; macStats.active = n;
}

// Drag before the solve, so it shapes the flow rather than taking water out of it. Bed
// friction is the slider plus the painted zones, f, as a decay exp(-f DT / h) per step:
// bed shear spread over the water column, so shallow water feels it more (h = 1 is the full
// depth, where it is exp(-f DT) as before). With a fixed inflow the discharge stays; what
// friction changes is where the water goes, around a painted patch and away from shallows
// into the deep channel. (Applied after the solve, as before 2026-11-18, it drained a little
// water out of every painted cell each step.) What it does to sediment is in nearBed().
// Then the head loss of a narrow opening (K_OPEN), implicit so it cannot reverse a face.
function macDrag() {
  const M = mac, W = NX + 2, { uF, vF, openU, openV, hU, hV, bU, bV } = M;
  const fric = updateFricDamp();
  for (let j = 1; j <= NY; j++) {
    let gj = Math.min(GH - 1, Math.floor(j * cellH / DEPO_CELL));
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (!openU[c]) continue;
      let x = uF[c];
      if (fric) {
        let gi = Math.min(GW - 1, Math.floor((i + 0.5) * cellW / DEPO_CELL));
        let d = fricDampGrid[gj * GW + gi], h = hU[c];
        if (d !== 1) x *= (h === 1 ? d : Math.pow(d, 1 / Math.max(h, 0.05)));
      }
      uF[c] = x / (1 + K_OPEN * Math.abs(x) * MAC_ADV / Math.max(1, bU[c]));
    }
  }
  for (let j = 1; j < NY; j++) {
    let gj = Math.min(GH - 1, Math.floor((j + 0.5) * cellH / DEPO_CELL));
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (!openV[c]) continue;
      let x = vF[c];
      if (fric) {
        let gi = Math.min(GW - 1, Math.floor(i * cellW / DEPO_CELL));
        let d = fricDampGrid[gj * GW + gi], h = hV[c];
        if (d !== 1) x *= (h === 1 ? d : Math.pow(d, 1 / Math.max(h, 0.05)));
      }
      vF[c] = x / (1 + K_OPEN * Math.abs(x) * MAC_ADV / Math.max(1, bV[c]));
    }
  }
}

function velocityStep() {
  const objChanged = riverObjects();   // a top or a submerged object may have changed the depth
  if (depthDirty) rebuildDepthGrid();
  if (!mac) macAlloc();
  const M = mac, W = NX + 2;
  const { uF, vF, uN, vN } = M;
  // The mask (an object placed, moved, timed in or out) or the depth changed.
  let maskChanged = !M.built;
  if (!maskChanged) for (let c = 0; c < SIZE; c++) if (solid[c] !== M.solidSeen[c]) { maskChanged = true; break; }
  if (maskChanged || objChanged) { M.solidSeen.set(solid); macPond(); }
  // A pond fills with the inflow it holds back.
  if (M.nPond) {
    let qIn = 0;
    for (let j = 1; j <= NY; j++) { let c = IX(1, j); if (M.pond[c]) qIn += inflowVel * (depthGrid ? depthGrid[c] : 1); }
    macPondStep(qIn);
  }
  let rebuilt = maskChanged || M.depthSeen !== depthVersion || M.fbSeen !== M.fbVersion
             || (M.spilling ? Math.abs(M.head - M.headBuilt) > 0.02 * M.head : M.headBuilt !== 0);
  if (rebuilt) macRebuild();
  const { openU, openV, hU, hV } = M;
  // The interface owns u and v. If anything other than this solver wrote them since the last
  // step (R, a restart after a non-finite flow, a check setting a field), the faces are taken
  // from what is there now, each the mean of its two cells.
  let written = false;
  for (let c = 0; c < SIZE; c++) if (u[c] !== M.uLast[c] || v[c] !== M.vLast[c]) { written = true; break; }
  if (written) {
    for (let j = 1; j <= NY; j++) for (let i = 0; i <= NX; i++) { let c = IX(i, j); uF[c] = 0.5 * (u[c] + u[c+1]); }
    for (let j = 0; j <= NY; j++) for (let i = 1; i <= NX; i++) { let c = IX(i, j); vF[c] = 0.5 * (v[c] + v[c+W]); }
  }
  if (rebuilt || written) {
    for (let c = 0; c < SIZE; c++) { if (!openU[c]) uF[c] = 0; if (!openV[c]) vF[c] = 0; }
  }

  // Advection: each open face takes the value found where its water was one step ago.
  for (let j = 1; j <= NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (!openU[c]) { uN[c] = 0; continue; }
      let ip = Math.min(i + 1, NX);
      let vc = 0.25 * (vF[c-W] + vF[c] + vF[IX(ip, j-1)] + vF[IX(ip, j)]);
      let b = macBacktrace(i + 0.5, j, -MAC_ADV * uF[c], -MAC_ADV * vc);
      uN[c] = macSampleU(uF, b.x, b.y);
    }
  }
  for (let j = 1; j < NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (!openV[c]) { vN[c] = 0; continue; }
      let uc = 0.25 * (uF[c-1] + uF[c] + uF[c-1+W] + uF[c+W]);
      let b = macBacktrace(i, j + 0.5, -MAC_ADV * uc, -MAC_ADV * vF[c]);
      vN[c] = macSampleV(vF, b.x, b.y);
    }
  }
  // Inflow: the set speed with a little noise along the edge, on the inflow faces.
  for (let j = 1; j <= NY; j++) {
    let c = IX(0, j);
    uN[c] = openU[c] ? inflowVel + (noise(j * 0.15, simTime * 0.3) - 0.5) * 0.3 : 0;
  }
  // Diffusion, one explicit step (DT * VISC * NX * NY, about 0.06, well inside the explicit
  // limit of 0.25). A closed neighbour stands in the face's own value, so walls are free-slip;
  // their drag is K_OPEN's.
  const a = DT * VISC * NX * NY;
  for (let j = 1; j <= NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (!openU[c]) { uF[c] = 0; continue; }
      let x = uN[c];
      let L = openU[c-1] ? uN[c-1] : x, R = (i < NX && openU[c+1]) ? uN[c+1] : x;
      let B = openU[c-W] ? uN[c-W] : x, T = openU[c+W] ? uN[c+W] : x;
      uF[c] = x + a * (L + R + B + T - 4 * x);
    }
    uF[IX(0, j)] = uN[IX(0, j)];
  }
  for (let j = 1; j < NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (!openV[c]) { vF[c] = 0; continue; }
      let x = vN[c];
      let L = openV[c-1] ? vN[c-1] : x, R = openV[c+1] ? vN[c+1] : x;
      let B = openV[c-W] ? vN[c-W] : x, T = openV[c+W] ? vN[c+W] : x;
      vF[c] = x + a * (L + R + B + T - 4 * x);
    }
  }

  macDrag();

  // Projection: div(h u) of each connected cell, solved away. A spilling pond keeps what it
  // stores (inflow less spill), spread over its cells, so only the spill goes on downstream.
  const b = M.uN;   // free again: reused for the right-hand side
  b.fill(0);
  const sink = (M.spilling && M.nPond) ? (M.qIn - M.qSpill) / M.nPond : 0;
  for (let k = 0; k < M.nCells; k++) {
    let c = M.cells[k];
    b[c] = -(hU[c] * uF[c] - hU[c-1] * uF[c-1] + hV[c] * vF[c] - hV[c-W] * vF[c-W]);
    if (sink && M.pond[c]) b[c] -= sink;
  }
  macSolve(b);
  const P = M.p;
  for (let j = 1; j <= NY; j++) {
    for (let i = 1; i < NX; i++) { let c = IX(i, j); if (openU[c]) uF[c] -= P[c+1] - P[c]; }
    let c = IX(NX, j); if (openU[c]) uF[c] += 2 * P[c];
  }
  for (let j = 1; j < NY; j++)
    for (let i = 1; i <= NX; i++) { let c = IX(i, j); if (openV[c]) vF[c] -= P[c+W] - P[c]; }

  // To the interface: each cell the mean of its two faces in each direction. A spilling crest
  // carries water, so its cells get a speed too (see model.passable).
  for (let j = 1; j <= NY; j++)
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (!macWet(c)) { u[c] = 0; v[c] = 0; continue; }
      u[c] = 0.5 * (uF[c-1] + uF[c]);
      v[c] = 0.5 * (vF[c-W] + vF[c]);
    }
  setBnd(1, u); setBnd(2, v);
  M.uLast.set(u); M.vLast.set(v);
}

// What the slider does to sediment. In a real river a rougher bed, carrying the same
// discharge, runs deeper and slower: by Manning's equation the depth goes as n^0.6 and the
// speed as n^-0.6. This rigid-lid model cannot deepen, so the slowing is given to the rules
// that decide settling and lifting: they compare the speed times (1 + f)^-0.6 with their
// thresholds, f the friction there (the slider plus any painted zone), read as Manning's n
// raised by the factor 1 + f (friction 1 doubles it). The grains still move with the
// depth-mean flow, so the supply coming down the reach stays the same. (Slowing the grains
// themselves was tried: fewer arrived, and the deposit fell as friction rose.)
// Turbulent spreading of the grains. A river mixes across its width at a rate
// eps = E u* h, E about 0.15 in a straight channel and up to 0.6 or more around bends and
// obstacles (Fischer et al. 1979, Mixing in Inland and Coastal Waters), u* the shear velocity,
// about 0.06 of the mean speed. Taken as a constant over the reach, eps = SPREAD_E U h with U
// the inflow speed and h the 2 m depth: a rate that varied with the local speed would need a
// drift term, or the walk would pile grains into slow water by itself. Each frame a grain moves
// U * MAC_ADV cells, so its random step has sigma = sqrt(2 SPREAD_E h U MAC_ADV) cells, h in
// cells. Without it a grain followed its streamline and almost none got into the slow water
// behind an object.
let SPREAD_E = 0.02;
function spread(p) {
  if (!(SPREAD_E > 0) || !(inflowVel > 0)) return 0;
  const hCells = WATER_DEPTH_M / (12.8 / (NX + 2));     // the export's 12.8 m reach over the grid
  return Math.sqrt(2 * SPREAD_E * hCells * inflowVel * MAC_ADV) * cellW;
}

function nearBed(x, y) {
  let f = friction + frictionAt(x, y);
  return f > 0 ? Math.pow(1 + f, -0.6) : 1;
}

// ─────────────────────────────────────────────
// SEDIMENT ENTERING THE REACH
// ─────────────────────────────────────────────
// Sediment comes in with the water, at the inflow edge.
function spawnParticle() {
  let x = random(cellW, cellW * 3), y = random(cellH, height - cellH);
  return { x, y, vx: random(inflowVel*0.5, inflowVel*1.2) * cellW, vy: random(-0.3,0.3)*cellH, born: simTime - random(0, MAX_PARTICLE_AGE) };
}

// A replacement for a particle that left or settled. Over a drawn bed it enters where the
// bed is, so the supply follows the channel that was drawn.
function respawnParticle() {
  let spawnX = random(cellW, cellW*3), spawnY;
  if (bedPoints.length >= 2) {
    let yLo=cellH, yHi=height-cellH, found=false;
    for (let sy=cellH; sy<height-cellH; sy+=4) { if(bedZ(spawnX,sy)>5){if(!found){yLo=sy;found=true;}yHi=sy;} }
    spawnY = found && yHi>yLo ? random(yLo,yHi) : random(cellH,height-cellH);
  } else { spawnY = random(cellH, height-cellH); }
  return { x:spawnX, y:spawnY, vx:random(inflowVel*0.5,inflowVel*1.5)*cellW, vy:random(-0.2,0.2)*cellH, born:simTime - random(0, MAX_PARTICLE_AGE) };
}

// ─────────────────────────────────────────────
// CONTROLS
// ─────────────────────────────────────────────
function riverUpdateToggles() {
  let fricBtn = document.getElementById('toggle-fric');
  fricBtn.className = fricMode ? 'tg-on' : 'tg-off';
  fricBtn.textContent = fricMode === 1 ? 'fric+' : (fricMode === 2 ? 'fric-' : 'fric');
}

registerModel({
  id: 'river',

  // The bed editor's range, and what a bed unit is: 160 units of drawn relief are 0.5 m in a
  // 2.0 m channel, as in the OpenFOAM export (bridge/case_generator.js).
  bed: { zMin: 0, zMax: 160, scale: 0.5 / 160, unit: 'm' },

  // The river's steps in the interface's guide (see THE GUIDE in index.html).
  guide: [
    { id: 'river', after: 'welcome', title: 'The river', text:
      `<p>This model is a stretch of river seen from above. Water comes in at the left edge and leaves at the right, and the top and bottom edges hold it in like banks.</p>
       <p>Use it to ask what a change in the channel does downstream. A bar that forms below a bridge pier, a pool that scours where the flow is pinched, sediment that drops out in the slack water behind a planted island.</p>` },
    { id: 'river-objects', after: 'draw', target: guideCanvas, title: 'What an object does', text:
      `<p>Then watch. Sediment usually piles up in the slow water behind an object and gets scoured away beside it, where the water squeezes past.</p>
       <p>Select an object and a height slider comes up beside it. Put its top under the water and it becomes a sill or a sunken rock, and the river flows over it. Put it above the water and it is a wall.</p>
       <p>A wall across the whole river is a dam. The water backs up behind it until the pond reaches the top of the wall, and then the water spills over the top and carries sediment with it. The lowest part of the wall spills first. Sand settling in the pond raises the pond floor, so the pond fills and spills sooner.</p>` },
    { id: 'river-physics', after: 'thumb', target: guideSection('reset-physics', 'erosion-prob'), title: 'Physics', text:
      `<p>These change how the river behaves. <b>inflow</b> is how fast the water comes in. Faster water carries sediment farther and scours harder. <b>friction</b> is how rough the riverbed is. Rough ground slows the water near the bed, so more settles and less is lifted. The river still carries all of its water, but less of it runs over rough or shallow ground.</p>
       <p><b>settle thresh</b> is the speed below which a grain can settle, and <b>settle prob</b> is how likely it is to settle each moment once it is that slow. <b>erode thresh</b> is the speed above which the water can lift a deposit again, and <b>erode prob</b> is how likely that is. Together they decide where the ground builds and where it wears.</p>
       <p><b>zone μ</b> and <b>brush r</b> belong to the friction brush, which comes after the toggles. <b>reset</b> puts all of these back.</p>` },
    { id: 'river-fric', after: 'toggles', target: '#toggle-fric', title: 'Painting roughness', text:
      `<p><b>fric</b> lets you paint rough ground onto the site, like a reed bed, a planted bank or a stretch of riprap. Click it once for <b>fric+</b> and drag on the site to paint roughness on. Click again for <b>fric-</b> to rub it off, and once more to stop painting.</p>
       <p>Water goes around rough ground, and what does cross it slows near the bed, so sediment settles there and the ground resists scour. In the physics section, <b>zone μ</b> sets how rough the paint is and <b>brush r</b> sets the size of the brush.</p>` },
  ],

  controls: {
    html: `
<div class="sect-label">physics <button class="reset-btn" id="reset-physics">reset</button></div>
<div class="ctrl-row"><label>inflow <span class="val" id="inflow-val">2.5</span></label><input type="range" id="inflow" min="0.5" max="5" value="2.5" step="0.1"></div>
<div class="ctrl-row"><label>friction <span class="val" id="friction-val">0.00</span></label><input type="range" id="friction" min="0" max="3" value="0" step="0.05"></div>
<div class="ctrl-row"><label>zone μ <span class="val" id="fric-paint-val">1.00</span></label><input type="range" id="fric-paint" min="0" max="3" value="1" step="0.05"></div>
<div class="ctrl-row"><label>brush r <span class="val" id="fric-radius-val">40</span></label><input type="range" id="fric-radius" min="10" max="160" value="40" step="5"></div>
<div class="ctrl-row"><label>settle thresh <span class="val" id="settle-thresh-val">0.20</span></label><input type="range" id="settle-thresh" min="0.05" max="0.8" value="0.20" step="0.01"></div>
<div class="ctrl-row"><label>settle prob <span class="val" id="settle-prob-val">0.012</span></label><input type="range" id="settle-prob" min="0.002" max="0.08" value="0.012" step="0.001"></div>
<div class="ctrl-row"><label>erode thresh <span class="val" id="erosion-thresh-val">1.00</span></label><input type="range" id="erosion-thresh" min="0.2" max="3.0" value="1.0" step="0.01"></div>
<div class="ctrl-row"><label>erode prob <span class="val" id="erosion-prob-val">0.02</span></label><input type="range" id="erosion-prob" min="0.005" max="0.1" value="0.02" step="0.005"></div>
`,
    toggles: `<button id="toggle-fric" class="tg-off">fric</button>`,
    wire() {
      document.getElementById('inflow').addEventListener('input', function(){inflowVel=parseFloat(this.value);document.getElementById('inflow-val').textContent=inflowVel.toFixed(1);});
      document.getElementById('settle-thresh').addEventListener('input', function(){settleThresh=parseFloat(this.value);document.getElementById('settle-thresh-val').textContent=settleThresh.toFixed(2);});
      document.getElementById('settle-prob').addEventListener('input', function(){settleProb=parseFloat(this.value);document.getElementById('settle-prob-val').textContent=settleProb.toFixed(3);});
      document.getElementById('erosion-thresh').addEventListener('input', function(){erosionThresh=parseFloat(this.value);document.getElementById('erosion-thresh-val').textContent=erosionThresh.toFixed(2);});
      document.getElementById('erosion-prob').addEventListener('input', function(){erosionProb=parseFloat(this.value);document.getElementById('erosion-prob-val').textContent=erosionProb.toFixed(3);});
      document.getElementById('toggle-fric').addEventListener('click',function(){
        fricMode = (fricMode + 1) % 3;
        if (fricMode) { ensureFricGrid(); redrawFricBuffer(); }
        this.blur();
        riverUpdateToggles();
      });
      document.getElementById('fric-paint').addEventListener('input', function(){fricPaint=parseFloat(this.value);document.getElementById('fric-paint-val').textContent=fricPaint.toFixed(2);});
      document.getElementById('fric-radius').addEventListener('input', function(){fricRadius=parseFloat(this.value);document.getElementById('fric-radius-val').textContent=fricRadius;});
      document.getElementById('friction').addEventListener('input', function(){friction=parseFloat(this.value);document.getElementById('friction-val').textContent=friction.toFixed(2);});
      document.getElementById('reset-physics').addEventListener('click',function(){
        // All of the physics sliders, as the guide says. friction, zone mu and brush r used to
        // be left as they were (2026-11-17 stress test).
        friction=0;fricPaint=1.0;fricRadius=40;fricDirty=true;
        document.getElementById('friction').value=0;document.getElementById('friction-val').textContent='0.00';
        document.getElementById('fric-paint').value=1;document.getElementById('fric-paint-val').textContent='1.00';
        document.getElementById('fric-radius').value=40;document.getElementById('fric-radius-val').textContent='40';
        inflowVel=2.5;settleThresh=0.20;erosionThresh=1.0;settleProb=0.012;erosionProb=0.02;
        document.getElementById('inflow').value=2.5;document.getElementById('inflow-val').textContent='2.5';
        document.getElementById('settle-thresh').value=0.20;document.getElementById('settle-thresh-val').textContent='0.20';
        document.getElementById('settle-prob').value=0.012;document.getElementById('settle-prob-val').textContent='0.012';
        document.getElementById('erosion-thresh').value=1.0;document.getElementById('erosion-thresh-val').textContent='1.00';
        document.getElementById('erosion-prob').value=0.02;document.getElementById('erosion-prob-val').textContent='0.02';
      });
    },
  },

  init() { macAlloc(); },

  step() { velocityStep(); },

  // R, or the interface found the flow non-finite: start the solver from rest.
  restart() {
    if (!mac) return;
    mac.uF.fill(0); mac.vF.fill(0); mac.p.fill(0);
    mac.store = 0; mac.level = 0; mac.head = 0; mac.spilling = false;
  },

  // Flow cells an obstacle holds but water crosses: the crest of a spilling dam. The interface
  // lets grains through them and reads their speed. Null when nothing spills.
  get passable() { return mac && mac.spilling ? mac.crest : null; },

  // Every object has a top, metres above the water, set with the slider beside the selected
  // object. Under the water it is a sill the river flows over; above it, a wall.
  objectHeight: {
    default: OBJECT_TOP_M, min: -1.9, max: 1.5, step: 0.05,
    label: (t) => Math.abs(t) < 0.005 ? 'level with the water' : (t > 0 ? `${t.toFixed(2)} m above the water` : `${(-t).toFixed(2)} m under the water`),
    note: (t) => t > 0 ? 'A wall. Across the whole river it makes a dam.' : 'Under the water. The river and its sand pass over it.',
  },
  isSolid(ob) { return obTop(ob) > 0; },

  // The drawn bed or the deposit changed: the flow depth has to be rebuilt.
  bedChanged() { depthDirty = true; },

  // The canvas changed size. gridResized() is the bed grids being re-derived for it.
  resized() {
    depthDirty = true;
    if (fricBuffer) { let oldF = fricBuffer; fricBuffer = createGraphics(width,height); oldF.remove(); redrawFricBuffer(); }
    fricDirty = true;
  },
  // The painted friction stretches with the scene. (It used to stay at its old pixels, and its
  // picture was cleared and never redrawn, so it acted where it could not be seen.)
  gridResized(ogw, ogh) {
    if (fricGrid && fricGrid.length !== GW * GH) {
      if (ogw && ogh && fricGrid.length === ogw * ogh) { fricGrid = resampleBedGrid(fricGrid, ogw, ogh); fricDampGrid = new Float32Array(GW * GH); }
      else { fricGrid = null; fricDampGrid = null; }
      fricDirty = true;
    }
    redrawFricBuffer();
  },

  // Sediment rules, read by the interface's particle code every frame.
  rules: {
    get settleThresh() { return settleThresh; },
    get settleProb() { return settleProb; },
    get erosionThresh() { return erosionThresh; },
    get erosionProb() { return erosionProb; },
    minTravelX: MIN_TRAVEL_X, minAge: MIN_PARTICLE_AGE, maxAge: MAX_PARTICLE_AGE,
    bedSettleOnBed: BED_SETTLE_ON_BED,
    nearBed,
    spread,
  },
  spawnParticle, respawnParticle,

  // The friction brush takes the pointer while it is on.
  pointer(phase, x, y, event) {
    if (!fricMode) return false;
    if (phase === 'drag' && !(x >= 0 && x <= width && y >= 0 && y <= height)) return false;
    paintFriction(x, y, event && event.shiftKey ? 2 : fricMode);
    return true;
  },
  drawUnderlay() { if (fricBuffer) image(fricBuffer, 0, 0); },
  updateToggles: riverUpdateToggles,

  // What only the model knows about the scene.
  scene(st) { st.inflow = inflowVel; },
});
