// site.js for the public Sediment Interface: the OpenFOAM case export.
//
// index.html is the shared interface and is the same file in every repo that uses it. This
// file is what this repo does with the drawn scene: it packs it into a runnable OpenFOAM 14
// case and downloads it as a ZIP, entirely in the browser. See SITE EXTENSION POINT in
// index.html for what a backend can provide.

// bridge/case_generator.js builds the case files. It is loaded here, not by index.html, so the
// shared interface carries no site-specific script tags.
(function () {
  if (typeof document.createElement !== 'function' || !document.head) return;
  const s = document.createElement('script');
  s.src = 'bridge/case_generator.js';
  document.head.appendChild(s);
})();

// The steps shown after an export. They are the same with or without a drawn bed: the bed
// travels as constant/triSurface/bed.stl and snappyHexMesh carves it along with the obstacles.
// This used to tell the user to run `python3 apply_bed.py` when a bed was exported. The case
// has never contained that file.
function exportRunHint(meta) {
  return 'run: sh Allrun (blockMesh → snappyHexMesh -overwrite → foamRun -solver incompressibleFluid)' +
         (meta && meta.hasBed ? ', the bed is carved from bed.stl' : '') +
         '. "open" reads scene.json or the ZIP back in.';
}

// What the case generator is given: the drawn scene, the deposit as the flow sees it (bed
// units on the deposit grid, the same numbers depoZ() reads), and the scene file that is
// packed beside the case as scene.json so the interface can open it again.
function exportCaseState() {
  const state = sceneState();
  // The case is the flow at this moment: the objects that are there now (with the timeline on,
  // the ones whose clip is playing). scene.json below keeps them all, with their clips.
  const on = obstacles.map(isObstacleActive);
  state.obstacles = state.obstacles.filter((o, i) => on[i]);
  if (depoGrid) state.deposit = { grid: Array.from(depoGrid), gw: GW, gh: GH, cell: DEPO_CELL };
  state.sceneText = sceneFileText();
  return state;
}

async function exportToOpenFOAM() {
  const result = document.getElementById('export-result');
  const btn = document.getElementById('export-btn');
  if (typeof SedimentCaseGenerator === 'undefined') {
    result.innerHTML = '<span style="color:#f66">case_generator.js not loaded</span>';
    return;
  }
  try {
    btn.textContent = 'PACKING...';
    const state = exportCaseState();
    const { files, meta } = SedimentCaseGenerator.generateCase(state);
    const zipBytes = SedimentCaseGenerator.buildZip(files);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'sediment-openfoam-case.zip';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const what = meta.nObstacles + ' obstacle(s)' + (meta.hasBed ? ' + bed' : '');
    const run = exportRunHint(meta);
    result.innerHTML = 'exported ' + what + ' → sediment-openfoam-case.zip<br><span style="color:#888">' + run + '</span>';
  } catch (e) {
    result.innerHTML = '<span style="color:#f66">export failed: ' + e.message + '</span>';
  }
  btn.textContent = '⬇ EXPORT CASE';
}

registerBackend({
  id: 'export',
  title: 'Sediment Interface',
  // This site's step in the interface's guide (see THE GUIDE in index.html).
  guide: [
    { id: 'export', target: ['#export-btn', '#export-result'], title: 'Export', text:
      `<p><b>EXPORT CASE</b> writes this scene as a case for OpenFOAM, a full engineering flow solver, and downloads it as a ZIP. Inside are the setup files, an Allrun script that runs the whole case, and scene.json, which is this scene.</p>
       <p>This is how a sketch here becomes a proper simulation. It was tested on OpenFOAM 14, and it runs there as it is. The <b>open</b> button at the top reads the ZIP back in, so the scene can always be recovered from the case.</p>` },
  ],
  mount(slot) {
    slot.innerHTML =
      '<button id="export-btn">⬇ EXPORT CASE</button>' +
      '<div id="export-result" class="site-result"></div>';
    document.getElementById('export-btn').addEventListener('click', exportToOpenFOAM);
  },
});
