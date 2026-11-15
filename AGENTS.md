# Sediment Interface — Project Conventions
# Auto-loaded by Hermes when working in this directory

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
| `model.js` | **model** | How the water moves. Here: the river (Stam stable-fluids solver, friction, the bed as depth). Writes the flow field the interface moves sediment through. | Repos that want the river (Sediment Bridge) |
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
hashes in `dev/core.lock`, and fail their harness if a copy drifts. First: the private
Sediment Bridge (interface + river model + its own `site.js`).

- Never edit a vendored copy. Change it here, commit, then sync there.
- A change here reaches the other repos only when they sync. After changing a shared file,
  run their harness against it before they sync.

## This site: the OpenFOAM export

- `site.js` — the EXPORT CASE button; packs `sceneState()` into a case and downloads a ZIP.
- `bridge/case_generator.js` — builds the OpenFOAM 14 case (blockMeshDict,
  snappyHexMeshDict, fields, obstacle/bed STLs). Loaded by `site.js`.
- Export domain: 12.8 m x 5.77 m x 2.0 m channel; the drawn bed maps to at most 0.5 m of
  relief (160 px).

## Testing

`node --check` is not a test. It proves the page parses, and it once passed while a
`TypeError` inside `setup()` had killed the draw loop: the page loaded, the canvas drew,
and the simulation was dead along with every listener attached after the throw.

    node dev/headless_harness.js index.html    # exit 0 = pass, 1 = fail

The harness loads the page the way a browser does (inline script, then `model.js`, then
`site.js`, one scope), mocks p5 and the DOM, and asserts on model state rather than pixels.
68 checks:

- **Interface** (`dev/headless_harness.js`, 48): `setup()` completes, the draw loop advances
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
  discarded, each tab has its own, `new` forgets it), nothing goes non-finite.
- **River model** (`dev/model_checks.js`, 13): the scene carries the inflow, sediment travels downstream, friction slows
  the field, the friction brush adds and subtracts, still water stays still, leftover motion
  stays bounded, and the bed is in the flow (see below).
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
- **Look at it in a browser before calling an interface change done.** Headless Chrome is
  on vlmars: `google-chrome --headless=new --screenshot=out.png file://.../index.html`.
  Layout is invisible to the harness.

## The river model (`model.js`)

Real-time 2D Stam solver on the 160 x 90 grid, inflow on the left, open outflow on the
right, global friction plus painted friction zones, and the bed in the flow.

The bed is in the flow, drawn and deposited. With either present, `velocityStep()` uses
`projectDepth()`, which conserves discharge (`div(h u) = 0`) on a relative depth grid with
the same px-to-metre mapping as the export. With neither it runs the plain `project()`
exactly as before. Each of these was measured and is covered by a check; do not undo them:

- **`projectDepth()` starts from `sectionPressure()`**, an exact tridiagonal solve of the
  along-channel pressure. Started from zero, 30 sweeps gave a 1% speed-up over a rise that
  should give 33%.
- **It does not carry pressure between frames.** That also converges, and it kicks the field
  by up to ten times the inflow speed whenever the flow changes abruptly.
- **The outflow is open** (`setBndPressureOpen`). Closed like `project()`'s, a converged
  solve turns the inflow/outflow mismatch into a false source.
- **A solid neighbour stands in the cell's own pressure in the velocity correction.**
  Pressure is measured from the outflow and is large upstream; reading a solid cell's zero
  blew the flow up next to obstacles.
- Deposit is averaged over the flow cell before it becomes depth.
- `velocityStep()` advects `vPrev` into `v`, so the cross-flow's history lives in `vPrev`.
  Zeroing `u` and `v` alone does not put the water at rest.
- Against OpenFOAM on a drawn rise with one obstacle (880k cells, 2026-11-13): RMS
  difference 23% -> 15% of inflow, bias -15% -> -1%, correlation -0.07 -> 0.51.

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
  Merged into `main` on 2026-11-14 and equal to it since; new work can go on either, and
  nothing is pushed without Brad's OK.
- `tidal-prototype` — tidal dev.

## Checkouts and related repos

- This repo: `/mnt/vault/projects/sediment-interface` on vlmars; `D:/workspace/sediment-interface` on vlio.
- Sediment Bridge (PRIVATE, live OpenFOAM coupling): `/mnt/vault/infrastructure/www/sediment-bridge`
  (`U:/www/sediment-bridge` from Windows). See its AGENTS.md.
- Coastal interface: repo `coastal-sediment-interface`. Tidal: `D:/workspace/tidal-sediment-interface`.
