// R6 check: is the plain project() regime (no bed, no deposit) a converged, mass-conserving
// flow, or does it lose discharge downstream? Compares column discharge (sum of u over the
// wet cells of a column, channel of uniform width so it should be equal at every x) in
// plain mode vs depth mode with H == 1 (a deposit of 1e-6 px turns depth mode on).
// Particles are not stepped, so nothing deposits by itself.
// Run from this folder: node r6_steady_compare.js
const H = require('./h.js'); const { run, S } = H;
const NXc = 160, NYc = 90, W = 162;
function colQ(i) { const U = S().U, sol = S().solid; let s = 0; for (let j = 1; j <= NYc; j++) { const id = i + j * W; if (!sol[id]) s += U[id]; } return s; }
function report(tag) {
  const q = [5, 40, 80, 120, 155].map(colQ);
  console.log(`${tag.padEnd(34)} Q(x=5,40,80,120,155) = ${q.map(x => x.toFixed(1)).join(', ')}   Q155/Q5 = ${(q[4] / q[0]).toFixed(3)}  depthGrid=${run('depthGrid') ? 'ON' : 'off'}`);
}
for (const fr of [0, 1, 3]) {
  run(`friction=${fr};inflowVel=2.5;fricDirty=true;depthGrid=null;depthDirty=false;if(depoGrid)depoGrid.fill(0);u.fill(0);v.fill(0);uPrev.fill(0);vPrev.fill(0)`);
  H.steps(400, { particles: false });
  report(`friction ${fr} plain project() 400`);
  H.steps(400, { particles: false });
  report(`friction ${fr} plain project() 800`);
  run('depoGrid[5000]=1e-6;depthDirty=true');
  H.steps(400, { particles: false });
  report(`friction ${fr} projectDepth H=1 +400`);
  run('depoGrid.fill(0);depthDirty=true');   // back to plain: rebuild finds no deposit
  H.steps(400, { particles: false });
  report(`friction ${fr} back to plain +400`);
}
