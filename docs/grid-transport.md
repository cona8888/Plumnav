# Versioned grid transport

The normalized grid is a prescribed-velocity scalar transport model. It does
not solve airflow or predict calibrated gas mass. Version 0.22 introduces a
conservative transport option and retains the historical option for replay.
The separate `halfspace-si-v1` atmosphere used by the calibrated fitting survey
is unchanged.

## Select and record the solver

| Configuration | Effective grid solver | Intended use |
| --- | --- | --- |
| A new `createDefaultConfig()` configuration | `conservative-upwind-v1` | Scalar transport experiments with explicit budgets and refinement checks |
| Explicit `gridTransportVersion: 'conservative-upwind-v1'` | Conservative upwind face fluxes | Same as above |
| Explicit `gridTransportVersion: 'legacy-semi-lagrangian-v1'` | Historical semi-Lagrangian backtracing | Reproduce historical output; qualitative comparisons |
| Historical configuration without `gridTransportVersion` | Historical semi-Lagrangian backtracing | Backward-compatible replay |

The live simulator still starts in fast-puff mode. Selecting the numerical
grid uses the configured transport version. The UI exposes the version and
states the legacy limitation. A direct `new GridPlume(scenario, seed, options)`
call also retains the legacy version if `options.transportVersion` is omitted.
Select the conservative version explicitly in new solver-level experiments.

CSV exports identify `grid_transport_version` and `grid_transport_scope`.
Summaries separate physics model, grid version, resolution and requested
solver step. Missing legacy budgets are empty fields, not zero residuals.
Configuration changes do not relabel old output as a new experiment.

## Conservative transport and boundaries

The new option advances cell-average concentration with a shared upwind flux
on each open cell face. Each interior face removes exactly the amount added
to its neighbour. Faces intersecting a solid obstacle carry zero scalar flux;
the same face connectivity is used by diffusion. Exterior advection has zero
incoming concentration and accounts for outgoing scalar. Diffusion uses
no-flux outer and solid boundaries.

The solver checks the actual sum of outgoing face speeds for each cell and
subdivides advection as needed to keep its outgoing Courant number at most
0.9. This check supplements the configured speed estimate. The five-point
explicit diffusion step retains its positivity limit
`D * dt / dx² <= 0.22`. Transport, diffusion, exponential loss and source
forcing are split operations. The method is first order in advection and is
numerically diffusive; conservation is not a spatial-accuracy guarantee.
At fixed spatial resolution, a smaller time step can increase upwind numerical
diffusion. The numerical validator reports both centroid and variance errors
instead of assuming that every error improves with a smaller step.

For conservative point observations, interpolation excludes donor cells whose
segment to the query point crosses a solid obstacle. This prevents a thin wall
from blocking cell-average flux while allowing a sensor to read gas through
the interpolation stencil. The historical sampler is retained by the legacy
version. Unrepresentable derived steps, forcing or budget quantities raise a
clear error rather than returning a nonfinite budget or an unbounded loop.

The wind remains the existing analytical prescribed field. Closing wall faces
does not make that velocity field an incompressible obstacle-flow solution.
Concentration can accumulate upstream of a closed wall. In particular, the
audit's constant wind directed into a full-height wall is an accepted scalar
boundary test, not a physically self-consistent airflow experiment.

## Mass accounting

`gridAt(time).massBudget` and `massBudgetAt(time)` report the conservative
budget. The mass unit is normalized concentration integrated over the
unit-square domain; these values are not kilograms or an SI leak rate.

For each queried field, the residual is:

```text
currentMass - (initialMass + injectedMass - decayLossMass
               - boundaryOutflowMass - upperClippingLossMass
               + lowerClippingGainMass)
```

`initialMass` is the field after the initial concentration ceiling.
`initialClippingLossMass` records any loss before time zero separately, so it
must not be subtracted from `initialMass` again. The first-order loss budget
includes the configured dilution and any near-surface terrain loss. The
normalized concentration ceiling remains 1; clipping is an explicitly
accounted sink, not a physical saturation model. Any lower clipping gain is
also visible and should be checked in a numerical experiment.

Canonical solver ticks retain both the field and its cumulative budget. An
off-tick query linearly interpolates both bracketing states. Consequently the
budget and displayed field refer to the same query time. The maximum Courant
number and substep count are diagnostics of the upper bracketing state, as
documented in the API; they are not fractional work counts. Batch exports ask
for each checkpoint's budget instead of copying the final mission budget.

The legacy option returns `massBudget: null`: its historical backtrace wall
treatment has no conservative flux account. The original audit observed about
48–50% unaccounted loss in its prescribed-wall fixture across 32², 64² and
128² grids. The [unaltered audit](reviews/2026-11-03-pstack/review.md) contains
the configuration, measurements and qualifications.

## Verification and limits

Run the focused tests and reproducible transport measurements from the
repository root:

```sh
pnpm test --maxWorkers=2
pnpm validate:grid
```

The [implementation response](review-followup-2026-11-04.md) records the exact
checks, measured results and retained output for this change. The numerical
checks cover scalar budgets, positivity, blocked faces, exterior outflow,
loss and clipping, query order, and refinement of a smooth transport
reference. They do not validate obstacle wakes, a three-dimensional flow
field, atmospheric turbulence, species-specific terrain behaviour, or the
installed gas sensor.

For a new scientific case, report its chosen version, resolution, requested
and effective step, complete mass budget, and a case-specific spatial/time
refinement study. An acceptably small budget residual establishes accounting
for that discretization. It does not establish physical fidelity or resolve
a source more accurately than the grid and observation model permit.
