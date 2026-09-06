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

## tidal-prototype.html — tidal model (dev copy)

The TIDAL sediment model (Venice Lagoon). Dev copy only — edit here, then `cp tidal-prototype.html ../tidal-sediment-interface/index.html` and push both repos. Full conventions live in the tidal repo's AGENTS.md.

## Branches

- `main` — fluvial interface (Pages).
- `tidal-prototype` — tidal dev.

## Related

- Private research build (live OpenFOAM coupling, "Sediment Bridge"): `U:/www/sediment-bridge` (see its AGENTS.md).
- Public tidal interface: `D:/workspace/tidal-sediment-interface`.
