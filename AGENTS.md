# Sediment Interface — Project Conventions
# Auto-loaded by Hermes when working in this directory

Repo `bradcantrell/sediment-interface`. Two related things in one repo:

1. `index.html` (branch `main`) — the fluvial **Sediment Interface** (public, GitHub Pages).
2. `tidal-prototype.html` (branch `tidal-prototype`) — the **tidal sediment interface** DEV copy. The canonical/hosted copy lives in repo `bradcantrell/tidal-sediment-interface` as `index.html` (see that repo's AGENTS.md).

## index.html — fluvial Sediment Interface

Browser sandbox: real-time 2D Stam fluid solver + sediment particles (settle/erode) + aggrading heightfield bed + obstacle choreography (circles/rects/polygons on a looping timeline) + OpenFOAM case export. Fully static, no build.

- `bridge/case_generator.js` — builds the OpenFOAM 14 case (blockMeshDict, snappyHexMeshDict, fields, obstacle/bed STLs), downloads as ZIP.
- Export domain: 12.8m × 5.77m × 2.0m channel; drawn bed maps to ≤0.5m relief.
- Hosted: https://bradcantrell.github.io/sediment-interface/ (Pages on `main`).

### Testing — `dev/headless_harness.js`

`node --check` is not a test. It proves the page parses, and it once passed while a
`TypeError` inside `setup()` had killed the draw loop: the page loaded, the canvas drew,
and the simulation was dead along with every listener attached after the throw.

    node dev/headless_harness.js index.html    # exit 0 = pass, 1 = fail

Twelve checks, all on model state rather than pixels: `setup()` completes, the draw loop
advances simulation time, particles move downstream, the friction slider reaches the
solver, a drawn transect edits the bed, every visible strip is clickable, Space unpauses
exactly once, the friction brush adds and subtracts, still water holds a steady spurious
current within stated tolerances, and nothing goes non-finite.

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

Known limitation, measured: the velocity solver has no bed term. `velocityStep()` is
inflow, diffuse, project, advect, project, friction, and nothing reads `bedZ` — the bed
steers particles only. The still-water residual comes from the pressure projection, not
from the bed, and that is what the tolerance in the harness documents.

## tidal-prototype.html — tidal model (dev copy)

The TIDAL sediment model (Venice Lagoon). Dev copy only — edit here, then `cp tidal-prototype.html ../tidal-sediment-interface/index.html` and push both repos. Full conventions live in the tidal repo's AGENTS.md.

## Branches

- `main` — fluvial interface (Pages).
- `tidal-prototype` — tidal dev.

## Related

- Private research build (live OpenFOAM coupling, "Sediment Bridge"): `U:/www/sediment-bridge` (see its AGENTS.md).
- Public tidal interface: `D:/workspace/tidal-sediment-interface`.
