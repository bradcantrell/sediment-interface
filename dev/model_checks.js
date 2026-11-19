// Checks for the river model (model.js). Called by dev/headless_harness.js, which is shared
// by every repo that uses the interface; these travel with model.js.
//
//   - sediment travels downstream
//   - friction slows the grains near the bed and turns the water from rough ground, and the
//     friction brush adds and subtracts
//   - still water over a sloping bed stays still; with the inflow shut the water slows toward rest
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

  // ---------------------------------------------------------------- sand settles behind an object
  // The guide says sediment piles up in the slow water behind an object and is scoured beside
  // it. Grains used to follow their streamlines round an object and almost none got into its
  // wake (2026-11-18: 0 in the box behind a circle after 1500 frames, 43 after 3000). With the
  // river's turbulent spreading (rules.spread) they wander into it: 162 after 1500 frames, and
  // still none on the flanks, where the water squeezes past.
  {
    const st = S(), W = st.width, H = st.height, savedBed = st.bedPoints, savedObs = st.obstacles;
    const c = { x: W * 0.583, y: H * 0.5, d: 90 };
    app.setBedPoints([]); app.rebuildUserBedGrid();
    app.setObstacles([{ type: "circle", x: c.x, y: c.y, w: c.d, h: c.d, rotation: 0, clips: [{ start: 0, dur: Infinity }] }]);
    app.run("friction = 0; fricDirty = true; inflowVel = 2.5; depoGrid.fill(0); deposited = []; solidMaskDirty = true; restartFlow(false); initParticles(false); model.bedChanged()");
    app.setPaused(false);
    for (let k = 0; k < 1500; k++) app.draw();
    const box = (x0, x1, y0, y1) => app.run(`(() => { let a = 0; for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) { const x = (i + 0.5) * DEPO_CELL, y = (j + 0.5) * DEPO_CELL;
      if (x >= ${x0} && x < ${x1} && y >= ${y0} && y < ${y1}) a += depoGrid[j * GW + i]; } return a; })()`);
    const r = c.d / 2;
    const lee = box(c.x + r, c.x + r + 155, c.y - 60, c.y + 60);
    const flanks = box(c.x - r - 15, c.x + r + 15, c.y - r - 95, c.y - r - 5) + box(c.x - r - 15, c.x + r + 15, c.y + r + 5, c.y + r + 95);
    check(lee > 60 && flanks < 0.2 * lee, "sand settles in the slow water behind an object, and not beside it",
      `after 1500 frames: ${lee.toFixed(0)} behind the circle, ${flanks.toFixed(0)} on its flanks (grains without the spread: 0 behind it)`);
    app.setObstacles(savedObs); app.setBedPoints(savedBed); app.rebuildUserBedGrid();
    app.run("depoGrid.fill(0); deposited = []; solidMaskDirty = true; restartFlow(false); model.bedChanged()");
  }

  // ---------------------------------------------------------------- grains move like water
  // The spread must not shake the grains. Its first setting (0.02, 10 frames) made a grain's
  // step turn 0.133 of its length from one frame to the next, nine times what it does with
  // no spread (0.015), and the page looked wrong (Brad, 2026-11-18). Measured on a plain
  // channel, each grain matched to itself, 60 frames. Now 0.023; the limit is 0.05.
  {
    const st = S(), savedBed = st.bedPoints, savedObs = st.obstacles;
    app.setBedPoints([]); app.rebuildUserBedGrid(); app.setObstacles([]);
    app.run("friction = 0; fricDirty = true; inflowVel = 2.5; depoGrid.fill(0); deposited = []; solidMaskDirty = true; restartFlow(false); initParticles(false); model.bedChanged()");
    app.setPaused(false);
    for (let k = 0; k < 150; k++) app.draw();
    app.run("globalThis.__H = new Map(); globalThis.__T = [0, 0]");
    for (let k = 0; k < 60; k++) {
      app.draw();
      app.run(`for (const p of particles) { const h = __H.get(p) || []; h.push([p.x, p.y]); if (h.length > 3) h.shift(); __H.set(p, h);
        if (h.length === 3) { const [a, b, c] = h, st = Math.hypot(c[0] - b[0], c[1] - b[1]); if (st < 40) { __T[0] += Math.hypot(c[0] - 2 * b[0] + a[0], c[1] - 2 * b[1] + a[1]); __T[1] += st; } } }`);
    }
    const turn = app.run("__T[0] / __T[1]");
    check(turn < 0.05, "the grains move smoothly with the water", `a grain's step turns ${turn.toFixed(3)} of its length a frame (no spread: 0.015, the first spread: 0.133, limit 0.05)`);
    app.setObstacles(savedObs); app.setBedPoints(savedBed); app.rebuildUserBedGrid();
    app.run("solidMaskDirty = true; restartFlow(false)");
  }

  // ---------------------------------------------------------------- friction reaches the physics
  // Friction acts before the pressure solve (2026-11-18), so it cannot take water out of the
  // river. On the sediment it acts through rules.nearBed: the settling and lifting rules see
  // the speed times (1 + f)^-0.6 (Manning's backwater, see model.js), so over a drawn bed more
  // settles and less is lifted. Measured 2026-11-18 over 3000 steps of this kind of scene: the
  // deposit 6.2k at friction 0, 9.9k at 1, 69k at 3. 300 frames here, from the same start.
  {
    const st = S(), w = st.width;
    const f0 = app.run("model.rules.nearBed(width / 2, height / 2)");
    app.setFriction(3);
    const f3 = app.run("model.rules.nearBed(width / 2, height / 2)");
    const savedBed = st.bedPoints;
    const grow = (fr) => {
      app.setFriction(fr);
      app.setBedPoints([{ x: w * 0.15, z: 10 }, { x: w * 0.5, z: 120 }, { x: w * 0.85, z: 20 }]); app.rebuildUserBedGrid();
      app.run("depoGrid.fill(0); deposited = []; restartFlow(false); initParticles(false); model.bedChanged()");
      for (let k = 0; k < 300; k++) app.draw();
      return app.run("depoGrid.reduce((a, b) => a + b, 0)");
    };
    const d0 = grow(0), d3 = grow(3);
    check(f0 === 1 && Math.abs(f3 - Math.pow(4, -0.6)) < 1e-12 && d3 > 1.15 * d0, "friction makes more of the sediment settle over a drawn bed",
      `near-bed factor ${f0} -> ${f3.toFixed(3)} at friction 3; deposit after 300 frames ${d0.toFixed(0)} -> ${d3.toFixed(0)}`);
    app.setFriction(0);
    app.setBedPoints(savedBed); app.rebuildUserBedGrid();
    app.run("depoGrid.fill(0); deposited = []; restartFlow(false); model.bedChanged()");
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
    const rest = app.run("[mac.uF, mac.vF, mac.p].every(a => a.every(x => x === 0)) && u.every(x => x === 0) && v.every(x => x === 0) && mac.store === 0");
    check(rest, "restarting the flow (R) clears the solver's own fields", rest ? "u, v, the faces, the pressure and any pond all zero" : "something kept its values");
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

  // ---------------------------------------------------------------- reset puts every physics slider back
  {
    app.run("friction = 2; fricPaint = 2.5; fricRadius = 120");
    app.run("document.getElementById('reset-physics')").dispatchEvent({ type: "click" });
    const r = app.run("[friction, fricPaint, fricRadius]");
    check(r[0] === 0 && r[1] === 1 && r[2] === 40, "the physics reset puts friction and the brush back too", `friction ${r[0]}, zone mu ${r[1]}, brush r ${r[2]}`);
  }

  // ---------------------------------------------------------------- still water
  // The well-balanced question: on a sloping bed with no inflow, should anything move? No.
  // The bed enters the flow as depth in div(h u) = 0 and nothing else, so it cannot move
  // still water (9a).
  //
  // 9b used to measure the motion the collocated solver left with the inflow shut: it neither
  // decayed nor grew (mean 0.08-0.17, max 0.7-1.0, held to 0.30 and 1.50; notes of
  // 2026-10-28 and 2026-11-13 in git history). It came from the projection, which never drove
  // the divergence to zero. The staggered solver does, so with the inflow shut a running river
  // now comes to rest: the through-flow stops at once and what is left turning about decays,
  // slowly, since little but the drag of narrow openings and diffusion takes it out. Measured
  // 2026-11-18 from a developed flow over this bed: mean 0.23 after 120 steps, 0.17 after
  // 360, 0.095 after 1200. The check asks that it decays (the mean at least halves from 120 to
  // 1200 steps) and holds the 1200-step mean to twice the measured value, the rule as before.
  const STILL_TOL_MEAN = 0.19;
  const STILL_TOL_MAX  = 0.70;
  {
    const U = S().U, V = S().V;
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
    for (let k = 0; k < 150; k++) app.velocityStep();   // a developed flow over the bed
    const keep = app.run("[u.slice(), v.slice()]");
    app.setInflow(0);
    // 9a. From true rest nothing may move.
    {
      app.run("u.fill(0); v.fill(0)");
      for (let k = 0; k < 600; k++) app.velocityStep();
      const r = sample();
      check(app.run("depthGrid") !== null && r.max < 1e-9,
            "still water over a sloping bed stays still", `max |u|+|v| ${r.max.toExponential(1)} after 600 steps, bed in the solver: ${app.run("depthGrid") !== null}`);
    }
    // 9b. From the developed flow, with the inflow shut.
    globalThis.__keep = keep;
    app.run("u.set(globalThis.__keep[0]); v.set(globalThis.__keep[1])");
    const marks = [120, 360, 1200];
    const out = [], means = [];
    let done = 0;
    for (const m of marks) {
      while (done < m) { app.velocityStep(); done++; }
      const r = sample();
      means.push(r.mean);
      out.push(`n=${m}: max ${r.max.toExponential(2)} mean ${r.mean.toExponential(2)}`);
    }
    const s = sample();
    check(isFinite(s.max) && means[2] <= 0.5 * means[0] && means[1] <= means[0] && s.mean <= STILL_TOL_MEAN && s.max <= STILL_TOL_MAX,
          "with the inflow shut the water slows toward rest",
          `${out.join(" | ")} (tol at 1200: mean ${STILL_TOL_MEAN}, max ${STILL_TOL_MAX})`);
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
      app.run("u.fill(inflowVel); v.fill(0)");
      for (let k = 0; k < 500; k++) app.velocityStep();
      const m = new Float64Array(st0.U.length), n = 60;
      for (let k = 0; k < n; k++) { app.velocityStep(); const U = S().U; for (let q = 0; q < m.length; q++) m[q] += U[q] / n; }
      return m;
    };
    const col = (m, i) => { let a = 0; for (let j = 1; j <= NY; j++) a += m[IXf(i, j)]; return a / NY; };

    const flat = runMean([]);
    check(app.run("depthGrid") === null && Math.abs(col(flat, NX >> 1) - 2.5) < 0.01,
          "with no bed drawn every depth is 1 and the channel runs at the inflow speed", `mid-channel u ${col(flat, NX >> 1).toFixed(3)}`);

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
            "clearing the deposit returns the solver to a flat bed", `mid-channel u ${col(cleared, NX >> 1).toFixed(3)}`);
    }

    app.setBedPoints(savedBed); app.run("bedXSections = globalThis.__xs", (globalThis.__xs = savedXS)); app.rebuildUserBedGrid();
    app.setObstacles(savedObs); app.run("solidMaskDirty = true");
  }

  // ---------------------------------------------------------------- the staggered solver conserves water at obstacles
  // The collocated solver this replaced lost or made water at obstacles (2026-11-17 stress
  // test, items 5, 20, 21): a gap in a wall passed 12-45% of the flow, the flow behind a wide
  // wall was up to 170% of the inflow, a wall dropped into running water left 45-66% flowing
  // behind it, and under friction the plain projection lost 99.9% of the discharge by the
  // outflow. The MAC solver carries the normal velocity on faces and solves div(h u) = 0 to a
  // residual, so the discharge through every column of faces is the inflow's, less what a
  // dammed pond stores. The collocated solver failed checks 1-3 (dev/MAC-GRID.md).
  //
  // Discharge here is the sum of h * u over a column of faces (mac.hU, mac.uF), and also over
  // a column of cells (depthGrid, u), which is what the stress test measured and what the
  // particles see. The tolerance is 0.5% of the inflow's discharge: measured spread is 0.001%
  // on faces and 0.1% on cells (where the depth is taken at the centre, not on the face).
  {
    const st0 = S(), NX = st0.NX, NY = st0.NY, IXf = (i, j) => i + j * (NX + 2);
    const keep = { obs: app.run("JSON.stringify(obstacles)"), bed: st0.bedPoints,
                   xs: app.run("bedXSections"), fric: app.run("friction"), inflow: st0.inflowVel };
    const clips = [{ start: 0, dur: 1e9 }];
    const setScene = (obs, bed, fric) => {
      app.run(`obstacles = ${JSON.stringify(obs)}; buildSolidMask(); solidMaskDirty = false;
               bedXSections = []; depoGrid.fill(0); friction = ${fric}; fricGrid = null; fricDirty = true; inflowVel = 2.5;
               restartFlow(false); simTime = 6.4`);
      app.setBedPoints(bed); app.rebuildUserBedGrid();
    };
    const steps = (n) => { for (let k = 0; k < n; k++) app.run("simTime += DT; model.step()"); };
    const faceQ = (i) => app.run(`(() => { let s = 0; for (let j = 1; j <= NY; j++) { let c = IX(${i}, j); s += mac.hU[c] * mac.uF[c]; } return s; })()`);
    const cellQ = (i) => { const U = S().U, sol = S().solid, Hg = app.run("depthGrid"); let s = 0; for (let j = 1; j <= NY; j++) { const c = IXf(i, j); if (!sol[c]) s += (Hg ? Hg[c] : 1) * U[c]; } return s; };
    const wallCol = () => { const sol = S().solid; let best = 0, bi = 0; for (let i = 1; i <= NX; i++) { let n = 0; for (let j = 1; j <= NY; j++) if (sol[IXf(i, j)]) n++; if (n > best) { best = n; bi = i; } } return [bi, NY - best]; };
    const spread = (qs, q0) => Math.max(...qs.map(q => Math.abs(q / q0 - 1)));
    const bedPts = [{ x: 150, z: 10 }, { x: 600, z: 120 }, { x: 1000, z: 20 }].map(p => ({ x: p.x * st0.width / 1200, z: p.z }));
    const gapWall = { type: "rect", x: st0.width * 0.5, y: st0.height * 0.45, w: 40, h: st0.height * 0.875, rotation: 0, clips };

    // 1. A gap in a wall passes all the water, plain and over a drawn bed.
    for (const [label, bed] of [["", []], [" over a drawn bed", bedPts]]) {
      setScene([gapWall], bed, 0);
      steps(150);
      const [wc, open] = wallCol(), q0 = faceQ(0);
      const fq = [15, wc, wc + 2, 100, 140, NX].map(faceQ), cq = [15, wc, 140].map(cellQ);
      const ok = open > 0 && open < NY / 4 && spread(fq, q0) < 0.005 && spread(cq, q0) < 0.005;
      check(ok, "MAC: a gap in a wall passes all the inflow" + label,
        `${open} rows open at column ${wc}; faces ${fq.map(q => (100 * q / q0).toFixed(2)).join(", ")}% and cells upstream, at the gap, downstream ${cq.map(q => (100 * q / q0).toFixed(1)).join(", ")}% of the inflow ${q0.toFixed(1)}`);
    }

    // 2. A wall dropped into running water, across part of the channel: the flow behind it is
    // the inflow's from the first step after.
    {
      setScene([], bedPts, 0);
      steps(150);
      app.run(`obstacles = ${JSON.stringify([gapWall])}; solidMaskDirty = true; buildSolidMask(); solidMaskDirty = false`);
      steps(1);
      const qGap = [15, wallCol()[0], 100, 140].map(faceQ), q0g = faceQ(0);
      check(spread(qGap, q0g) < 0.005, "MAC: a wall dropped into running water conserves the flow at once",
        `gap wall, one step after: ${qGap.map(q => (100 * q / q0g).toFixed(2)).join(", ")}% of the inflow upstream, at the gap, behind`);
    }

    // 2b. Across all of it, the wall is a dam (Brad, 2026-11-18: spill over when enough water
    // or sediment has built up). The inflow is stored as a pond whose level rises; nothing
    // passes until the level reaches the crest, WALL_FREEBOARD above the river; then the wall
    // spills as a weir. Water is conserved throughout: inflow = what the pond stores + what
    // goes downstream.
    {
      const fullWall = { ...gapWall, h: st0.height * 3 };
      setScene([], [], 0);
      steps(150);
      app.run(`obstacles = ${JSON.stringify([fullWall])}; buildSolidMask(); solidMaskDirty = false`);
      steps(1);
      const pond = app.run("[mac.nPond, mac.weirWidth, WALL_FREEBOARD, MAC_ADV]");
      const qIn = app.run("mac.qIn");
      // Steps until the level reaches the crest, from the pond's area and the inflow.
      const fillSteps = Math.ceil(pond[2] * pond[0] / (qIn * pond[3]));
      steps(Math.max(1, fillSteps - 3));
      const before = [app.run("mac.spilling"), Math.max(...[100, 140, NX].map(i => Math.abs(faceQ(i))))];
      steps(40);
      const after = app.run("[mac.spilling, mac.head, mac.qSpill, mac.qIn, mac.level]");
      const down = [100, 140, NX].map(faceQ);
      // The pond stores qIn - qSpill each step; downstream carries qSpill.
      const okFill = !before[0] && before[1] < 0.005 * qIn;
      const okSpill = after[0] && after[2] > 0 && spread(down, after[2]) < 0.01;
      check(pond[0] > 0 && okFill && okSpill, "MAC: a wall across the whole channel holds the river until the pond reaches its crest, then spills",
        `pond ${pond[0]} cells, crest ${pond[1]} cells long; ${fillSteps - 3} steps in (crest due at ${fillSteps}): spilling ${before[0]}, largest discharge behind ${before[1].toExponential(1)}; 40 steps later: head ${after[1].toFixed(3)}, spill ${after[2].toFixed(1)} of ${after[3].toFixed(1)}, discharge behind ${down.map(q => q.toFixed(1)).join(", ")}`);
      // Long after, the spill carries the whole inflow (the pond has stopped rising).
      steps(1500);
      const late = app.run("[mac.qSpill, mac.qIn, mac.head]"), downL = [100, NX].map(faceQ);
      check(Math.abs(late[0] / late[1] - 1) < 0.02 && spread(downL, late[1]) < 0.03,
        "MAC: a spilling dam settles to passing all the inflow over its crest",
        `after 1500 more steps: spill ${late[0].toFixed(1)} of an inflow of ${late[1].toFixed(1)}, head over the crest ${late[2].toFixed(3)} (weir law ${((late[1] / (app.run("WEIR_C") * pond[1])) ** (2 / 3)).toFixed(3)}); discharge behind ${downL.map(q => q.toFixed(1)).join(", ")}`);
      // Grains go over a spilling crest instead of bouncing off it. One grain, one frame: the
      // turbulent spread is switched off for it, since one random step can outweigh a frame's
      // drift.
      const g = app.run(`(() => { const pass = model.passable; if (!pass) return null; const e0 = SPREAD_E; SPREAD_E = 0;
        let c = -1; for (let k = 0; k < pass.length; k++) if (pass[k]) { c = k; break; }
        const W = NX + 2, i = c % W, j = (c - i) / W, x = (i + 0.5) * cellW, y = (j + 0.5) * cellH;
        const keepP = particles; particles = [{ x, y, vx: 0, vy: 0, born: simTime }];
        updateParticles(); const p = particles[0]; particles = keepP; SPREAD_E = e0;
        return [x, y, p ? p.x : null, p ? p.y : null, getVelocityAt(x, y).vx]; })()`);
      check(g && g[2] !== null && g[2] > g[0] && Math.abs(g[3] - g[1]) < 2 && g[4] > 0,
        "MAC: grains cross a spilling crest with the water",
        g ? `grain on the crest at ${g[0].toFixed(0)},${g[1].toFixed(0)} moved to ${g[2] === null ? 'gone' : g[2].toFixed(1) + ',' + g[3].toFixed(1)}; water there ${g[4].toFixed(1)} px/frame` : "nothing passable");
      // Sediment settling in the pond takes up room: the level rises by its volume.
      setScene([], [], 0);
      app.run(`obstacles = ${JSON.stringify([fullWall])}; buildSolidMask(); solidMaskDirty = false`);
      steps(2);
      const l0 = app.run("mac.level"), s0 = app.run("mac.store");
      app.run("for (let y = 2; y < height; y += 4) for (let x = cellW * 3; x < width * 0.4; x += 4) addDeposit(x, y, 20); model.bedChanged()");
      steps(1);
      const r = app.run(`(() => { let sed = 0; for (let k = 0; k < mac.nPond; k++) { let c = mac.pondCells[k]; sed += mac.h0[c] - depthGrid[c]; } return [mac.level, mac.store, sed / mac.nPond]; })()`);
      const want = r[1] / pond[0] + r[2];
      check(r[2] > 0.005 && Math.abs(r[0] - want) < 1e-9 && r[0] > l0 + r[2] * 0.99,
        "MAC: sediment settling in a pond lifts its level",
        `level ${l0.toFixed(4)} -> ${r[0].toFixed(4)}, of which sediment ${r[2].toFixed(4)} and water ${(r[1] / pond[0]).toFixed(4)}`);
      app.run("depoGrid.fill(0); model.bedChanged()");
    }

    // 2c. A narrow opening loses head (K_OPEN), so less of the river goes through a slot. The
    // scene is the stress test's R8: a wall leaving a 2-row slot at the bank and a 24-row
    // gap. Potential flow (dev/mac-grid/potential.py) puts 22% of the discharge through the
    // slot, and the solver at the old advection scale gave 21%. At the particles' scale
    // (MAC_ADV) diffusion counts for more and the slot carries 8%; the head loss takes that
    // to 7%. The check runs the scene with K_OPEN and without, from the same start.
    {
      const H0 = st0.height, rowsPx = H0 / NY;
      const slotWall = [{ type: "rect", x: st0.width * 0.45, y: rowsPx * 2 + (H0 * 0.5 - rowsPx * 2) / 2, w: 40, h: H0 * 0.5 - rowsPx * 2, rotation: 0, clips },
                        { type: "rect", x: st0.width * 0.45, y: H0 * 0.5 + rowsPx * 24 + (H0 * 0.5 - rowsPx * 24) / 2, w: 40, h: H0 * 0.5 - rowsPx * 24, rotation: 0, clips }];
      const share = () => app.run(`(() => { const sol = solid; let i = 0, best = 0; for (let q = 1; q <= NX; q++) { let n = 0; for (let j = 1; j <= NY; j++) if (sol[IX(q, j)]) n++; if (n > best) { best = n; i = q; } }
        let runs = [], cur = null; for (let j = 1; j <= NY; j++) { const c = IX(i, j); if (!sol[c]) { if (!cur) { cur = { j0: j, q: 0 }; runs.push(cur); } cur.q += mac.hU[c] * mac.uF[c]; } else cur = null; }
        const tot = runs.reduce((a, b) => a + b.q, 0); return [runs.length, runs.length ? runs[0].q / tot : NaN]; })()`);
      const k = app.run("K_OPEN");
      setScene(slotWall, [], 0); steps(300);
      const withLoss = share();
      app.run("K_OPEN = 0");
      setScene(slotWall, [], 0); steps(300);
      const without = share();
      app.run(`K_OPEN = ${k}`);
      check(withLoss[0] === 2 && without[0] === 2 && k > 0 && withLoss[1] < 0.9 * without[1], "MAC: a narrow slot loses head and carries less of the river",
        `the 2-row slot carries ${(100 * withLoss[1]).toFixed(1)}% of the flow with the head loss (K_OPEN ${k}), ${(100 * without[1]).toFixed(1)}% without (inviscid 22%)`);
    }

    // 2d. Object heights (Brad, 2026-11-18). A wall across the whole channel whose top is
    // under the water is a sill: not solid, raised bed, so the river goes over it with all of
    // its water and speeds up by the depth ratio, and grains cross it. Half the depth here.
    {
      const sill = { ...gapWall, h: st0.height * 3, w: 60, top: -1.0 };
      setScene([sill], [], 0);
      steps(150);
      const ic = Math.round(sill.x / st0.cellW), Hd = app.run("depthGrid");
      const solidN = app.run(`(() => { let n = 0; for (let k = 0; k < solid.length; k++) n += solid[k]; return n; })()`);
      const q = [15, ic, 140, NX].map(faceQ), q0 = faceQ(0);
      const uOver = app.run(`(() => { let a = 0; for (let j = 5; j <= NY - 5; j++) a += u[IX(${ic}, j)]; return a / (NY - 9); })()`);
      const uUp = app.run(`(() => { let a = 0; for (let j = 5; j <= NY - 5; j++) a += u[IX(15, j)]; return a / (NY - 9); })()`);
      const want = Hd ? Hd[IXf(15, NY >> 1)] / Hd[IXf(ic, NY >> 1)] : NaN;
      check(solidN === 0 && Hd && Math.abs(Hd[IXf(ic, NY >> 1)] - 0.5) < 1e-6 && spread(q, q0) < 0.005 && Math.abs(uOver / uUp / want - 1) < 0.05,
        "MAC: an object with its top under the water is a sill the river flows over",
        `top -1.0 m: ${solidN} solid cells, depth over it ${Hd ? Hd[IXf(ic, NY >> 1)].toFixed(3) : 'none'}; discharge ${q.map(x => (100 * x / q0).toFixed(2)).join(", ")}% of the inflow; speed over it ${(uOver / uUp).toFixed(3)} times upstream, depth ratio ${want.toFixed(3)}`);
    }
    // A dam of two walls, the upper half 0.2 m above the water and the lower 1.5 m, at the
    // lowest inflow (0.5): once the pond passes 0.2 m it spills over the low half only, and
    // settles where that half alone passes the inflow. (At the default inflow the head that
    // half needs, over 3 m, tops the tall half too, and both spill.)
    {
      const H0 = st0.height, wall = (y, h, top) => ({ type: "rect", x: st0.width * 0.5, y, w: 40, h, rotation: 0, clips, top });
      setScene([wall(H0 * 0.25 - 20, H0 * 0.5 + 40, 0.2), wall(H0 * 0.75 + 20, H0 * 0.5 + 40, 1.5)], [], 0);
      app.run("inflowVel = 0.5");
      steps(2500);
      const r = app.run(`(() => { const M = mac, W = NX + 2; let lo = 0, hi = 0, nLo = 0;
        for (let f = 0; f < M.weirWidth; f++) if (M.weirFb[f] < 0.2) nLo++;
        let i = 0, best = 0; for (let q = 1; q <= NX; q++) { let n = 0; for (let j = 1; j <= NY; j++) if (solid[IX(q, j)]) n++; if (n > best) { best = n; i = q; } }
        for (let j = 1; j <= NY; j++) { const c = IX(i, j), q = M.hU[c] * M.uF[c]; if (j <= NY / 2) lo += q; else hi += q; }
        return [M.spilling, M.level, M.qSpill, M.qIn, lo, hi, nLo]; })()`);
      const lvl = 0.1 + Math.pow(r[3] / (app.run("WEIR_C") * r[6]), 2 / 3);
      check(r[0] && Math.abs(r[2] / r[3] - 1) < 0.02 && Math.abs(r[5]) < 0.005 * r[3] && Math.abs(r[4] / r[3] - 1) < 0.02 && Math.abs(r[1] - lvl) < 0.01,
        "MAC: a dam spills over its lowest wall, by the weir law for that wall alone",
        `level ${r[1].toFixed(3)} (weir law over the ${r[6]} faces of the 0.2 m wall: ${lvl.toFixed(3)}); spill ${r[2].toFixed(1)} of ${r[3].toFixed(1)}; over the low half ${(100 * r[4] / r[3]).toFixed(1)}%, the high half ${(100 * r[5] / r[3]).toFixed(2)}%`);
    }

    // 3. No face that touches a solid cell carries water, and every connected cell has
    // div(h u) within the solver tolerance.
    {
      setScene([{ type: "circle", x: st0.width * 0.3, y: st0.height * 0.4, w: 90, h: 90, rotation: 0, clips },
                { type: "rect", x: st0.width * 0.6, y: st0.height * 0.6, w: 120, h: 50, rotation: 35, clips }], bedPts, 1);
      steps(100);
      const r = app.run(`(() => { const M = mac, W = NX + 2; let leak = 0, div = 0;
        for (let j = 1; j <= NY; j++) for (let i = 0; i <= NX; i++) { let c = IX(i, j);
          let a = i >= 1 && solid[c], b = i < NX && solid[c + 1]; if ((a || b) && M.uF[c] !== 0) leak++; }
        for (let j = 0; j <= NY; j++) for (let i = 1; i <= NX; i++) { let c = IX(i, j);
          let a = j >= 1 && solid[c], b = j < NY && solid[c + W]; if ((a || b || j === 0 || j === NY) && M.vF[c] !== 0) leak++; }
        return [leak, M.nCells]; })()`);
      // Friction acts before the solve, so the divergence after it is the solver's own.
      steps(1);
      const d = app.run(`(() => { const M = mac, W = NX + 2; let mx = 0; for (let k = 0; k < M.nCells; k++) { let c = M.cells[k];
        let q = M.hU[c] * M.uF[c] - M.hU[c-1] * M.uF[c-1] + M.hV[c] * M.vF[c] - M.hV[c-W] * M.vF[c-W]; mx = Math.max(mx, Math.abs(q)); } return mx; })()`);
      const tol = app.run("MAC_TOL");
      check(r[0] === 0 && d <= tol * 1.0001, "MAC: no face into a solid carries water, and div(h u) is solved away in every cell",
        `${r[0]} faces against a solid carry water; largest |div(h u)| ${d.toExponential(2)} over ${r[1]} cells (tolerance ${tol})`);
    }

    // 4. Friction does not drain the channel: the discharge is the same at every column
    // whatever its value; the collocated solver's plain projection lost 99.9% of it by the
    // outflow at friction 3.
    {
      setScene([], [], 3);
      steps(13);    // about one second, when the plain projection was worst
      const q = [5, 40, 80, 120, 155].map(cellQ);
      check(spread(q, q[0]) < 0.005, "MAC: friction does not drain the river along the channel",
        `friction 3, one second from rest: discharge at columns 5, 40, 80, 120, 155 is ${q.map(x => x.toFixed(1)).join(", ")}`);
    }

    // 5. Rough ground turns the water aside. A patch painted across the middle third of the
    // channel: less of the river goes through it than through the same rows unpainted, and the
    // column still carries all of it.
    {
      const rows = (i) => app.run(`(() => { let a = 0, t = 0; for (let j = 1; j <= NY; j++) { let c = IX(${i}, j), q = mac.hU[c] * mac.uF[c]; t += q; if (j > NY / 3 && j <= 2 * NY / 3) a += q; } return [a / t, t]; })()`);
      setScene([], [], 0);
      steps(100);
      const ic = NX >> 1, plain = rows(ic);
      app.run("ensureFricGrid(); fricGrid.fill(0); for (let y = height / 3; y <= 2 * height / 3; y += 10) for (let x = width * 0.4; x <= width * 0.6; x += 10) { fricPaint = 3; fricRadius = 20; paintFriction(x, y, 1); } fricPaint = 1; fricRadius = 40");
      steps(100);
      const rough = rows(ic), q0 = faceQ(0);
      check(rough[0] < plain[0] - 0.02 && Math.abs(rough[1] / q0 - 1) < 0.005, "MAC: painted roughness turns the water aside without losing any",
        `the middle third of the channel carries ${(100 * plain[0]).toFixed(1)}% of the river, ${(100 * rough[0]).toFixed(1)}% when painted rough; the column carries ${(100 * rough[1] / q0).toFixed(2)}% of the inflow`);
      app.run("fricGrid.fill(0); fricDirty = true; redrawFricBuffer()");
    }

    app.run(`obstacles = ${keep.obs}; buildSolidMask(); solidMaskDirty = true; depoGrid.fill(0); friction = ${keep.fric}; fricDirty = true; inflowVel = ${keep.inflow}; restartFlow(false)`);
    app.setBedPoints(keep.bed); app.run("bedXSections = globalThis.__xs", (globalThis.__xs = keep.xs)); app.rebuildUserBedGrid();
    for (let k = 0; k < 80; k++) app.run("simTime += DT; model.step()");
  }
};
