# Sediment Interface — Project Conventions
# Read by coding agents working in this directory. Notes about our own machines and
# checkouts are in `AGENTS.local.md`, which git ignores; read it too if it is there.

Repo `bradcantrell/sediment-interface` (public, GitHub Pages on `main`:
https://bradcantrell.github.io/sediment-interface/). Two things live here:

1. The **shared Sediment Interface** and the **river model** that runs in it (branch `main`).
2. `tidal-prototype.html` (branch `tidal-prototype`) — the tidal interface DEV copy, a
   separate single-file app. See the last section.

Fully static, no build step, no backend. p5.js 1.11.3 from cdnjs.

## The three layers

The page is three files that load in this order and share one script scope. Know which
layer a change belongs to before making it.

| File | Layer | What it is | Who else uses it |
|---|---|---|---|
| `index.html` | **interface** | Canvas, sediment particles, drawn bed (transect + cross-sections), deposit, obstacles and their timeline, 3D view, sidebar. Knows nothing about how water moves. | Every repo, byte for byte |
| `model.js` | **model** | How the water moves. Here: the river (a staggered-grid depth-averaged solver, friction, the bed as depth, dams that spill). Writes the flow field the interface moves sediment through. | Repos that want the river |
| `site.js` | **site** | What this repo does with the scene. Here: the OpenFOAM case export. | Nobody; each repo has its own |

The same split applies to tests: `dev/headless_harness.js` (interface), `dev/model_checks.js`
(river model), `dev/site_checks.js` (this site).

Rules:

- **Nothing about water goes in `index.html`.** No solver, no flow parameters, no model
  sliders. If the interface needs something from the model, it asks through a hook in the
  MODEL EXTENSION POINT (end of the script in `index.html`; the comment there is the
  reference for `registerModel`). Add a hook, and a check for it, rather than a name.
- **Nothing about this site goes in `index.html` or `model.js`.** No export, no bake, no
  server URLs. That is `site.js`, through the SITE EXTENSION POINT (`registerBackend`,
  `sceneState()`).
- **The contract between interface and model is the flow grid**: `NX` x `NY` cells plus a
  one-cell border, `IX(i, j)`, `cellW` x `cellH` px. The interface owns `u`, `v` and `solid`;
  the model writes `u` and `v` in `step()`. The model may read the bed (`bedPoints`,
  `computeUserBedZ`, `depoZ`, `depoGrid`). Sediment rules reach the interface's particle
  code through `model.rules`, never by global name.
- **A model's sidebar controls are markup inside `model.js`** (`controls.html`), mounted
  into `#model-controls`. That wrapper is `display:contents` on purpose: the sidebar is a
  flex column with a gap, and a plain wrapper packs the rows tighter. The harness cannot
  see that; a browser can.
- **The bed editor's elevation range belongs to the model** (`model.bed = { zMin, zMax,
  datumLabel }`, default 0 to 160). `bedChartYOf()`, `bedChartZOf()` and `clampBedZ()` are
  the only mapping between elevation and the transect chart; drawing, hit-testing and
  editing all go through them. The river does not set a range, so its bed is still drawn up
  from the floor. A range below zero is honoured by the editor and the 3D view; the bed
  colour ramp and the river's sediment rules still assume zero is the floor, which is
  stage 3 work (coastal brings its own bed rendering).
- **`toggleBedMode()` is the only way in and out of bed mode** (button, `M`, Escape). It
  pauses on entry and restores the previous state on exit.
- **The harness checks the interface under whatever model is loaded.** Its checks must not
  assume the river (a 0 to 160 bed, an inflow, a direction of travel). Optional hooks are
  tested by putting a known hook in, watching the interface use it, and putting the model's
  own back (`withHook`), so they are covered even when the loaded model does not have them.
- A different kind of water (waves, tide) is a different `model.js` in its own repo, on the
  same `index.html`. The coastal interface (`coastal-sediment-interface`) runs on it: wave
  field, bed change and model time in its `model.js`, the XBeach export in its `site.js`.
  A change here must pass the coastal repo's harnesses too before that repo syncs.

## Screen size, resizing and touch (2026-11-17)

- `canvasSize()` is the one rule: the window less the sidebar (`sidebarRoom()`, none below
  `NARROW_W` = 900 px, where the sidebar is a drawer, `body.narrow`), never below 320 x 240.
- `windowResized()` stretches the scene, the particles, the liftable deposits and the view,
  re-sizes `GW`/`GH` and resamples `depoGrid` (`resampleBedGrid`, each cell keeps its height),
  then calls the model's `resized()` and `gridResized(ogw, ogh)`, which must resample the
  model's own bed layers the same way (river: `fricGrid`; coast: morph, long, pick). `cellW`
  follows the setup rule, `width / (NX + 2)`. `saveScene()` refuses a size below the floor.
- Touch: one finger is the mouse (a press waits for the finger to move or lift, so the first
  finger of a pinch places nothing), two fingers pinch about their middle and pan. Touches
  that start off the canvas are left to the browser. The canvas has `touch-action: none`.
- `#tools` is the tool bar (shape, turn, delete, pause, restart, unzoom) on touch screens and
  narrow windows, where the key list is hidden. The key actions are functions
  (`restartRun`, `setGhostType`, `rotateSelected`, `deleteSelected`) used by both.

## Tabs and the saved scene

Both live in `index.html`, so every site gets them through the sync.

- **Tabs.** `SITE_TABS` in `index.html` lists the models: id, label, the id its `model.js`
  registers, and the public address of its site. The sidebar shows one tab per entry. A tab
  is a link to the other site, so switching is a page load; a page never holds two models.
  A page knows which tab it is by its model id, not its address, so local copies work.
  **To add a model:** add a line to `SITE_TABS`, commit, sync the repos that vendor the
  interface. A site that must not be listed here (the private bridge, a local experiment)
  names its own tab instead: `registerBackend({ ..., tab: { id, label } })` in its `site.js`.
  Nothing private goes in `SITE_TABS`; this file is public.
- **Streaks.** `showStreaks` (the `streak` toggle, on by default) draws each grain as a line
  from where it was last frame to where it is (`p.lx`, `p.ly`), added with `blendMode(ADD)`
  into `trailBuffer`, which `fadeTrails()` erases toward transparent. A move longer than
  `STREAK_JUMP` is a jump, not a path, and gets no line. Off, the old dots and darkening fade.
- **Resizing** stretches the scene with the canvas (`stretchScene()`, also used when a saved
  scene from another window size comes back), so objects stay over the same cells.
- **The saved scene.** Leaving the page (`pagehide`) writes the scene to `localStorage`
  under `sediment-interface/scene/<tab id>`, and `setup()` puts it back before the spin-up.
  Saved: obstacles with their clips, the drawn bed, every `input` and `select` in the
  sidebar that has an id (the model's and the site's included; they are restored by setting
  the value and firing `input`/`change`, so a control only comes back if its listener does
  the work), and the view toggles. Not saved: particles, deposit, the clock, pause, and
  anything a model keeps itself (the river's painted friction, the coast's moved bed). The
  `new` button in the tab row forgets the scene and reloads. Both public sites are on the
  same origin (`bradcantrell.github.io`) and share one storage quota, which is why the key
  carries the tab id and why grids are not saved.
- **The scene as a file.** `sceneFileText()` is the same scene as JSON. A site packs it in
  its exported case as `scene.json`, and the `open` button in the tab row reads it back from
  that file or from the ZIP itself (`findSceneInZip`: stored, or deflated in a folder after
  a re-zip). Opening files it as this tab's saved scene and reloads, so it comes in by the
  same road as a scene left on the last visit. A scene from another tab is refused. So an
  exported ZIP does two things: the solver case runs the scene, `scene.json` restores it.
- A new sidebar control is saved without any work **if it is an `input` or `select` with an
  id**. State kept only in a variable (a toggle button) is not; add it to `captureScene()`
  and `applySavedScene()` with a check, or to a model hook when models need one.
- Changing what a saved scene contains: bump `SAVE_VERSION`. Older saves are then discarded,
  not migrated.

## Other repos vendor these files

This repo owns `index.html`, `model.js`, `dev/headless_harness.js` and `dev/model_checks.js`.
Other repos copy them byte for byte with their own `dev/sync_core.sh`, record the commit and
hashes in `dev/core.lock`, and fail their harness if a copy drifts. The coastal interface
vendors `index.html` and the interface harness.

- Never edit a vendored copy. Change it here, commit, then sync there.
- A change here reaches the other repos only when they sync. After changing a shared file,
  run their harness against it before they sync.

## This site: the OpenFOAM export

- `site.js` — the EXPORT CASE button; packs `sceneState()` into a case and downloads a ZIP.
- `bridge/case_generator.js` — builds the OpenFOAM 14 case (blockMeshDict,
  snappyHexMeshDict, fields, obstacle/bed STLs). Loaded by `site.js`.
- Export domain: a 12.8 m long, 2.0 m deep channel whose width follows the canvas (one scale,
  12.8 m / canvas width, for both directions; 5.77 m on the 1280 x 577 reference canvas).
  `domainFor()` holds the one pixel-to-metre mapping (y flipped). The bed is the page's own
  (`sceneBedHeights()` ports `computeUserBedZ`/`getStationZ`, clamped to 0..160, plus the
  deposit grid `site.js` passes); 160 bed units are 0.5 m. `locationInMesh` is searched for
  from the inlet end, clear of every obstacle; Allrun stops if the mesh has no inlet or outlet.
  All of this was wrong until the 2026-11-17 stress test (obstacles at the reference scale,
  bed mirrored, rotations mirrored, seed fixed at the centre, deposit read from image
  brightness).

## Testing

`node --check` is not a test. It proves the page parses, and it once passed while a
`TypeError` inside `setup()` had killed the draw loop: the page loaded, the canvas drew,
and the simulation was dead along with every listener attached after the throw.

    node dev/headless_harness.js index.html    # exit 0 = pass, 1 = fail

The harness loads the page the way a browser does (inline script, then `model.js`, then
`site.js`, one scope), mocks p5 and the DOM, and asserts on model state rather than pixels.
98 checks:

- **Interface** (`dev/headless_harness.js`, 57): `setup()` completes, the draw loop advances
  time, sediment moves, a transect edits the bed, every visible strip is clickable, the bed
  editor works through the real mouse handlers (bed mode restores the pause state, a click
  lands at the elevation under the pointer, drags stop at the range, a signed range goes
  below zero, a cross-section point can be grabbed where it is drawn), Space
  unpauses exactly once, the model extension point works (stepped once per running frame,
  controls mounted, told when the bed changes, its tool can take the pointer, asked for the
  scene, and every optional hook is used: bed layers, default bed, non-solid objects, own
  object kinds, keys, clock, bed rendering, readouts, sediment rules, setup hooks), the site extension point works (a backend mounts once, gets its frame and keys,
  `sceneState()` describes the scene), the tabs and the saved scene work (nothing is saved
  before `setup()` finishes, `setup()` restores a scene seeded before it ran, leaving the
  page saves, a scene round-trips and stretches to another canvas size, a damaged one is
  discarded, each tab has its own, `new` forgets it), the guide works (its steps in order with
  the model's and the site's placed after the step each names, it opens from its button and
  ?, runs the model, holds keys and clicks, closes from ✕, Esc, done and the button) and the
  key list shows only while the run is stopped, grains draw as streaks from where they were
  to where they are (dots with the toggle off, the choice saved), a resize stretches the scene
  so a save after it comes back in place, a model's own view toggles are saved with the scene
  (`viewState()` / `applyViewState()`), a model can size a grain's deposit and lifting the
  grain takes back the same amount (`rules.depositAmount()`), the wheel scrolls the sidebar
  and over the canvas zooms (Shift turns an object), the zoom goes 1x to 10x about the pointer
  with clicks landing where they point, the middle button, Alt + drag and the
  arrow keys pan inside the scene, the thumbnail shows the zoom, and 0 or the bed editor reset it, nothing goes non-finite.
- **River model** (`dev/model_checks.js`, 24): the scene carries the inflow, sediment travels
  downstream, friction makes more of it settle over a drawn bed, the friction brush adds and
  subtracts, still water stays still, with the inflow shut the water comes to rest, the bed is
  in the flow (see below), and the staggered solver's own checks: a gap passes all the water,
  a dam holds the river until its pond reaches the crest and then spills, a slot loses head,
  rough ground turns the water aside, and no face into a solid carries water.
- **This site** (`dev/site_checks.js`, 3): the export backend mounts, the steps shown after an
  export name only files the case contains, and the real case
  generator builds a case from `sceneState()`.

Rules that have earned their place:

- **Any change to a draw or hit-test path must be exercised by a check.** A page that
  loads and renders proves nothing about a function that never ran.
- **A check must be shown to fail.** Break the function under test deliberately — a silent
  `return` at the top of its body — and confirm the harness fails and exits 1. A check that
  has never failed is decoration.
- **Never raise a tolerance to make a check pass.** Raise one only with the reason written
  next to it, because loosening a tolerance is how a bad model starts scoring well.
- **Synthetic events do not drive p5.** The mock records `window.addEventListener`
  handlers so the Space path can be invoked directly; dispatching a `KeyboardEvent` at the
  page does not work headlessly, and p5's own `keyPressed` is not reached.
- **Moving code between layers must not change behaviour, and that is checkable.** Seed the
  RNG, run a fixed script (flat bed, drawn bed with a cross-section, friction, restart), and
  hash `u`, `v`, the particles and the deposit before and after. The split into
  interface and model (2026-11-13) was accepted on identical hashes at every checkpoint,
  not on the harness passing.
- **Look at it in a browser before calling an interface change done.** Headless Chrome:
  `google-chrome --headless=new --screenshot=out.png file://.../index.html`.
  Layout is invisible to the harness.

## The river model (`model.js`)

A real-time 2D depth-averaged solver on a staggered (MAC) grid, 160 x 90 cells, inflow on
the left, open outflow on the right, global friction plus painted friction zones, and the bed
in the flow. `dev/MAC-GRID.md` has the design, the measurements and the comparison with the
collocated Stam solver it replaced on 2026-11-18. Each of these was measured and is covered
by a check. Do not undo them.

- **The normal velocity lives on faces** (`mac.uF`, `mac.vF`), averaged to cell centres into
  `u` and `v` each step. A face is open only if both its cells are water connected to the
  outflow. The collocated solver let water through faces against a wall and lost or made it
  at obstacles.
- **The pressure solve runs to a residual** (`MAC_TOL`), conjugate gradients preconditioned
  with MIC(0) plus an exact column-sum solve. Discharge is then the same through every
  column of faces, with or without obstacles. With a bed, drawn or deposited, it enforces
  `div(h u) = 0` on the same px-to-metre mapping as the OpenFOAM export.
- **Advection moves the field as far as a grain moves** (`MAC_ADV = 4 * DT`). The old scale
  (`DT * NX`) was 40 times that and copied a jet far downstream.
- **All drag acts before the solve** (`macDrag()`), so none of it takes water out of the river.
  Bed friction is stronger in shallow water, and narrow openings lose head (`K_OPEN`).
- **Friction reaches the sediment through `rules.nearBed`**, the speed the settling and
  lifting rules see, times `(1 + f)^-0.6`. At a fixed discharge and slope Manning's equation
  gives speed as n^-0.6, and friction f is read as raising n by 1 + f (a modelling choice).
  Slowing the grains themselves cut the supply and lowered the deposit as friction rose.
- **A wall across the whole channel is a dam.** Its pond stores the inflow and settled sand
  until the level passes `WALL_FREEBOARD`, then the wall spills as a weir (`WEIR_C`), and the
  interface lets grains over the crest (`model.passable`).
- **The interface restarts a flow that goes non-finite** (`flowFinite()` after the spin-up
  and every step), calls the model's `restart()`, and says so in the HUD for a few seconds.
  R does the same, so a bad state never survives a restart.
- If anything other than the solver writes `u` or `v` (R, a restart, a check), the faces are
  rebuilt from them, so zeroing `u` and `v` puts the water at rest.
- Deposit is averaged over the flow cell before it becomes depth.

Against OpenFOAM on a drawn rise with one obstacle (880k cells, 2026-11-13), the collocated
solver had an RMS difference of 15% of inflow, bias -1% and correlation 0.51. That comparison
has not been re-run for this solver.

Known and left alone: `setup()` sets `cellW = width / (NX + 2)` and `windowResized()` sets
`width / NX`; and `index.html` sets `p5.disableFriendlyErrors` one line before p5 loads,
which logs a harmless ReferenceError.

## tidal-prototype.html — tidal model (dev copy)

The TIDAL sediment model (Venice Lagoon). A separate single-file app, not on the shared
interface. Dev copy only — edit here, then `cp tidal-prototype.html
../tidal-sediment-interface/index.html` and push both repos. Full conventions live in the
tidal repo's AGENTS.md.

## Branches

- `main` — the interface, the river model and the export site (Pages).
- `shared-core` — where the interface/model/site split and the bed in the flow were built.
  Merged into `main` on 2026-11-14 and equal to it since; new work can go on either.
- `tidal-prototype` — tidal dev.

## Related repos

- Coastal interface: `bradcantrell/coastal-sediment-interface`.
- Tidal interface: `bradcantrell/tidal-sediment-interface`.
