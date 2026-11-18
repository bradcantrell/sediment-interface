// Checks for this site's backend (site.js: the OpenFOAM case export).
// Called by dev/headless_harness.js, which is shared with every repo that uses the interface.
const path = require("path");

module.exports = function ({ app, S, check, ROOT }) {
  const ids = app.run("backends.map(b => b.id)");
  const slot = app.run("document.getElementById('site-slot')");
  check(ids.includes("export") && /id="export-btn"/.test(slot.innerHTML),
        "the export backend is registered and mounts its button", `backends: ${ids.join(", ")}`);

  // The real case generator must accept what sceneState() hands it, obstacles and bed alike.
  const gen = require(path.join(ROOT, "bridge", "case_generator.js"));
  app.setObstacles([{ type: "circle", x: 300, y: 200, w: 50, h: 50, size: 50, rotation: 0, clips: [{ start: 0, dur: Infinity }] },
                    { type: "rect", x: 600, y: 300, w: 80, h: 30, size: 80, rotation: 20, clips: [{ start: 0, dur: Infinity }] }]);
  let out = null, threw = null;
  // As the export button does it: the scene travels in the case as scene.json.
  try { out = gen.generateCase(app.run("exportCaseState()")); } catch (e) { threw = e; }
  const paths = out ? out.files.map(f => f.path) : [];
  check(!threw && out.meta.nObstacles === 2 && out.meta.hasBed === (S().bedPoints.length >= 2) &&
        paths.some(p => /blockMeshDict$/.test(p)) && paths.some(p => /snappyHexMeshDict$/.test(p)),
        "the case generator builds a case from sceneState()",
        threw ? threw.message : `${out.meta.nObstacles} obstacles, bed ${out.meta.hasBed}, ${paths.length} files`);
  // The steps shown after an export must not name a file the case does not contain. They
  // once told the user to run apply_bed.py, which was never in the case.
  if (out) {
    const named = (hint) => (hint.match(/[\w.\/-]+\.(?:py|sh|stl|json)\b|\bAllrun\b/g) || []);
    const missing = [];
    for (const hasBed of [false, true]) {
      const hint = app.run(`exportRunHint({ hasBed: ${hasBed} })`);
      for (const f of named(hint)) {
        // a bed file can only be expected of a case that has a bed
        if (hasBed && !out.meta.hasBed && /bed/.test(f)) continue;
        if (!paths.some(p => p === f || p.endsWith("/" + f))) missing.push(f);
      }
    }
    const hintBed = app.run("exportRunHint({ hasBed: true })");
    check(missing.length === 0 && /snappyHexMesh/.test(hintBed) && /foamRun/.test(hintBed),
          "the steps shown after an export name only files the case contains",
          missing.length ? `not in the case: ${missing.join(", ")}` : hintBed);
  }
  // What the export button packs: the case, one script that runs it, and the scene itself.
  // The scene in the ZIP must be one the interface opens again.
  {
    const packed = gen.generateCase(app.run("exportCaseState()"));
    const zipBytes = gen.buildZip(packed.files);
    const found = app.run("findSceneInZip")(new Uint8Array(zipBytes));
    const text = found && found.method === 0 ? Buffer.from(found.data).toString() : "";
    const opens = text ? app.run("checkSceneText")(text) : { ok: false, why: "no scene.json in the ZIP" };
    const allrun = (packed.files.find(f => f.path === "Allrun") || {}).content || "";
    const readme = (packed.files.find(f => f.path === "README.md") || {}).content || "";
    const steps = ["blockMesh", "snappyHexMesh -overwrite", "foamRun -solver incompressibleFluid"];
    check(opens.ok && opens.scene.obstacles.length === 2 && steps.every(x => allrun.includes("step " + x) && readme.includes(x)) &&
          /sh Allrun/.test(readme) && /scene\.json/.test(readme),
          "the exported ZIP holds a run script with the README's steps and a scene the interface opens again",
          opens.ok ? `scene.json ${text.length} bytes, ${opens.scene.obstacles.length} obstacles; Allrun ${allrun.split("\n").length - 1} lines` : opens.why);
  }
  // ---------------------------------------------------------------- the case has the scene's geometry
  // Built straight from a scene on a canvas that is not the reference 1280 x 577. Each of these
  // was wrong until the 2026-11-17 stress test: obstacles placed at the reference scale, the
  // bed mirrored top to bottom, rotated rectangles mirrored, the mesh seed point fixed at the
  // centre, the deposit read from the corner of an image, one cross-section held to both ends.
  {
    const W = 1650, H = 950, inf = [{ start: 0, dur: Infinity }];
    const verts = (stl) => (stl.match(/vertex\s+\S+\s+\S+\s+\S+/g) || []).map(v => v.split(/\s+/).slice(1).map(Number));
    const file = (c, p) => (c.files.find(f => f.path === p) || {}).content || "";
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    const base = { width: W, height: H, bed_profile: [], bed_xsections: [], inflow: 2.5 };
    const s = 12.8 / W, dh = H * s;

    // a circle at the canvas centre and a rectangle rotated 30 deg low on the canvas
    const c1 = gen.generateCase(Object.assign({}, base, { obstacles: [
      { type: "circle", x: W / 2, y: H / 2, w: 100, h: 100, rotation: 0, clips: inf },
      { type: "rect", x: 400, y: 800, w: 200, h: 40, rotation: 30, clips: inf }] }));
    const circ = verts(file(c1, "constant/triSurface/obstacle0.stl"));
    // the bounding box: the caps are fans from one rim vertex, so a vertex mean leans that way
    const bx = circ.map(v => v[0]), by = circ.map(v => v[1]);
    const cx = (Math.min(...bx) + Math.max(...bx)) / 2, cy = (Math.min(...by) + Math.max(...by)) / 2;
    const rmax = (Math.max(...bx) - Math.min(...bx)) / 2;
    check(near(cx, 6.4, 0.01) && near(cy, dh / 2, 0.01) && near(rmax, 50 * s, 0.005) && near(c1.meta.domainH, dh, 1e-9),
          "obstacles land where they are drawn at any canvas size",
          `centre (${cx.toFixed(3)}, ${cy.toFixed(3)}) m, want (6.400, ${(dh / 2).toFixed(3)}); radius ${rmax.toFixed(3)}, want ${(50 * s).toFixed(3)}; domain ${c1.meta.domainW} x ${c1.meta.domainH.toFixed(3)} m`);
    // the rectangle's corners, worked out from the app's own rotation (buildSolidMask)
    const a = 30 * Math.PI / 180, want = [[-100, -20], [100, -20], [100, 20], [-100, 20]].map(([lx, ly]) =>
      [(400 + lx * Math.cos(a) - ly * Math.sin(a)) * s, (H - (800 + lx * Math.sin(a) + ly * Math.cos(a))) * s]);
    const rv = verts(file(c1, "constant/triSurface/obstacle1.stl"));
    const worst = Math.max(...want.map(w => Math.min(...rv.map(v => Math.hypot(v[0] - w[0], v[1] - w[1])))));
    check(worst < 1e-3, "a rotated rectangle is exported turned the way it is drawn", `furthest corner ${worst.toFixed(4)} m from where the page has it`);

    // the mesh seed point is never inside an obstacle; a closed channel fails the export
    const loc = c1.meta.locationInMesh;
    const lx = loc[0] / s, ly = H - loc[1] / s;
    const inCircle = Math.hypot(lx - W / 2, ly - H / 2) < 50;
    const snappy = file(c1, "system/snappyHexMeshDict");
    let closedThrew = false;
    try { gen.generateCase(Object.assign({}, base, { obstacles: [{ type: "rect", x: W / 2, y: H / 2, w: W * 1.2, h: H * 1.2, rotation: 0, clips: inf }] })); }
    catch (e) { closedThrew = /clear/.test(e.message); }
    const allrun = file(c1, "Allrun");
    check(!inCircle && snappy.includes("locationInMesh (" + loc[0].toFixed(4)) && closedThrew && /constant\/polyMesh\/boundary/.test(allrun),
          "the mesh starts from a point clear of the obstacles, and Allrun stops without an inlet",
          `seed at canvas (${lx.toFixed(0)}, ${ly.toFixed(0)}) px; a channel-filling block ${closedThrew ? "fails the export" : "does not fail"}`);

    // the bed: a bank along the top of the canvas, drawn at one of two stations
    const st = { bed_profile: [{ x: 400, z: 20 }, { x: 1200, z: 20 }],
                 bed_xsections: [{ x: 400, points: [{ y: 0, z: 100 }, { y: 300, z: 0 }, { y: H, z: 0 }] }] };
    const bed = gen.sceneBedHeights(Object.assign({}, base, st), gen.domainFor(W, H));
    const ny = bed.length, nx = bed[0].length, m = 0.5 / 160;
    const at = (xPx, yPx) => bed[Math.round((H - yPx) / H * (ny - 1))][Math.round(xPx / W * (nx - 1))] / m;  // back in bed units
    const topAt400 = at(400, 0), botAt400 = at(400, H), at1200 = at(1200, 0), mid = at(800, 0);
    check(near(topAt400, 120, 3) && near(botAt400, 20, 1) && near(at1200, 20, 1) && near(mid, 70, 4),
          "the bed comes out the right way up, and a single cross-section fades to the next station",
          `station 400: top ${topAt400.toFixed(0)}, bottom ${botAt400.toFixed(0)} (want 120, 20); top at 800 ${mid.toFixed(0)} (want 70); at 1200 ${at1200.toFixed(0)} (want 20)`);

    // the deposit: a mound in the middle of the river, no bed drawn
    const gw = Math.ceil(W / 4), gh = Math.ceil(H / 4), grid = new Array(gw * gh).fill(0);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const d = Math.hypot((i + 0.5) * 4 - W / 2, (j + 0.5) * 4 - H / 2); if (d < 60) grid[j * gw + i] = 40;
    }
    const c2 = gen.generateCase(Object.assign({}, base, { obstacles: [], deposit: { grid, gw, gh, cell: 4 } }));
    const bed2 = gen.sceneBedHeights(Object.assign({}, base, { deposit: { grid, gw, gh, cell: 4 } }), gen.domainFor(W, H));
    const peak = bed2[Math.round((ny - 1) / 2)][Math.round((nx - 1) / 2)], corner = bed2[ny - 1][0];
    // every field names the bed patch (without it foamRun stopped at its first read)
    const fieldsNameBed = ["0/U", "0/p", "0/k", "0/epsilon", "0/nut"].every(f => /\n\s*bed\s*\n\s*\{/.test(file(c2, f)));
    check(fieldsNameBed, "every field has an entry for the bed patch", fieldsNameBed ? "U, p, k, epsilon, nut" : "missing in some field");
    check(c2.meta.hasBed && file(c2, "constant/triSurface/bed.stl").length > 0 && near(peak, 40 * m, 0.002) && corner === 0,
          "a deposit is exported where it lies, with no bed drawn",
          `hasBed ${c2.meta.hasBed}; centre ${peak.toFixed(4)} m (want ${(40 * m).toFixed(4)}), corner ${corner}`);

    // the reference canvas still gives the reference case
    const ref = gen.generateCase(Object.assign({}, base, { width: 1280, height: 577, obstacles: [] }));
    check(ref.meta.ny === 110 && near(ref.meta.domainH, 5.77, 1e-9) && /\(12\.8000 5\.7700 0\)/.test(file(ref, "system/blockMeshDict")),
          "the reference canvas still gives the 12.8 x 5.77 m, 200 x 110 cell case", `${ref.meta.domainW} x ${ref.meta.domainH} m, ${ref.meta.nx} x ${ref.meta.ny}`);

    // Each object is carved to its own top (Brad, 2026-11-18): one under the water stops there,
    // so OpenFOAM's water flows over it; one above it still goes through the lid. An object
    // with no top (an older scene) goes through, as before.
    const tops = gen.generateCase(Object.assign({}, base, { obstacles: [
      { type: "circle", x: 300, y: 200, w: 50, h: 50, size: 50, rotation: 0, top: -1.2 },
      { type: "rect", x: 600, y: 300, w: 80, h: 30, size: 80, rotation: 0, top: 0.5 },
      { type: "rect", x: 900, y: 300, w: 80, h: 30, size: 80, rotation: 0 }] }));
    const zTop = (i) => Math.max(...[...file(tops, `constant/triSurface/obstacle${i}.stl`).matchAll(/vertex\s+\S+\s+\S+\s+(\S+)/g)].map(m => +m[1]));
    const z = [0, 1, 2].map(zTop);
    check(near(z[0], 0.8, 1e-6) && near(z[1], 2.005, 1e-6) && near(z[2], 2.005, 1e-6),
          "the export carves each object to its top", `tops -1.2 m, +0.5 m and none: highest point ${z.map(v => v.toFixed(3)).join(", ")} m in a 2 m channel`);
  }

  app.setObstacles([]);
  app.run("solidMaskDirty = true");
};
