# The staggered (MAC) flow solver

Stage 1 (below, up to "Stage 2") was written on branch `mac-grid` from 727dbb1, 2026-11-18,
with the solver behind a `solverMode` switch. Stage 2 made it the only solver the same day,
after Brad answered the five open questions. Its section is at the end.

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

## Stage 2: the only solver (2026-11-18)

The collocated solver is gone: `solverMode`, `project()`, `projectDepth()`,
`sectionPressure()`, `setBndPressureOpen()`, `linSolve()`, `diffuse()`, `advect()`,
`addSource()` and `uPrev`/`vPrev`/`p`/`divArr`. `velocityStep()` is the MAC step. Brad's
answers to the five questions, and what was built for each:

1. **A wall across the whole channel spills once enough water or sediment has built up.**
   The water reached from the inflow that cannot get to the outflow is a pond (`macPond()`).
   It stores the inflow and its level rises. Sediment settling in it takes up room and lifts
   the level too.
   Walls stand `WALL_FREEBOARD` above the river, a quarter of the 2 m depth (0.5 m). Past
   that, every obstacle touching the pond is a broad-crested weir, `q = WEIR_C H^1.5`, and
   its cells carry water H deep. `WEIR_C` = 2.41 is the textbook 1.705 m^0.5/s in this
   model's units, where depth 1 is 2 m and speeds are in m/s as the OpenFOAM export reads
   them (1.705 x 2^1.5 / 2). Each step the pond stores the inflow minus the spill, as a sink
   in the pressure solve, so water is conserved throughout. The interface lets grains cross a spilling crest
   (`model.passable`, a new optional hook in `index.html`).
2. **Advection at the particles' speed.** `MAC_ADV = 4 * DT`, 0.32 cells per unit speed per
   step, the distance the interface moves a grain. The old scale was 12.8, 40 times as far.
3. **Head loss in narrow openings.** `du/dt = -K_OPEN |u| u / b` before the solve, b the
   opening's width across the flow, `K_OPEN` = 0.25 (an entrance loss of K = 0.5).
4. **Friction before the solve, and what the slider does.** All drag now acts before the
   pressure solve, so friction cannot take water out of the river. Bed friction decays as
   `exp(-f DT / h)`, so shallow water feels it more. A painted patch turns the water aside
   and a drawn bed's deep channel takes more of it. On the sediment the slider acts through
   `rules.nearBed`. The settling and lifting rules see the speed times `(1 + f)^-0.6`. By
   Manning, a rougher bed carrying the same discharge runs deeper and slower, and a rigid
   lid cannot deepen, so the slowing goes to the rules. Slowing the grains themselves was
   tried first. Fewer grains came down the reach, so the deposit fell as friction rose.
5. **The sediment thresholds were retuned.** The defaults came out best and are kept (below).

### Numbers

Same harness and canvas as stage 1. "Before" is the collocated solver at d48ec45.

| Case | Before | Stage 1 | Stage 2 |
|---|---|---|---|
| Full-width wall, pond of 7020 cells: steps until it spills | never (45-65% leaked) | never (stopped) | 25 (`WALL_FREEBOARD` x area / inflow, as computed) |
| Same, settled: spill over inflow; head over the crest against the weir law | - | - | 1.000; 1.025 against 1.025 |
| R8 scene (a wall with a 2-row slot at the bank and a 24-row gap), the slot's share of the discharge | - | 21% (inviscid 22%) | 6.9% (8.1% with `K_OPEN` = 0) |
| R8 scene, drawn bed, worst single-cell spike | 12.3x | 3.4x | 1.26x |
| R8 scene, drawn bed, peak speed | 35.7, in open water | 37.8, in the slot | 31.3 at the first step from rest, then about 10 in the slot and 14.2 in open water |
| Painted patch (zone mu 3) across the middle third: that third's share of the river | - | - | 33.3% -> 6.3%, total 100.00% |
| Inflow shut on a developed flow, mean speed after 120 / 360 / 1200 steps | 0.08-0.17, steady | 0 (stage 1 measured from rest) | 0.23 / 0.17 / 0.095, decaying |

The water does not stop at once with the inflow shut. With advection 40 times slower, only
diffusion and the opening drag remove the eddies that are left.

**The retune.** 3000 steps with particles, inflow 2.5, two obstacles (a rotated rectangle and
a circle), deposit summed over the grid:

| Scene | Before, friction 0 / 1 / 3 | Stage 2, friction 0 / 1 / 3 |
|---|---|---|
| Drawn bed | 6596 / 6451 / 6135 | 6224 / 9908 / 69169 |
| No bed | 6322 / 6021 / 5529 | 1597 / not run / 1810 |

The drawn bed is where most of the sediment physics happens. There the defaults (settle
0.20, erode 1.00) put down 6% less than before at friction 0. Raising erode to 1.3 changed
that by 1%. Raising it to 2.0 or settle to 0.4 sent the drawn-bed deposit to 14k and 63k,
since the bed then barely erodes. So the defaults stay. Friction now raises deposition, as
the page's guide says it should. At the slider's top, 3, the drawn-bed deposit is 11 times
the default. That is the same runaway, on purpose: the near-bed factor is 0.44 there, so the
bed barely erodes. Friction 3 stands for Manning's n four times the default, the step from
a sand bed to a weedy or bouldery one. At 1 the deposit is 1.6 times. At inflow 5 the faster
water still lifts most of it (18000 after 6000 steps, below). Before, it lowered it slightly (-7% over the bed at friction 3). The no-bed
scene deposits a quarter of what it did. Before, 2377 of its 6322 sat against the rectangle
and most of the rest in open water away from either obstacle. That came from water flowing
into the obstacles, which carried grains with it, and from the slow single cells of the
odd-even pattern. The circle's front now gets more (491 against 297). Neither solver builds
a deposit in the lee of the circle (16 and 0). The lee is slower now (mean speed 1.04 against
2.21) but few grains get into it.

**Long runs** (`longrun.js`, 6000 steps, particles, drawn bed, painted friction, three
obstacles, one of them switched in and out by the timeline): friction 3 and inflow 5 peaked at 16.4, deposit 18000. Friction 0 and
inflow 2.5 peaked at 7.1, deposit 5989. Neither had a non-finite value or a restart.

**Frame time**, `model.step()` alone (`timing.js`, load 2):

| Scene | Before | Stage 1 | Stage 2 |
|---|---|---|---|
| Plain, no obstacle | 12.8 ms | 2.6 ms | 3.0 ms |
| Plain, gap wall | 12.5 ms | 19.1 ms | 12.6 ms (25 iterations) |
| Drawn bed, gap wall | 17.3 ms | 19.7 ms | 15.0 ms (41) |
| Drawn bed, friction 3, three obstacles | 17.5 ms | 18.8 ms | 5.5 ms (2) |
| Dam spilling | - | - | 3.3 ms |

Slower advection leaves the solve less to correct each step.

### Checks

`node dev/headless_harness.js index.html`: 110 of 110 pass. New or rewritten in
`dev/model_checks.js`:

- friction makes more of the sediment settle over a drawn bed (replaces "friction slows the
  solved field", which a solver that cannot lose water fails)
- with the inflow shut the water slows toward rest (replaces the old 9b bound on leftover motion)
- a wall across the whole channel holds the river until the pond reaches its crest, then
  spills
- a spilling dam settles to passing all the inflow
- grains cross a spilling crest
- sediment settling in a pond lifts its level
- a narrow slot loses head and carries less of the river (run with `K_OPEN` and without)
- painted roughness turns the water aside without losing any

Each new check was shown to fail. `nearBed()` returning 1 fails the friction check. The
spill switched off fails the three dam checks. Friction skipped in `macDrag()` fails the
roughness check. `K_OPEN = 0` fails the slot check. Diffusion and the opening drag switched
off fail the inflow-shut check (mean 0.22 after 1200 steps). Sediment left out of the pond's
level fails the sediment check.

### Against OpenFOAM (2026-11-18)

The scene of 2026-11-13 (a drawn rise and one circle, inflow 2.5), baked again through the
bridge, which now writes its case with this repo's `bridge/case_generator.js`. Its own Python
port did not flip y and used the reference canvas's scale for every canvas, so the 2026-11-13
bake was not the scene on the page. 1.28M cells, k-epsilon, 1000 iterations. Both live
solvers were compared with the same result, each time-averaged over 600 steps after 1500:

| Live solver | Speed RMS | Bias | Vector RMS | Correlation |
|---|---|---|---|---|
| Collocated (cd40b30) | 9.9% | -0.7% | 16.8% | 0.76 |
| Staggered (e0ca1ff) | 10.9% | -0.3% | 13.3% | 0.82 |

All figures are fractions of the inflow. The staggered solver gets the direction and pattern
of the flow closer and the speeds very slightly less close. Both do much better than the
2026-11-13 figures (RMS 15%, correlation 0.51), most of that from the case now being the
scene.

### Object heights (2026-11-18)

Brad decided that every object gets a height, that a slider beside the selected object sets it, that the
default stays 0.5 m above the water, and the coast's groynes work the same way.

- The interface keeps `ob.top` per object, shows `#ob-height` beside the selected object for a
  model that declares `objectHeight`, saves the top with the scene, and reads an object with
  none as the default. An object the model calls not solid no longer stops grains.
- The river measures the top from the water surface. Under it (down to 1.9 m under), the
  object is not solid. It is raised bed in the depth grid, and the river flows over it with
  all of its water. Over a sill half the depth high the speed doubles, as the depth ratio says.
  Above the water it is a wall, and each wall's top is its crest in the dam
  (`mac.fb`, `mac.weirFb`). At the lowest inflow, a dam of a 0.2 m and a 1.5 m wall spills over
  the low one only and settles at the weir law's level for it (0.656 against 0.656). At the
  default inflow the head it needs tops both.
- The OpenFOAM export carves an object under the water to its height. One above it still goes
  through the lid. OpenFOAM's lid is rigid too, so a dam there cannot spill.
- The coast measures a structure's crest from datum. Above the live water level it is solid,
  as before. Under it the waves pass, and in each of its cells it stops the share of the water
  column below its crest. A groyne across the surf zone passes 0% of the drift at +0.5 m,
  39% at -0.6 m, all of it buried, and 23% with a 1 m surge over a +0.5 m crest. The XBeach
  export raises structures to their crests (it raised every one to 3 m above the water).

### Not done

- The dam is a rigid lid with a storage term. The pond's level is one number. The water
  upstream does not slope toward the crest, and the pond is still until it spills.

## Measurement scripts

`dev/mac-grid/`: copies of the stress-test repro scripts (`r3_repro.js`, `r8.js`,
`r6_steady_compare.js`) adjusted to load `RIVER_HTML`, plus `spikes.js`, `drop.js`,
`longrun.js`, `timing.js`, `tol.js`, `slit.js`, `hash.js` and `potential.py`. They need `h.js`
and `lib.js` from `sediment-stress-test/repro/verify-river-physics-R3/` next to them, and
`sync.sh` to build the `stam/` and `mac/` copies. Example:
`RIVER_HTML=$PWD/mac/index.html node r3_repro.js bed`.

Since stage 2 there is one solver. `sync.sh`, `r3_repro.js` and `r6_steady_compare.js` were
written for stage 1's two modes and need d48ec45 checked out to run as they were. `timing.js`,
`r8.js`, `spikes.js` and `longrun.js` run on the current page.
