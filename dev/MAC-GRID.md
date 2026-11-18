# The staggered (MAC) flow solver: stage 1

Branch `mac-grid`, from `shared-core` at 727dbb1. Written 2026-11-18.

## Why

The 2026-11-17 stress test (items 5, 20 and 21) found that the river does not conserve water
at obstacles. A gap in a wall passed about 30% of the flow, the flow behind a wide wall was up
to 170% of the inflow, a wall dropped into running water left 45-66% flowing behind it, and
under friction the plain projection lost 99.9% of the discharge by the outflow. Switching to
`projectDepth()` everywhere did not fix the obstacle cases. The cause is the collocated grid:
the divergence is measured across two cells (`u[i+1] - u[i-1]`), which leaves every other cell
free and lets flow cross a face that touches a solid cell.

## What was built

All of it is in `model.js`, behind `solverMode`. `'stam'` is the default and runs the old
solver unchanged (a seeded run hashes the same as 727dbb1). `'mac'` runs the new one. To try
it in a browser, add `?solver=mac` to the page address.

- **Grid.** The normal velocity lives on faces: `mac.uF` on the faces between columns (face 0
  is the inflow edge, face NX the outflow edge), `mac.vF` on the faces between rows (faces 0
  and NY are the banks). Pressure is at cell centres. The interface contract is unchanged:
  each step the faces are averaged to cell centres into `u` and `v`.
- **Faces and solids.** A face is open only if both of its cells are water and that water is
  connected to the outflow (a flood fill from the last column). Closed faces carry nothing.
  Rebuilt only when the solid mask or the depth grid changes.
- **Step.** Inflow on face 0 (the old speed and noise), semi-Lagrangian advection of each face
  at the old scale (`DT * NX`, 12.8 cells per unit speed per step), one explicit diffusion step
  with the old coefficient, a pressure solve, friction as before, then the averaging.
- **The backtrace stops at walls.** It walks back in steps no longer than the distance to the
  nearest solid cell allows (a distance field built with the mask) and stops before the first
  solid cell. The old `advect()` checked only the corners at the far end of the jump.
- **The pressure solve.** `div(h u) = 0` in every connected cell, `h` the face depth from
  `depthGrid` (1 with no bed), so plain and depth mode are the same solver. The inflow face has
  its speed given, the outflow face sees `p = 0` half a cell out (as `setBndPressureOpen()`).
  Conjugate gradients, preconditioned with MIC(0) plus an exact solve of the column-sum system
  (the idea of `sectionPressure()`, used here as a coarse correction). It runs until no cell
  has more than `MAC_TOL = 1e-3` left (a face at inflow speed carries about 2.5), not for a
  fixed number of sweeps. It starts from the last step's pressure, or from zero when that is
  the better guess. Because it runs to a residual, the start changes only the iteration count.
- **External writes.** If something other than the solver wrote `u` or `v` since the last step
  (R, the interface's restart after a non-finite flow, a check), the faces are rebuilt from
  what is there. So zeroing `u` and `v` now does put the water at rest.

Column conservation follows from the solve: summed over a column of cells, `div(h u) = 0` says
the discharge through one column of faces equals the discharge through the next.

## The numbers

Canvas 1200 x 800 in the headless harness, grid 160 x 90, inflow 2.5. Discharge is the sum of
`h * u` over a column of cells, the stress test's measure and what the particles see. "From
rest" starts the run with the wall in place; "dropped" adds it to a developed flow.

| Case | Old (stam) | MAC |
|---|---|---|
| Gap wall 40 px (10 rows open), plain, from rest: at the gap / downstream | 12% / 53% | 100% / 100% |
| Same, drawn bed | 30% / 95% | 100% / 100% |
| Gap wall 300 px, plain, from rest: at the gap / downstream | 12% / -18% | 100% / 100% |
| Same, drawn bed | 45% / 138% | 100% / 100% |
| Same, drawn bed, dropped | 44% / 169% | 100% / 100% |
| Gap wall dropped into running water, flow behind it after 1, 10, 300 steps (plain) | 94%, 72%, 72% | 100%, 100%, 100% |
| Same, drawn bed | 95%, 95%, 95% | 100%, 100%, 100% |
| Full-width wall dropped, flow behind it after 300 steps, plain / bed | 65% / 45% | 0% / 0% |
| Friction 3, plain, discharge at column 155 over column 5 | 0.001 | 1.000 |
| Friction 1, same | 0.59 | 1.000 |
| R8 scene (wall with a 2-row slot at the bank and a 24-row gap), drawn bed, discharge at columns 2-159 | 0.41-1.02 of inflow | 1.00 at every column |
| R8 scene, drawn bed, worst single-cell spike (speed over the mean of its 8 neighbours) | 12.3x | 3.4x |
| R8 scene, no bed, worst single-cell spike | 4.6x | 3.1x |
| R8 scene, drawn bed, peak speed | 35.7 (14.3x inflow) 36 cells downstream, in open water | 37.8 (15.1x) in the slot |
| Largest `div(h u)` left in any cell after a step | not driven to zero (30 sweeps) | 9e-4 (tolerance 1e-3) |
| Leftover motion with the inflow shut (harness check 9b), mean | 0.045-0.13 | 0 |

Discharge through each column of faces agrees to 0.001% at the chosen tolerance (0.000% at
1e-5, 0.01% at 1e-2).

**The peak speed did not go down, and should not.** In the R8 scene a 2-row slot is left
between the wall tip and the bank. An independent sparse solve of the same potential flow
(`dev/mac-grid/potential.py`, scipy) puts 22% of the discharge through that slot at about 25,
ten times the inflow; the MAC solver's first step gives 21% at 24. Inviscid free-slip flow
does that, and the jet then runs along the bank to the outflow (34.8 at column 158). The old
solver's peak was a lone cell in open water, 36 cells below the wall, 12 times its neighbours.
The new one is a jet that conservation and potential flow require. With all the water forced
through 10 open rows, a gap's mean speed is 9 times the inflow, and its corners reach 65-88.

**Frame time**, `model.step()` alone, node 22 (the same V8 as Chrome), mean of 400 steps after
100, two runs that agreed within 1%. The machine was shared with other jobs (load 8.6).

| Scene | Old | MAC | CG iterations |
|---|---|---|---|
| Plain, no obstacle | 12.8 ms | 2.6 ms | 2 |
| Plain, gap wall | 12.5 ms | 19.1 ms | 39 |
| Drawn bed, gap wall | 17.3 ms | 19.7 ms | 46 |
| Drawn bed, friction 3, three obstacles | 17.5 ms | 18.8 ms | 42 |

Outside the solve a MAC step costs about 2.5 ms; each CG iteration about 0.37 ms. MIC(0)
alone took 85 iterations on the gap wall; the column correction brought that to 53 at 1e-5
and 37-46 at 1e-3.

**No blow-up.** 6000 steps (8 minutes of model time) with particles and deposit on, a drawn
bed, painted friction, three obstacles (one timed in and out), the bed refreshed every 6 steps:

| Run | Old | MAC |
|---|---|---|
| Friction 3, inflow 5: peak speed, non-finite values, restarts | 12.9, 0, 0 | 15.9, 0, 0 |
| Friction 0, inflow 2.5 | 20.4, 0, 0 | 9.4, 0, 0 |
| Deposit total after 6000 steps, friction 3, inflow 5 | 104357 | 28492 |
| Same, friction 0, inflow 2.5 | 6599 | 6391 |

## Checks

`node dev/headless_harness.js index.html`, run as committed and with `solverMode` defaulting to
`'mac'` (`dev/mac-grid/sync.sh` makes that copy):

- default (stam): 103 of 103 pass
- mac: 103 of 103 pass

Five checks are new in `dev/model_checks.js`, under "the staggered solver conserves water at
obstacles". They switch to MAC themselves, so they run in both modes:

- a gap in a wall passes all the inflow, plain and over a drawn bed (faces and cells, 0.5%)
- a wall dropped into running water conserves the flow at once (a gap wall one step after;
  a full wall carries nothing through any column)
- no face into a solid carries water, and `div(h u)` is within the tolerance in every cell
- friction 3 for one second from rest leaves the same discharge at every column

Shown to fail. With `macSolve()` returning at once all five fail (the gap passes 9-11%,
friction drains the channel to 0). With faces into solid cells left open, four fail (44
faces carry water into solids, the gap passes 11%, over a bed the flow runs away to 1450x).

## What a user will see in MAC mode

- Water goes around obstacles and through gaps instead of vanishing into them. A gap in a wall
  carries the whole river, so its jet is much faster than before (9 times the inflow on
  average for a 10-row gap) and scours harder. The old gaps passed 12-45%.
- A narrow slot between an obstacle and a bank becomes a fast streak along the bank, all the
  way down. Free-slip banks and no viscosity to speak of leave nothing to slow it.
- A wall across the whole channel stops the river. Nothing moves upstream of it and no
  sediment reaches past it. The old solver let 45-65% leak behind it.
- Friction slows the field the same way everywhere instead of draining it downstream, so at
  high friction far less sediment piles up at the downstream end (28k against 104k deposit
  in the long run above).
- With the inflow at 0 the water is still (it used to keep a slow stir).
- Open water costs a fifth of what it did; obstacles cost up to 50% more per step.

## Stage 2

- Make `'mac'` the default, then retire `project()`, `projectDepth()`, `sectionPressure()`,
  `linSolve()`/`diffuse()`/`advect()` and their notes, and the now-unused `uPrev`/`vPrev`.
  Rework the still-water check (9b measures leftover motion the MAC solver does not have).
- Fix the docs that claim conservation (AGENTS.md, "The river model"; the comments over
  `projectDepth()`), and say what the new limits are.
- Re-run the OpenFOAM comparison (drawn rise with one obstacle, 880k cells, 2026-11-13). The
  old figures were RMS 15% of inflow, bias -1%, correlation 0.51.
- Re-sync the bridge, which vendors `model.js` and `dev/model_checks.js`, and run the coastal
  harness against the shared files (this branch does not touch `index.html`).
- If 19 ms is too slow with obstacles: a multigrid preconditioner, or the old 30-sweep budget
  with the column correction and a looser tolerance (1e-2 gives 13 ms and 0.01% spread).

## Open questions for Brad

1. A full-width wall stops the river. In a rigid-lid model water cannot go over the top. Is a
   dam that stops everything right, or should a full blockage leak, overtop, or be refused?
2. The advection scale is the old one, 12.8 cells per unit speed per step, about 40 times the
   distance a particle moves. It is what makes a gap jet copy itself far downstream. Keep it
   for the look, or tie it to the particle speed (stress-test item 20 asks for this decision)?
3. Narrow slots carry fast jets now, by conservation. Should the friction slider, or a wall
   drag, slow water in narrow openings, as real head loss would?
4. Friction is applied after the solve, as before. With painted zones this leaves a small local
   divergence for that frame (uniform friction scales all faces alike and keeps discharge
   equal along the channel). Apply it before the solve instead? Then friction would no longer
   lower the discharge, only reshape the flow, and the slider would do much less.
5. Deposit at high friction drops by a factor of 3.7 in MAC mode, because water no longer
   disappears downstream. The sediment thresholds were tuned on the old field. Retune them?

## Measurement scripts

`dev/mac-grid/`: copies of the stress-test repro scripts (`r3_repro.js`, `r8.js`,
`r6_steady_compare.js`) adjusted to load `RIVER_HTML`, plus `spikes.js`, `drop.js`,
`longrun.js`, `timing.js`, `tol.js`, `slit.js`, `hash.js` and `potential.py`. They need `h.js`
and `lib.js` from `sediment-stress-test/repro/verify-river-physics-R3/` next to them, and
`sync.sh` to build the `stam/` and `mac/` copies. Example:
`RIVER_HTML=$PWD/mac/index.html node r3_repro.js bed`.
