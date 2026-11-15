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

function decodePngToHeights(dataUrl) {
  return new Promise(function (resolve) {
    try {
      const img = new Image();
      img.onload = function () {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, img.width, img.height).data;
        const h = [];
        for (let y = 0; y < img.height; y++) {
          const row = [];
          for (let x = 0; x < img.width; x++) {
            const idx = (y * img.width + x) * 4;
            row.push((0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2]) / 255);
          }
          h.push(row);
        }
        resolve(h);
      };
      img.onerror = function () { resolve(null); };
      img.src = dataUrl;
    } catch (e) { resolve(null); }
  });
}

// The steps shown after an export. They are the same with or without a drawn bed: the bed
// travels as constant/triSurface/bed.stl and snappyHexMesh carves it along with the obstacles.
// This used to tell the user to run `python3 apply_bed.py` when a bed was exported. The case
// has never contained that file.
function exportRunHint(meta) {
  return 'run: sh Allrun (blockMesh → snappyHexMesh -overwrite → foamRun -solver incompressibleFluid)' +
         (meta && meta.hasBed ? ', the bed is carved from bed.stl' : '') +
         '. "open" reads scene.json or the ZIP back in.';
}

// What the case generator is given: the drawn scene, and the scene file that is packed
// beside the case as scene.json so the interface can open it again.
function exportCaseState() {
  const state = sceneState();
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
    let heightsPng = null;
    try { heightsPng = await decodePngToHeights(depoBuffer.elt.toDataURL('image/png')); }
    catch (e) { heightsPng = null; }
    const state = exportCaseState();
    state.heightsPng = heightsPng;
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
  mount(slot) {
    slot.innerHTML =
      '<button id="export-btn">⬇ EXPORT CASE</button>' +
      '<div id="export-result" class="site-result"></div>';
    document.getElementById('export-btn').addEventListener('click', exportToOpenFOAM);
  },
});
