// model.js: the river model for the Sediment Interface.
//
// index.html is the shared interface: the canvas, the sediment particles, the drawn bed, the
// obstacles and their timeline, the 3D view, the sidebar. It knows nothing about how water
// moves. This file is the model that tells it: a real-time 2D flow solver (Jos Stam's stable
// fluids, adapted) for a channel with an inflow on the left and an open outflow on the right,
// with the bed, drawn and deposited, acting on the flow as depth.
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
const GAUSS_SEIDEL_ITERS = 30;
// Sediment rules the interface's particle code reads through model.rules.
const MIN_PARTICLE_AGE = 0.8;
const MIN_TRAVEL_X = 100;
const MAX_PARTICLE_AGE = 30;

// Tunable simulation parameters
let inflowVel = 2.5;
let settleThresh = 0.20;
let erosionThresh = 1.0;
let settleProb = 0.012;
// Bed friction (1/s). A uniform drag on the solved field: it slows the flow, which raises
// deposition and lowers erosion through the existing thresholds. At 0 the field is frictionless
// and the only deposition path is speed < settleThresh, which the field almost never meets.
let friction = 0.0;
// Friction zones: a per-cell coefficient ADDED to the global friction, painted with a brush.
// It damps the solved field locally, so a rough patch slows flow, drops deposition and resists
// erosion relative to its surroundings.
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

// Solver work arrays (the fields themselves, u and v, belong to the interface).
let uPrev, vPrev;
let p, divArr;

// ─────────────────────────────────────────────
// FLUID SOLVER (Jos Stam, adapted)
// ─────────────────────────────────────────────
function addSource(x, s) {
  for (let j = 1; j <= NY; j++)
    for (let i = 1; i <= NX; i++) {
      let idx = IX(i, j);
      if (solid[idx]) continue;
      x[idx] += DT * s[idx];
    }
}

function setBnd(b, x) {
  for (let j = 1; j <= NY; j++) { x[IX(0, j)] = x[IX(1, j)]; } // open inflow boundary (copy), not wall mirror
  for (let j = 1; j <= NY; j++) { x[IX(NX+1, j)] = x[IX(NX, j)]; }
  for (let i = 1; i <= NX; i++) {
    x[IX(i, 0)] = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
    x[IX(i, NY+1)] = b === 2 ? -x[IX(i, NY)] : x[IX(i, NY)];
  }
  x[IX(0, 0)] = 0.5 * (x[IX(1, 0)] + x[IX(0, 1)]);
  x[IX(0, NY+1)] = 0.5 * (x[IX(1, NY+1)] + x[IX(0, NY)]);
  x[IX(NX+1, 0)] = 0.5 * (x[IX(NX, 0)] + x[IX(NX+1, 1)]);
  x[IX(NX+1, NY+1)] = 0.5 * (x[IX(NX, NY+1)] + x[IX(NX+1, NY)]);
}

function linSolve(b, x, x0, a, c) {
  for (let iter = 0; iter < GAUSS_SEIDEL_ITERS; iter++) {
    for (let j = 1; j <= NY; j++) {
      for (let i = 1; i <= NX; i++) {
        let idx = IX(i, j);
        if (solid[idx]) continue;
        let left = solid[IX(i-1, j)] ? x[idx] : x[IX(i-1, j)];
        let right = solid[IX(i+1, j)] ? x[idx] : x[IX(i+1, j)];
        let bottom = solid[IX(i, j-1)] ? x[idx] : x[IX(i, j-1)];
        let top = solid[IX(i, j+1)] ? x[idx] : x[IX(i, j+1)];
        x[idx] = (x0[idx] + a * (left + right + bottom + top)) / c;
      }
    }
    setBnd(b, x);
  }
}

function diffuse(b, x, x0, diff) { let a = DT * diff * NX * NY; linSolve(b, x, x0, a, 1 + 4 * a); }

function advect(b, d, d0, uVec, vVec) {
  let dt0 = DT * NX;
  for (let j = 1; j <= NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let idx = IX(i, j);
      if (solid[idx]) { d[idx] = 0; continue; }
      let x = i - dt0 * uVec[idx], y = j - dt0 * vVec[idx];
      x = constrain(x, 0.5, NX + 0.5); y = constrain(y, 0.5, NY + 0.5);
      let i0 = floor(x), i1 = i0 + 1, j0 = floor(y), j1 = j0 + 1;
      if (solid[IX(i0, j0)] || solid[IX(i1, j0)] || solid[IX(i0, j1)] || solid[IX(i1, j1)]) { d[idx] = d0[idx]; continue; }
      let sx = x - i0, sy = y - j0;
      d[idx] = (1-sx)*(1-sy)*d0[IX(i0,j0)] + sx*(1-sy)*d0[IX(i1,j0)] + (1-sx)*sy*d0[IX(i0,j1)] + sx*sy*d0[IX(i1,j1)];
    }
  }
  setBnd(b, d);
}

function project(uVec, vVec, pArr, divArr) {
  for (let j = 1; j <= NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let idx = IX(i, j);
      if (solid[idx]) { divArr[idx] = 0; pArr[idx] = 0; continue; }
      let uR = solid[IX(i+1, j)] ? 0 : uVec[IX(i+1, j)], uL = solid[IX(i-1, j)] ? 0 : uVec[IX(i-1, j)];
      let vT = solid[IX(i, j+1)] ? 0 : vVec[IX(i, j+1)], vB = solid[IX(i, j-1)] ? 0 : vVec[IX(i, j-1)];
      divArr[idx] = -0.5 * (uR - uL + vT - vB); pArr[idx] = 0;
    }
  }
  setBnd(0, divArr); setBnd(0, pArr);
  linSolve(0, pArr, divArr, 1, 4);
  for (let j = 1; j <= NY; j++)
    for (let i = 1; i <= NX; i++) {
      let idx = IX(i, j);
      if (solid[idx]) continue;
      // A wall holds no pressure gradient, so a solid neighbour stands in this cell's own
      // pressure, as the solve above does (linSolve) and as projectDepth() does. Reading the
      // solid cell's stored zero instead kicked the flow beside obstacles until it blew up.
      let R = IX(i+1, j), L = IX(i-1, j), T = IX(i, j+1), B = IX(i, j-1), pc = pArr[idx];
      uVec[idx] -= 0.5 * ((solid[R] ? pc : pArr[R]) - (solid[L] ? pc : pArr[L]));
      vVec[idx] -= 0.5 * ((solid[T] ? pc : pArr[T]) - (solid[B] ? pc : pArr[B]));
    }
  setBnd(1, uVec); setBnd(2, vVec);
}

// ── The drawn bed in the flow ──
// The solver is depth-averaged: with a bed drawn, the projection conserves discharge
// (div(h u) = 0, h = water depth) instead of plan-view velocity (div(u) = 0). Flow speeds
// up over shallows and more of it goes through the deep part of a section.
//
// Depth is relative, 1 = the full water column, from the same mapping the OpenFOAM export
// uses (bridge/case_generator.js: a 2.0 m channel, and 160 px of drawn bed is 0.5 m of
// relief, clamped there). So 640 px of bed would be the surface, and a drawn bed takes away
// at most a quarter of the depth. Accumulated deposit sits on top of the drawn bed at the
// same scale (up to DEPO_MAX, another quarter), so the flow responds as sediment builds up:
// it runs faster over a growing bar, which in turn slows the settling there.
// The depth is refreshed whenever the bed surface is (every 0.5 s of running, and on edits).
// With no bed drawn and nothing deposited depthGrid is null and the solver runs the plain
// projection, unchanged.
const WATER_DEPTH_PX = 640;
const BED_RELIEF_MAX_PX = 160;
const DEPTH_SOR = 1.7;                     // over-relaxation for the depth-weighted pressure solve
let depthGrid = null, depthDirty = true;
let secA = null, secD = null, secP = null, secC = null;   // per-column work arrays for sectionPressure()

let depthVersion = 0;                      // counts rebuilds, so the MAC solver knows its face depths are stale

function rebuildDepthGrid() {
  depthDirty = false;
  depthVersion++;
  let hasDepo = false;
  if (depoGrid) { for (let k = 0; k < depoGrid.length; k++) { if (depoGrid[k] > 0) { hasDepo = true; break; } } }
  if (bedPoints.length < 2 && !hasDepo) { depthGrid = null; return; }
  if (!depthGrid) { depthGrid = new Float32Array(SIZE); secA = new Float64Array(NX + 2); secD = new Float64Array(NX + 2); secP = new Float64Array(NX + 2); secC = new Float64Array(NX + 2); }
  let qx = cellW / 4, qy = cellH / 4;
  for (let j = 0; j <= NY + 1; j++) {
    let y = Math.min(NY, Math.max(1, j)) * cellH;          // boundary cells copy their neighbour
    for (let i = 0; i <= NX + 1; i++) {
      let x = Math.min(NX, Math.max(1, i)) * cellW;
      let z = Math.min(BED_RELIEF_MAX_PX, Math.max(0, computeUserBedZ(x, y)));
      // Deposit is stored on a finer grid than the flow and is spiky particle by particle.
      // Average it over the flow cell so one grain does not put a step in the depth.
      if (hasDepo) z += 0.25 * (depoZ(x - qx, y - qy) + depoZ(x + qx, y - qy) + depoZ(x - qx, y + qy) + depoZ(x + qx, y + qy));
      depthGrid[IX(i, j)] = 1 - z / WATER_DEPTH_PX;
    }
  }
}

// Pressure boundary for the depth-weighted solve: walls and the inflow hold no gradient (the
// inflow speed is prescribed), and the outflow is open, pressure zero at the outflow face.
// project() copies at both ends, which leaves nothing able to adjust the outflow when inflow
// and outflow discharge disagree. It gets away with that because it never converges; a solve
// that does converge turns the mismatch into a steady false source (discharge rising
// downstream), which is what happened here with the outflow closed.
function setBndPressureOpen(x) {
  for (let j = 1; j <= NY; j++) { x[IX(0, j)] = x[IX(1, j)]; x[IX(NX+1, j)] = -x[IX(NX, j)]; }
  for (let i = 0; i <= NX + 1; i++) { x[IX(i, 0)] = x[IX(i, 1)]; x[IX(i, NY+1)] = x[IX(i, NY)]; }
}

// The along-channel part of the pressure, solved exactly: one unknown per column, the
// equations of projectDepth() summed across each section, a tridiagonal system. A bed asks
// for a channel-long adjustment (all the flow upstream of a rise has to learn about it), and
// 30 sweeps from zero only settle short-range imbalances: measured, flow over a full-width
// rise that should speed up by a third sped up by 1%. This gives the sweeps that long-range
// answer as their starting point, fresh every call.
// (Carrying the pressure from the previous frame also converges, and was tried. It kicks the
// field whenever the flow changes abruptly, by up to ten times the inflow speed for a few
// frames, because the carried pressure belongs to a flow that is no longer there.)
function sectionPressure(pArr, divArr) {
  const H = depthGrid, A = secA, D = secD, P = secP, C = secC;
  // A[i] couples column i to column i+1; D[i] is the section's summed divergence.
  for (let i = 1; i <= NX; i++) {
    let a = 0, d = 0;
    for (let j = 1; j <= NY; j++) {
      let idx = IX(i, j);
      if (solid[idx]) continue;
      d += divArr[idx];
      let R = IX(i+1, j);
      if (i < NX ? !solid[R] : true) a += 0.5 * (H[idx] + H[R]);
    }
    A[i] = a; D[i] = d;
  }
  // -A[i-1] P[i-1] + (A[i-1] + A[i]) P[i] - A[i] P[i+1] = D[i], with no gradient at the inflow
  // (A[0] = 0) and P[NX+1] = -P[NX] at the open outflow. Thomas algorithm.
  A[0] = 0;
  let prevC = 0, prevP = 0;
  for (let i = 1; i <= NX; i++) {
    let lo = A[i-1], up = (i < NX) ? A[i] : 0;
    let diag = lo + A[i] + (i === NX ? A[i] : 0);
    let den = diag - lo * prevC;
    if (den < 1e-9) { C[i] = 0; P[i] = 0; prevC = 0; prevP = 0; continue; }   // a fully blocked section
    C[i] = up / den;
    P[i] = (D[i] + lo * prevP) / den;
    prevC = C[i]; prevP = P[i];
  }
  for (let i = NX - 1; i >= 1; i--) P[i] += C[i] * P[i+1];
  for (let j = 1; j <= NY; j++)
    for (let i = 1; i <= NX; i++) { let idx = IX(i, j); pArr[idx] = solid[idx] ? 0 : P[i]; }
}

// project() with depth weights. With every depth equal it solves the same equation as
// project(), starting from sectionPressure() instead of zero and with an open outflow.
function projectDepth(uVec, vVec, pArr, divArr) {
  const H = depthGrid;
  for (let j = 1; j <= NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let idx = IX(i, j);
      if (solid[idx]) { divArr[idx] = 0; continue; }
      let R = IX(i+1, j), L = IX(i-1, j), T = IX(i, j+1), B = IX(i, j-1);
      let qR = solid[R] ? 0 : H[R] * uVec[R], qL = solid[L] ? 0 : H[L] * uVec[L];
      let qT = solid[T] ? 0 : H[T] * vVec[T], qB = solid[B] ? 0 : H[B] * vVec[B];
      divArr[idx] = -0.5 * (qR - qL + qT - qB);
    }
  }
  setBnd(0, divArr);
  sectionPressure(pArr, divArr);
  setBndPressureOpen(pArr);
  for (let iter = 0; iter < GAUSS_SEIDEL_ITERS; iter++) {
    for (let j = 1; j <= NY; j++) {
      for (let i = 1; i <= NX; i++) {
        let idx = IX(i, j);
        if (solid[idx]) continue;
        let R = IX(i+1, j), L = IX(i-1, j), T = IX(i, j+1), B = IX(i, j-1), hc = H[idx], pc = pArr[idx];
        // Face depth is the mean of the two cells. A solid neighbour is a wall (no pressure
        // gradient across it), which linSolve() expresses the same way: it stands in pc.
        let wR = 0.5 * (hc + H[R]), wL = 0.5 * (hc + H[L]), wT = 0.5 * (hc + H[T]), wB = 0.5 * (hc + H[B]);
        let gs = (divArr[idx] + wR * (solid[R] ? pc : pArr[R]) + wL * (solid[L] ? pc : pArr[L])
                              + wT * (solid[T] ? pc : pArr[T]) + wB * (solid[B] ? pc : pArr[B])) / (wR + wL + wT + wB);
        pArr[idx] = pc + DEPTH_SOR * (gs - pc);
      }
    }
    setBndPressureOpen(pArr);
  }
  for (let j = 1; j <= NY; j++)
    for (let i = 1; i <= NX; i++) {
      let idx = IX(i, j);
      if (solid[idx]) continue;
      // A wall holds no pressure gradient, so a solid neighbour stands in this cell's own
      // pressure. Reading the solid cell's stored zero instead kicked the flow next to an
      // obstacle by hundreds of times the inflow speed.
      let R = IX(i+1, j), L = IX(i-1, j), T = IX(i, j+1), B = IX(i, j-1), pc = pArr[idx];
      uVec[idx] -= 0.5 * ((solid[R] ? pc : pArr[R]) - (solid[L] ? pc : pArr[L]));
      vVec[idx] -= 0.5 * ((solid[T] ? pc : pArr[T]) - (solid[B] ? pc : pArr[B]));
    }
  setBnd(1, uVec); setBnd(2, vVec);
}

// Friction: global plus painted zones, precomputed into fricDampGrid (a damping factor per
// bed cell) when either the global value or a zone changes, so the solvers' inner loops are a
// lookup rather than an exp() per cell per step. False when there is no friction at all.
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
// The collocated solver above keeps u and v at cell centres and measures divergence across
// two cells (u[i+1] - u[i-1]). That leaves every other cell free (odd-even decoupling) and
// lets flow pass through a face that touches a solid cell, so water is made or lost at
// obstacles (2026-11-17 stress test, items 5, 20, 21). This solver keeps the normal velocity
// on each face instead (Harlow and Welch's marker-and-cell grid):
//
//   uF[IX(i, j)]  the face between cells (i, j) and (i+1, j), i = 0..NX. Face 0 is the inflow
//                 edge, face NX the outflow edge.
//   vF[IX(i, j)]  the face between cells (i, j) and (i, j+1), j = 0..NY. Faces 0 and NY are
//                 the banks and stay closed.
//   mac.p         pressure at cell centres.
//
// A face is open only if both of its cells are water and that water is connected to the
// outflow. Closed faces carry nothing. Each step: inflow on face 0, semi-Lagrangian advection
// of the faces (the backtrace stops at the first solid cell it meets), a small explicit
// diffusion, then a pressure solve that drives div(h u) to zero in every cell, h being the
// face depth from depthGrid (1 with no bed). The solve is preconditioned conjugate gradients
// (see macSolve()) run to a fixed residual, not a fixed number of sweeps, so the answer does
// not depend, beyond that residual, on where it started. Friction is applied after the solve, as in the old path. The
// faces are then averaged to cell centres into u and v, which is all the interface sees.
//
// With every cell of a column summed, div(h u) = 0 says the discharge through one column of
// faces equals the discharge through the next: conservation along the channel is exact to
// the solver tolerance, with or without obstacles.
//
// solverMode chooses the path; 'stam' runs the collocated solver unchanged. ?solver=mac in
// the page address turns this one on.
let solverMode = 'stam';
try { let q = new URLSearchParams(window.location.search).get('solver'); if (q === 'mac' || q === 'stam') solverMode = q; } catch (e) {}

const MAC_TOL = 1e-3;          // largest |div(h u)| left in any cell, index units (a face at inflow speed carries ~2.5)
const MAC_MAX_ITERS = 400;     // a cap, not the stopping rule; macStats.iters says how many were used
const MAC_MIC_TAU = 0.97, MAC_MIC_SIGMA = 0.25;   // modified incomplete Cholesky, as in Bridson's Fluid Simulation for Computer Graphics
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
    dist: new Float32Array(SIZE),
    colD: new Float64Array(NX + 2), colO: new Float64Array(NX + 2), colR: new Float64Array(NX + 2),
    colC: new Float64Array(NX + 2), colX: new Float64Array(NX + 2),
    solidSeen: new Uint8Array(SIZE), depthSeen: -1, built: false,
    uLast: new Float32Array(SIZE), vLast: new Float32Array(SIZE),
  };
}

// The faces, the connected water, the face depths, the pressure matrix and its
// preconditioner, and the distance to the nearest solid cell. Rebuilt only when the solid
// mask or the depth grid changes.
function macRebuild() {
  const M = mac, H = depthGrid, W = NX + 2;
  M.solidSeen.set(solid); M.depthSeen = depthVersion; M.built = true;
  const { openU, openV, hU, hV, active } = M;
  openU.fill(0); openV.fill(0); active.fill(0);
  // Water connected to the outflow, found by a flood fill from the last column. Water cut off
  // from it (a pond inside an obstacle, everything above a wall across the whole channel)
  // has nowhere to send the inflow; its faces are closed and it stands still.
  const stack = [];
  for (let j = 1; j <= NY; j++) { let c = IX(NX, j); if (!solid[c]) { active[c] = 1; stack.push(c); } }
  while (stack.length) {
    let c = stack.pop(), i = c % W, j = (c - i) / W;
    if (i > 1 && !solid[c-1] && !active[c-1]) { active[c-1] = 1; stack.push(c-1); }
    if (i < NX && !solid[c+1] && !active[c+1]) { active[c+1] = 1; stack.push(c+1); }
    if (j > 1 && !solid[c-W] && !active[c-W]) { active[c-W] = 1; stack.push(c-W); }
    if (j < NY && !solid[c+W] && !active[c+W]) { active[c+W] = 1; stack.push(c+W); }
  }
  for (let j = 1; j <= NY; j++) {
    for (let i = 0; i <= NX; i++) {
      let c = IX(i, j);
      openU[c] = (i === 0) ? active[c+1] : (i === NX ? active[c] : (active[c] && active[c+1] ? 1 : 0));
      hU[c] = H ? 0.5 * (H[c] + H[c+1]) : 1;
    }
  }
  for (let j = 1; j < NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      openV[c] = active[c] && active[c+W] ? 1 : 0;
      hV[c] = H ? 0.5 * (H[c] + H[c+W]) : 1;
    }
  }
  // A p = -div: for each cell, the sum over its open faces of h_f (p_c - p_neighbour). The
  // inflow face has its speed given, so it holds no pressure; the outflow face sees p = 0 one
  // half cell out (the ghost is -p_c, as setBndPressureOpen() does), so it counts twice.
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
  // Chebyshev distance, in cells, from each cell to the nearest solid cell (capped), two
  // chamfer passes. The advection backtrace uses it to take long steps through open water.
  const D = M.dist, CAP = 1e4;
  for (let c = 0; c < SIZE; c++) D[c] = solid[c] ? 0 : CAP;
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
// steps no longer than the distance to the nearest solid cell allows, and stops at the last
// point before a solid cell, so a backtrace never jumps a wall. (The old advect() checked
// only the corners at the far end of a jump of up to 12.8 cells per unit speed.)
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
      if (!solid[IX(ni, nj)]) { x = nx; y = ny; }
      break;
    }
    let ni = Math.floor(nx + 0.5), nj = Math.floor(ny + 0.5);
    if (solid[IX(ni, nj)]) break;
    x = nx; y = ny; t += f;
  }
  macTrace.x = x; macTrace.y = y;
  return macTrace;
}

// Conjugate gradients on A p = b over the connected water, preconditioned with MIC(0),
// started from the last step's pressure, stopped when no cell is left with more than MAC_TOL.
// Because it is run to a residual, carrying the pressure over only saves iterations; the
// result is the same field (the collocated solver could not do that: see sectionPressure()).
function macSolve(b) {
  const M = mac, { Adiag, Ax, Ay, Lx, Ly, precon, cells, colOf, p, r, z, s, q } = M, n = M.nCells, W = NX + 2;
  const { colD, colO, colR, colC, colX } = M;
  // MIC(0) alone handles short-range error well and the channel-long part badly: the
  // pressure that tells water upstream about an obstacle took 60 of 85 iterations. So the
  // preconditioner also solves the column-sum system exactly (one unknown per column, as
  // sectionPressure() does for the old path) and adds that correction, uniform down each
  // column (an additive two-level preconditioner; still symmetric, so CG holds). Returns
  // r . z, which CG needs next.
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
  z.fill(0); s.fill(0); q.fill(0);
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

function macStep() {
  if (!mac) macAlloc();
  const M = mac, W = NX + 2;
  let { uF, vF, uN, vN } = M;
  const { openU, openV, hU, hV } = M;
  let rebuilt = false;
  // The mask (an object placed, moved, timed in or out) or the depth changed.
  if (!M.built || M.depthSeen !== depthVersion) rebuilt = true;
  else for (let c = 0; c < SIZE; c++) if (solid[c] !== M.solidSeen[c]) { rebuilt = true; break; }
  if (rebuilt) macRebuild();
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
  // dt0 is the old solver's scale (12.8 cells per unit speed per step), kept so the flow
  // moves as it did.
  const dt0 = DT * NX;
  for (let j = 1; j <= NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (!openU[c]) { uN[c] = 0; continue; }
      let ip = Math.min(i + 1, NX);
      let vc = 0.25 * (vF[c-W] + vF[c] + vF[IX(ip, j-1)] + vF[IX(ip, j)]);
      let b = macBacktrace(i + 0.5, j, -dt0 * uF[c], -dt0 * vc);
      uN[c] = macSampleU(uF, b.x, b.y);
    }
  }
  for (let j = 1; j < NY; j++) {
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (!openV[c]) { vN[c] = 0; continue; }
      let uc = 0.25 * (uF[c-1] + uF[c] + uF[c-1+W] + uF[c+W]);
      let b = macBacktrace(i, j + 0.5, -dt0 * uc, -dt0 * vF[c]);
      vN[c] = macSampleV(vF, b.x, b.y);
    }
  }
  // Inflow: the same speed and noise as the old path, on the inflow faces.
  for (let j = 1; j <= NY; j++) {
    let c = IX(0, j);
    uN[c] = openU[c] ? inflowVel + (noise(j * 0.15, simTime * 0.3) - 0.5) * 0.3 : 0;
  }
  // Diffusion, one explicit step with the old path's coefficient (DT * VISC * NX * NY, about
  // 0.06, well inside the explicit limit of 0.25). A closed neighbour stands in the face's own
  // value, so walls are free-slip, as in linSolve().
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

  // Projection: div(h u) of each connected cell, solved away.
  const b = M.uN;   // free again: reused for the right-hand side
  b.fill(0);
  for (let k = 0; k < M.nCells; k++) {
    let c = M.cells[k];
    b[c] = -(hU[c] * uF[c] - hU[c-1] * uF[c-1] + hV[c] * vF[c] - hV[c-W] * vF[c-W]);
  }
  macSolve(b);
  const P = M.p;
  for (let j = 1; j <= NY; j++) {
    for (let i = 1; i < NX; i++) { let c = IX(i, j); if (openU[c]) uF[c] -= P[c+1] - P[c]; }
    let c = IX(NX, j); if (openU[c]) uF[c] += 2 * P[c];
  }
  for (let j = 1; j < NY; j++)
    for (let i = 1; i <= NX; i++) { let c = IX(i, j); if (openV[c]) vF[c] -= P[c+W] - P[c]; }

  // Friction on the solved faces, as the old path applies it to the solved cells. The inflow
  // face is the boundary condition and is left alone.
  if (updateFricDamp()) {
    for (let j = 1; j <= NY; j++) {
      let gj = Math.min(GH - 1, Math.floor(j * cellH / DEPO_CELL));
      for (let i = 1; i <= NX; i++) {
        let c = IX(i, j);
        if (!openU[c]) continue;
        let gi = Math.min(GW - 1, Math.floor((i + 0.5) * cellW / DEPO_CELL));
        uF[c] *= fricDampGrid[gj * GW + gi];
      }
    }
    for (let j = 1; j < NY; j++) {
      let gj = Math.min(GH - 1, Math.floor((j + 0.5) * cellH / DEPO_CELL));
      for (let i = 1; i <= NX; i++) {
        let c = IX(i, j);
        if (!openV[c]) continue;
        let gi = Math.min(GW - 1, Math.floor(i * cellW / DEPO_CELL));
        vF[c] *= fricDampGrid[gj * GW + gi];
      }
    }
  }

  // To the interface: each cell the mean of its two faces in each direction.
  for (let j = 1; j <= NY; j++)
    for (let i = 1; i <= NX; i++) {
      let c = IX(i, j);
      if (solid[c]) { u[c] = 0; v[c] = 0; continue; }
      u[c] = 0.5 * (uF[c-1] + uF[c]);
      v[c] = 0.5 * (vF[c-W] + vF[c]);
    }
  setBnd(1, u); setBnd(2, v);
  M.uLast.set(u); M.vLast.set(v);
  for (let k = 0; k < M.nCells; k++) { let c = M.cells[k]; p[c] = P[c]; }
}

function velocityStep() {
  if (depthDirty) rebuildDepthGrid();
  if (solverMode === 'mac') { macStep(); return; }
  const bed = !!depthGrid;
  // Dirichlet inflow
  for (let j = 1; j <= NY; j++) {
    let idx = IX(1, j);
    if (!solid[idx]) {
      let noiseVal = (noise(j * 0.15, simTime * 0.3) - 0.5) * 0.3;
      u[idx] = inflowVel + noiseVal;
    }
  }
  diffuse(1, uPrev, u, VISC);
  if (bed) projectDepth(uPrev, vPrev, p, divArr); else project(uPrev, vPrev, p, divArr);
  advect(1, u, uPrev, uPrev, vPrev);
  advect(2, v, vPrev, uPrev, vPrev);
  if (bed) projectDepth(u, v, p, divArr); else project(u, v, p, divArr);

  // Bed friction: exponential drag per step. With none, the field keeps near-inflow speed
  // everywhere, particles never drop below settleThresh, and almost nothing deposits.
  // Friction: global plus painted zones, applied per cell to the solved field (see
  // updateFricDamp()).
  if (updateFricDamp()) {
    for (let j = 1; j <= NY; j++) {
      let gj = Math.min(GH - 1, Math.floor(j * cellH / DEPO_CELL));
      for (let i = 1; i <= NX; i++) {
        let gi = Math.min(GW - 1, Math.floor(i * cellW / DEPO_CELL));
        let d0 = fricDampGrid[gj * GW + gi];
        if (d0 !== 1) { let q = IX(i, j); u[q] *= d0; v[q] *= d0; }
      }
    }
  }
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
      `<p>Then watch. Sediment usually piles up in the slow water behind an object and gets scoured away beside it, where the water squeezes past.</p>` },
    { id: 'river-physics', after: 'thumb', target: guideSection('reset-physics', 'erosion-prob'), title: 'Physics', text:
      `<p>These change how the river behaves. <b>inflow</b> is how fast the water comes in. Faster water carries sediment further and scours harder. <b>friction</b> is the drag of the riverbed on all of the water. More friction slows the water everywhere, so more settles and less is lifted.</p>
       <p><b>settle thresh</b> is the speed below which a grain can settle, and <b>settle prob</b> is how likely it is to settle each moment once it is that slow. <b>erode thresh</b> is the speed above which the water can lift a deposit again, and <b>erode prob</b> is how likely that is. Together they decide where the ground builds and where it wears.</p>
       <p><b>zone μ</b> and <b>brush r</b> belong to the friction brush, which comes after the toggles. <b>reset</b> puts all of these back.</p>` },
    { id: 'river-fric', after: 'toggles', target: '#toggle-fric', title: 'Painting roughness', text:
      `<p><b>fric</b> lets you paint rough ground onto the site, like a reed bed, a planted bank or a stretch of riprap. Click it once for <b>fric+</b> and drag on the site to paint roughness on. Click again for <b>fric-</b> to rub it off, and once more to stop painting.</p>
       <p>Rough ground slows the water passing over it, so sediment settles there and the ground resists scour. In the physics section, <b>zone μ</b> sets how rough the paint is and <b>brush r</b> sets the size of the brush.</p>` },
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

  init() {
    uPrev = new Float32Array(SIZE); vPrev = new Float32Array(SIZE);
    p = new Float32Array(SIZE); divArr = new Float32Array(SIZE);
  },

  step() { velocityStep(); },

  // R, or the interface found the flow non-finite: start the solver from rest.
  restart() {
    uPrev.fill(0); vPrev.fill(0); p.fill(0); divArr.fill(0);
    if (mac) { mac.uF.fill(0); mac.vF.fill(0); mac.p.fill(0); }
  },

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
