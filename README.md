# Sediment Interface

A browser-based sediment-flow sandbox and **OpenFOAM case exporter**. Draw a bed profile, place obstacles in a real-time 2D flow, and export a complete, runnable OpenFOAM 14 case — entirely client-side, no server required.

## What it does

- **Real-time 2D flow** — a Stam fluid solver with sediment particles (deposition + erosion) and an aggrading bed. The bed is in the flow: water speeds up over a drawn rise or a deposit and slows over a hollow, conserving discharge.
- **Bed profile editor** — draw a longitudinal profile and transverse cross-sections; the bed surface is carved into the exported mesh.
- **Obstacle choreography** — place circles, rectangles, and freeform polygons, sequenced on a looping timeline.
- **Model tabs** — switch between the river and the coast from the top of the sidebar. Each keeps its own scene in your browser, so coming back finds it as you left it.
- **OpenFOAM export** — builds a full case (`blockMeshDict`, `snappyHexMeshDict`, boundary + initial fields, obstacle and bed STLs) and downloads it as a ZIP. The ZIP runs on your own machine with `sh Allrun` (OpenFOAM 14) and carries the scene as `scene.json`.
- **Open a scene** — the `open` button reads `scene.json`, or the exported ZIP itself, and puts the drawing and settings back.

## How it is built

The page is three files that load in order and share one script scope.

| File | What it is |
|---|---|
| `index.html` | The interface: canvas, sediment particles, the drawn bed and its editor, deposit, obstacles and their timeline, the 3D view, the sidebar. It knows nothing about how water moves. |
| `model.js` | The model: how the water moves. Here, the river. |
| `site.js` | What this site does with the scene. Here, the OpenFOAM export. |

`index.html` is shared. Other projects run a different kind of water on the same interface by
bringing their own `model.js` and `site.js`. The
[Coastal Sediment Interface](https://github.com/bradcantrell/coastal-sediment-interface) does
this with a wave and beach model and an XBeach export. Those projects copy `index.html` byte
for byte and check the copy against a recorded hash, so a fix to the interface is made once,
here.

## Running the interface

Fully static. Open `index.html` directly in a browser, or serve it from any static host (GitHub Pages, Netlify, `python -m http.server`, etc.). No build step, no backend.

New to it? Press **? guide** in the bottom left corner, or the `?` key, for a walkthrough that lights up each part of the screen and explains it. The key list along the bottom shows whenever the run is paused.

## Running an exported case (OpenFOAM 14)

Unzip the exported `sediment-openfoam-case.zip`, then:

```bash
blockMesh
snappyHexMesh -overwrite      # carves obstacles + bed from the triSurface STLs
foamRun -solver incompressibleFluid
```

## Testing

```bash
node dev/headless_harness.js index.html    # exit 0 = pass
```

The harness loads the three files the way a browser does, with p5 and the DOM mocked, and
checks behaviour: the draw loop runs, sediment moves, the bed editor works through the real
mouse handlers, the model and site extension points are used, the river responds to friction
and to the bed, and the exporter builds a case from the drawn scene. 74 checks. `AGENTS.md`
describes the layers and the testing rules.

## Domain

The exported domain is a 12.8 m × 5.77 m × 2.0 m channel. A drawn bed maps to up to 0.5 m of relief, carved by `snappyHexMesh` from `constant/triSurface/bed.stl`.

## License

[MIT](LICENSE)
