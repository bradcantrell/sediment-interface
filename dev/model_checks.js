// Checks for the river model (model.js). Called by dev/headless_harness.js, which is shared
// by every repo that uses the interface; these travel with model.js.
//
//   - sediment travels downstream
//   - friction slows the field, and the friction brush adds and subtracts
//   - still water over a sloping bed stays still; leftover motion stays within its bound
//   - the bed is in the flow: speed-up over a rise equals the depth ratio, discharge is
//     conserved, a uniform rise changes nothing, deposit counts as bed
//
// Each was shown to fail with the code it covers broken. Verified to have teeth: with
// paintFriction turned into a silent no-op the brush checks fail and the harness exits 1,
// while node --check still passes.
module.exports = function ({ app, S, check }) {
  // ---------------------------------------------------------------- the scene carries the inflow
  {
    const sc = app.run("sceneState()");
    check(sc.inflow === S().inflowVel && sc.inflow > 0, "the river adds its inflow to the scene", `inflow ${sc.inflow}`);
  }

  // ---------------------------------------------------------------- transport runs downstream
  // Followed particle by particle. The mean x of the whole cloud is not a test once the run
  // is under way: particles that leave re-enter at the inflow, so it rises and falls.
  {
    app.setPaused(false);
    const before = new Map(S().particles.map(p => [p, p.x]));
    for (let i = 0; i < 20; i++) app.draw();
    let n = 0, dx = 0;
    for (const p of S().particles) { const x0 = before.get(p); if (x0 !== undefined) { n++; dx += p.x - x0; } }
    check(n > 100 && dx / n > 20, "particles travel downstream (+x)", `${n} followed, mean dx ${(n ? dx / n : 0).toFixed(1)} px in 20 frames`);
  }

  // ---------------------------------------------------------------- friction reaches the physics
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

  // ---------------------------------------------------------------- every friction change reaches the physics
  // The damping grid is derived and cached. The slider once changed it only the first time
  // (2026-11-17 stress test): the label moved and the solver kept the old value.
  {
    const seen = [];
    for (const f of [0.5, 3, 0, 1.5]) {
      app.setFriction(f);
      app.velocityStep();
      const g = S().fricDampGrid;
      seen.push(g ? g[0] : NaN);
      const want = f > 0 ? Math.exp(-f * app.run("DT")) : 1;
      if (!(g && Math.abs(g[0] - want) < 1e-6)) { check(false, "each friction change reaches the solver", `friction ${f}: damping ${g ? g[0] : 'none'}, want ${want}`); break; }
      if (f === 1.5) check(true, "each friction change reaches the solver", `damping ${seen.map(x => x.toFixed(4)).join(' -> ')}`);
    }
    app.setFriction(0);
  }

  // ---------------------------------------------------------------- obstacles beside the outflow
  // Two rectangles by the outflow, present from rest, sent the plain solver to 2e17 and NaN
  // within the 80-step spin-up (2026-11-17 stress test, project() read a solid neighbour's
  // stored zero pressure). The scene is from that report.
  {
    const keep = app.run("JSON.stringify(obstacles)");
    const clips = [{ start: 0, dur: 120 }];
    const obs = [{ type: "rect", x: 1171.35, y: 19.65, w: 94.32, h: 69.15, rotation: 340.17, clips },
                 { type: "rect", x: 1161.01, y: 410.40, w: 83.34, h: 83.20, rotation: 151.93, clips }];
    app.run(`obstacles = ${JSON.stringify(obs)}; buildSolidMask(); solidMaskDirty = false; restartFlow(false); depthGrid = null; depthDirty = false; simTime = 0; globalThis.__fric = [fricGrid, fricDampGrid]; fricGrid = null; fricDampGrid = null`);   // the plain solver and no friction, as on a fresh page with no bed drawn
    const plain = !app.run("depthGrid");
    for (let k = 0; k < 80; k++) app.run("simTime += DT; model.step()");
    let mx = 0, bad = 0;
    const U = S().U, V = S().V;
    for (let i = 0; i < U.length; i++) { const q = Math.hypot(U[i], V[i]); if (!Number.isFinite(q)) bad++; else if (q > mx) mx = q; }
    const inflow = S().inflowVel;
    check(plain && bad === 0 && mx < 3 * inflow, "obstacles beside the outflow spin up without blowing up",
      `${plain ? 'plain' : 'depth'} solver, max speed ${mx.toPrecision(3)} (inflow ${inflow}), ${bad} non-finite`);
    app.run(`obstacles = ${keep}; buildSolidMask(); solidMaskDirty = false; restartFlow(false); depthDirty = true; [fricGrid, fricDampGrid] = globalThis.__fric; fricDirty = true`);
    for (let k = 0; k < 80; k++) app.run("simTime += DT; model.step()");
  }

  // ---------------------------------------------------------------- a non-finite flow is restarted
  // One NaN spreads through the field and never clears; the interface puts the flow back at
  // rest and says so. R starts the solver's own fields from rest too.
  {
    app.setPaused(false);
    app.run("u[IX(20, 20)] = NaN; v[IX(30, 30)] = Infinity");
    app.draw();
    const U = S().U, V = S().V;
    let bad = 0; for (let i = 0; i < U.length; i++) if (!Number.isFinite(U[i]) || !Number.isFinite(V[i])) bad++;
    const noted = app.run("flowRestartedAt >= 0");
    check(bad === 0 && noted, "a non-finite flow is restarted from rest and noted", `${bad} non-finite after one frame, noted ${noted}`);
    app.run("flowRestartedAt = -1");
    for (let i = 0; i < 10; i++) app.draw();
    app.run("restartFlow(false)");
    const rest = app.run("[uPrev, vPrev, p].every(a => a.every(x => x === 0)) && u.every(x => x === 0) && v.every(x => x === 0)");
    check(rest, "restarting the flow (R) clears the solver's own fields", rest ? "u, v, uPrev, vPrev, p all zero" : "something kept its values");
    for (let k = 0; k < 80; k++) app.run("simTime += DT; model.step()");
  }

  // ---------------------------------------------------------------- the friction brush is three-state
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

  // ---------------------------------------------------------------- painted friction follows a resize
  // It used to stay at its old pixels, cleared from the screen but still acting (2026-11-17).
  {
    const W0 = app.run("width"), H0 = app.run("height");
    app.run("ensureFricGrid(); fricGrid.fill(0); paintFriction(width * 0.75, height * 0.5, 1)");
    const peak = () => app.run(`(() => { let m = -1, k = 0; for (let q = 0; q < fricGrid.length; q++) if (fricGrid[q] > m) { m = fricGrid[q]; k = q; }
      return [((k % GW + 0.5) * DEPO_CELL) / width, ((Math.floor(k / GW) + 0.5) * DEPO_CELL) / height, fricGrid.length === GW * GH]; })()`);
    const a = peak();
    let redrawn = 0;
    const realRedraw = app.run("redrawFricBuffer");
    app.run("(f) => { globalThis.__rf = f; }")(() => { redrawn++; });
    app.run("redrawFricBuffer = function () { globalThis.__rf(); }");
    app.run(`resizeCanvas(${W0 + 270 + 240}, ${H0 + 120}); windowResized()`);
    const b = peak();
    app.run("(f) => { redrawFricBuffer = f; }")(realRedraw);
    app.run(`resizeCanvas(${W0 + 270}, ${H0}); windowResized(); fricGrid.fill(0); fricDirty = true; redrawFricBuffer()`);
    check(b[2] && Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01 && redrawn > 0,
          "painted friction stretches with a resize and is drawn again",
          `peak at ${a.slice(0, 2).map(v => v.toFixed(3)).join(",")} -> ${b.slice(0, 2).map(v => v.toFixed(3)).join(",")}, grid matches ${b[2]}, redrawn ${redrawn}x`);
  }

  // ---------------------------------------------------------------- still water
  // The well-balanced question: on a sloping bed with no inflow, should anything move?
  //
  // What we found, by elimination, on 2026-10-28:
  //
  //   - The velocity solver has NO bed term at all. velocityStep() is inflow, diffuse,
  //     project, advect, project, friction. Nothing reads bedZ. The bed steers particles
  //     through updateParticles(), not the solved field. So "well-balanced with respect to
  //     the bed" is currently vacuous: there is no bed coupling to unbalance. Hydrostatic
  //     reconstruction becomes relevant only if and when a bed-pressure term is added.
  //   - There IS a steady residual, mean 0.08 and max ~0.7, about 3% of the ~2.5 mean speed
  //     a flowing field carries in check 4. It does not grow (n=120 0.776, n=360 0.628,
  //     n=1200 0.709), so it is a standing offset, not an instability.
  //   - It is produced by the pressure projection. Disabling project() drives the residual to
  //     machine zero (2.6e-29). Reducing the Poisson iterations from 4 to 1 also drives it to
  //     zero. It is not the bed, not the pressure warm start (clearing p changes nothing), and
  //     only partly the obstacles (0.35 with, 0.24 without). The remaining source is a
  //     divergence at the inflow boundary being projected into the domain.
  //
  // The tolerances below lock in current behaviour rather than demand the ideal: roughly twice
  // the measured value, so a regression fires and an improvement does not. They must not be
  // raised to make a worse solver pass — that is how a bad model starts scoring well.
  //
  // Revised 2026-11-13, when the bed (drawn and deposited) entered the velocity solver:
  //
  //   - The residual above is not generated from rest. This block zeroes u and v but not
  //     vPrev, and velocityStep() advects vPrev into v, so the run starts with the previous
  //     check's cross-flow still in it. Zero vPrev and uPrev as well and the field stays at
  //     exactly 0 for 3000 steps, over a sloping bed with deposit on it. That is now check 9a,
  //     and it is the well-balanced property the first note called vacuous: there is a bed
  //     coupling now, and it does not move still water.
  //   - What 9b measures is therefore leftover motion with the inflow shut. It neither decays
  //     nor grows in either projection (sum of u^2 + v^2 over 3000 steps: plain 94 -> 145,
  //     depth-weighted 218 -> 144).
  //   - STILL_TOL_MEAN goes from 0.15 to 0.30. Reason: this block draws a bed, so it now runs
  //     through projectDepth(), where the same leftover measures 0.11 to 0.17 across runs
  //     (deposit positions are random) against 0.08 to 0.10 in project(). 0.30 is twice the
  //     measured value, the same rule as before. STILL_TOL_MAX is unchanged.
  const STILL_TOL_MEAN = 0.30;   // measured 0.11-0.17 through projectDepth(); was 0.15 for 0.080 through project()
  const STILL_TOL_MAX  = 1.50;   // measured 0.7-1.0
  {
    const U = S().U, V = S().V;
    app.setInflow(0);
    app.setFriction(0);
    const w = S().width, h = S().height;
    app.setBedPoints([{ x: w * 0.15, z: 10 }, { x: w * 0.5, z: 120 }, { x: w * 0.85, z: 20 }]);
    app.rebuildUserBedGrid();
    app.updateBedBuffer();
    const sample = () => {
      let mx = 0, s = 0, c = 0;
      for (let i = 0; i < U.length; i++) {
        const m = Math.abs(U[i]) + Math.abs(V[i]);
        if (!isFinite(m)) continue;
        if (m > mx) mx = m;
        s += m; c++;
      }
      return { max: mx, mean: s / Math.max(c, 1) };
    };
    // 9a. From true rest nothing may move, bed or no bed. The whole solver state is zeroed,
    // then restored, so 9b still starts from the leftover cross-flow it has always measured.
    {
      const keep = app.run("[u.slice(), v.slice(), uPrev.slice(), vPrev.slice()]");
      app.run("u.fill(0); v.fill(0); uPrev.fill(0); vPrev.fill(0)");
      for (let k = 0; k < 600; k++) app.velocityStep();
      const r = sample();
      check(app.run("depthGrid") !== null && r.max < 1e-9,
            "still water over a sloping bed stays still", `max |u|+|v| ${r.max.toExponential(1)} after 600 steps, bed in the solver: ${app.run("depthGrid") !== null}`);
      globalThis.__keep = keep;
      app.run("u.set(globalThis.__keep[0]); v.set(globalThis.__keep[1]); uPrev.set(globalThis.__keep[2]); vPrev.set(globalThis.__keep[3])");
    }
    U.fill(0); V.fill(0);
    const marks = [120, 360, 1200];
    const out = [];
    let done = 0;
    for (const m of marks) {
      while (done < m) { app.velocityStep(); done++; }
      const r = sample();
      out.push(`n=${m}: max ${r.max.toExponential(2)} mean ${r.mean.toExponential(2)}`);
    }
    console.log("  ....  still water: " + out.join(" | ") + "   (target 0 for both)");
    const s = sample();
    check(isFinite(s.max) && s.mean <= STILL_TOL_MEAN && s.max <= STILL_TOL_MAX,
          "leftover motion with the inflow shut stays bounded",
          `mean ${s.mean.toFixed(3)} (tol ${STILL_TOL_MEAN}), max ${s.max.toFixed(3)} (tol ${STILL_TOL_MAX})`);
  }

  // ---------------------------------------------------------------- the drawn bed reaches the flow
  // The velocity solver used to ignore the bed entirely (it steered particles only). These
  // checks pin the depth-averaged behaviour: discharge h*u is what is conserved, not u.
  {
    const st0 = S(), w = st0.width, NX = st0.NX, NY = st0.NY, IXf = (i, j) => i + j * (NX + 2);
    const savedBed = st0.bedPoints, savedXS = app.run("bedXSections"), savedObs = st0.obstacles;
    app.setObstacles([]);
    app.run("depoGrid.fill(0)");          // earlier checks left deposit, which is bed now
    app.run("bedXSections = []; friction = 0; fricGrid = null; fricDirty = true; solidMaskDirty = true; buildSolidMask()");
    app.setInflow(2.5);
    // Time-mean u for a bed, started from uniform flow so no run inherits the last one's field.
    const runMean = (pts) => {
      app.setBedPoints(pts); app.rebuildUserBedGrid();
      app.run("u.fill(inflowVel); v.fill(0); uPrev.fill(inflowVel); vPrev.fill(0)");
      for (let k = 0; k < 500; k++) app.velocityStep();
      const m = new Float64Array(st0.U.length), n = 60;
      for (let k = 0; k < n; k++) { app.velocityStep(); const U = S().U; for (let q = 0; q < m.length; q++) m[q] += U[q] / n; }
      return m;
    };
    const col = (m, i) => { let a = 0; for (let j = 1; j <= NY; j++) a += m[IXf(i, j)]; return a / NY; };

    const flat = runMean([]);
    check(app.run("depthGrid") === null && Math.abs(col(flat, NX >> 1) - 2.5) < 0.01,
          "with no bed drawn the solver runs its plain projection", `mid-channel u ${col(flat, NX >> 1).toFixed(3)}`);

    // A rise across the whole width: one-dimensional, so u must scale as 1/depth.
    const hump = runMean([{ x: w * 0.1, z: 0 }, { x: w * 0.5, z: 160 }, { x: w * 0.9, z: 0 }]);
    const H = app.run("depthGrid");
    if (!H) {
      check(false, "flow speeds up over a full-width rise by the depth ratio", "the solver has no depth grid with a bed drawn");
      check(false, "discharge is conserved along the channel over a bed", "no depth grid");
    } else {
      const ic = NX >> 1, up = col(hump, 6), crest = col(hump, ic), want = H[IXf(6, 1)] / H[IXf(ic, 1)];
      check(Math.abs(crest / up / want - 1) < 0.03,
            "flow speeds up over a full-width rise by the depth ratio", `u crest/upstream ${(crest / up).toFixed(3)}, depth ratio ${want.toFixed(3)}`);
      let qmin = Infinity, qmax = -Infinity;
      for (let i = 3; i <= NX - 2; i++) { let q = 0; for (let j = 1; j <= NY; j++) q += H[IXf(i, j)] * hump[IXf(i, j)]; q /= NY; qmin = Math.min(qmin, q); qmax = Math.max(qmax, q); }
      check(qmin > 0 && (qmax - qmin) / 2.5 < 0.01, "discharge is conserved along the channel over a bed", `h*u from ${qmin.toFixed(3)} to ${qmax.toFixed(3)} against an inflow of 2.5`);
    }

    // Raising the whole bed by the same amount changes the depth everywhere and the flow nowhere.
    const raised = runMean([{ x: 0, z: 100 }, { x: w, z: 100 }]);
    let d = 0; for (let j = 1; j <= NY; j++) for (let i = 1; i <= NX; i++) d = Math.max(d, Math.abs(raised[IXf(i, j)] - flat[IXf(i, j)]));
    check(app.run("depthGrid") !== null && d / 2.5 < 0.02, "a uniformly raised bed leaves the flow unchanged", `max |u - flat| ${(d / 2.5 * 100).toFixed(2)}% of inflow`);

    // Accumulated deposit is bed too. A band of deposit across the channel, with nothing drawn,
    // must speed the flow up by the depth ratio just as a drawn rise does.
    {
      const h = st0.height, x0 = w * 0.45, x1 = w * 0.55;
      app.run("depoGrid.fill(0)");
      for (let pass = 0; pass < 40; pass++)
        for (let y = 2; y < h; y += 4) for (let x = x0; x <= x1; x += 4) app.run("addDeposit")(x, y, 4);
      const depo = runMean([]);
      const Hd = app.run("depthGrid");
      if (!Hd) check(false, "accumulated deposit shallows the flow like a drawn bed", "no depth grid with deposit on the bed");
      else {
        const ic = Math.round((w * 0.5) / st0.cellW), up = col(depo, 6), over = col(depo, ic), want = Hd[IXf(6, NY >> 1)] / Hd[IXf(ic, NY >> 1)];
        check(want > 1.05 && Math.abs(over / up / want - 1) < 0.03,
              "accumulated deposit shallows the flow like a drawn bed", `u over deposit/upstream ${(over / up).toFixed(3)}, depth ratio ${want.toFixed(3)}`);
      }
      app.run("depoGrid.fill(0)");
      const cleared = runMean([]);
      check(app.run("depthGrid") === null && Math.abs(col(cleared, NX >> 1) - 2.5) < 0.01,
            "clearing the deposit returns the solver to its plain projection", `mid-channel u ${col(cleared, NX >> 1).toFixed(3)}`);
    }

    app.setBedPoints(savedBed); app.run("bedXSections = globalThis.__xs", (globalThis.__xs = savedXS)); app.rebuildUserBedGrid();
    app.setObstacles(savedObs); app.run("solidMaskDirty = true");
  }
};
