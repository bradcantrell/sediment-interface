# Sediment Interface

A browser-based sediment-flow sandbox and **OpenFOAM case exporter**. Draw a bed profile, place obstacles in a real-time 2D flow, and export a complete, runnable OpenFOAM 14 case — entirely client-side, no server required.

## What it does

- **Real-time 2D flow** — a Stam fluid solver with sediment particles (deposition + erosion) and an aggrading bed.
- **Bed profile editor** — draw a longitudinal profile and transverse cross-sections; the bed surface is carved into the exported mesh.
- **Obstacle choreography** — place circles, rectangles, and freeform polygons, sequenced on a looping timeline.
- **OpenFOAM export** — builds a full case (`blockMeshDict`, `snappyHexMeshDict`, boundary + initial fields, obstacle and bed STLs) and downloads it as a ZIP.

## Running the interface

Fully static. Open `index.html` directly in a browser, or serve it from any static host (GitHub Pages, Netlify, `python -m http.server`, etc.). No build step, no backend.

## Running an exported case (OpenFOAM 14)

Unzip the exported `sediment-openfoam-case.zip`, then:

```bash
blockMesh
snappyHexMesh -overwrite      # carves obstacles + bed from the triSurface STLs
foamRun -solver incompressibleFluid
```

## Domain

The exported domain is a 12.8 m × 5.77 m × 2.0 m channel. A drawn bed maps to up to 0.5 m of relief, carved by `snappyHexMesh` from `constant/triSurface/bed.stl`.

## License

[MIT](LICENSE)
