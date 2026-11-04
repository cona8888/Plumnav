# Grid followup edge hardening — completed

Only `src/sim/gridPlume.ts` and `src/sim/gridPlume.conservation.test.ts` changed in this followup. No commits or pushes; no SI solver changes.

## Corrections

1. Conservative public interpolation now excludes a donor cell whenever the segment from the query point to its centre intersects a solid. This closes the thin-wall sampling path for both scalar and batched reads. Legacy interpolation is untouched. Regression tests cover four right-side positions, positive left-side readings, canonical and off-tick times, ordinary four-donor interpolation in an open region, and the exact historical thin-wall reading.
2. Conservative transport now rejects non-finite derived Courant numbers and unsafe substep counts before entering the loop. It also rejects non-finite/non-positive effective timesteps and unsafe canonical query tick counts, covering vanishing positive timestep inputs that could otherwise create an unbounded outer evolution loop.
3. Conservative source handling now rejects nonrepresentable raw initial concentrations, initial clipping budgets, source forcing, per-cell updates, or cumulative budget terms. Checks use numeric representability rather than an arbitrary physical source-rate cap. Valid legacy numerics remain unchanged.

The new thin-wall regression was executed before the correction and failed with a right-side public reading of `0.4648000000000003` despite a zero right-side stored field. The original regression output is preserved as `grid-edge-tests-before.log`.

## Executed checks

From `/workspace/scratch/8442b2e50dcd/plumnav_update/repo`:

```sh
node node_modules/vitest/vitest.mjs run src/sim/gridPlume.test.ts src/sim/gridPlume.sourceNormalization.test.ts src/sim/gridPlume.conservation.test.ts --reporter=verbose
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
node node_modules/vite-node/vite-node.mjs ../logs/grid-legacy-before.ts > ../logs/grid-legacy-after-edge-fixes.json
cmp ../logs/grid-legacy-before.json ../logs/grid-legacy-after-edge-fixes.json
node node_modules/vite-node/vite-node.mjs scripts/validate-grid-transport.ts --output ../logs/grid-transport-after-edge-fixes.json
cmp ../logs/grid-transport-validation.json ../logs/grid-transport-after-edge-fixes.json
git diff --check -- src/sim/gridPlume.ts src/sim/gridPlume.conservation.test.ts
```

Results: focused grid suite **31/31 passed**, app typecheck passed, both byte comparisons passed, all 10 transport-validator checks passed, whitespace check passed. The source/boundary/decay/clipping and refinement measurements did not change.

The software reviewer independently confirmed **36/36 including batch integration**, passing app typecheck, all four thin-wall right-side readings zero, unchanged historical public readings, 28 exact historical snapshots, 14 conservative reordered snapshot comparisons plus returned-snapshot mutation checks. Its overflow subprocess now exits with RangeError in approximately0.725s including startup, instead of timing out. Huge-source initialization rejects clearly; the ordinary high-source80 fixture retains a finite balanced budget. Parent was notified directly by that reviewer.

## Artifacts

- `grid-edge-tests-before.log`: reproduced original sampling failure.
- `grid-edge-tests.log`: passing 31-test focused suite.
- `grid-edge-tsc.log`: empty successful typecheck output.
- `grid-legacy-after-edge-fixes.json`: byte-identical historical probe output.
- `grid-transport-after-edge-fixes.json`: byte-identical numerical validator output.

All artifact paths are under `/workspace/scratch/8442b2e50dcd/plumnav_update/logs/`. The independent reviewer owns its separate after-fix evidence files.
