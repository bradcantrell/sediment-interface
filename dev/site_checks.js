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
  app.setObstacles([]);
  app.run("solidMaskDirty = true");
};
