# Pstack review implementation response — 4 November 2026

Version **0.22.0** implements the software response to the
[3 November engineering audit](reviews/2026-11-03-pstack/README.md) of commit
`3507527250400d25081f3793191084c9c3356a56`. The original report and its complete
80-file evidence bundle are preserved separately. This response describes new
work; it does not revise the historical audit or its measurements.

## Findings and resulting behaviour

| Review item | Change | Result and scope |
| --- | --- | --- |
| B1: checkpoint timestamp can describe a later state | Validate the requested schedule; derive engine time from integer control ticks | Unsupported intermediate checkpoints fail at setup. Accepted snapshots correspond to their control boundary. An off-grid final deadline remains supported. |
| B2: invalid physical starting footprint becomes a normal mission timeout | Apply the common clearance-aware collision predicate before controller initialization | SI/local-inlet setups that overlap an edge or obstacle fail with an actionable `RangeError`. |
| B3: unaccounted grid mass loss at a wall | Add explicitly versioned conservative face-flux transport and complete scalar budgets | New grid configurations use the conservative option. Historical backtracing remains available with an explicit nonconservative limitation. |
| No declaration presented as correct source rejection | Correct the live/batch wording and explain the denominator | Abstention and deadline silence do not claim that a source is absent. Historical numerical fields and enum values retain their meaning. |
| Comparisons across grid implementations | Include solver version, resolution and requested step in summary/chart strata | Legacy and conservative outputs are not silently combined into one median or rate. CSV identifies the effective solver and budget time. |
| Missing installed-system evidence | Add an independent commissioning and 12-mission protocol | The physical experiment is proposed, not executed or claimed as a result. |

### B1: checkpoint contract

Every requested checkpoint must be finite, positive, unique and no later than
the mission duration. Intermediate times must coincide with `fixedDt` control
boundaries. The exact final deadline may truncate a control interval. Valid
unsorted schedules and an explicitly empty schedule remain supported. The
validator rejects equivalent duplicate floating-point tick times as well as
literal duplicates; it does not silently discard requests.

The clock now uses an integer tick count multiplied by `fixedDt`, with a small
roundoff allowance at the deadline. This also fixes a related decimal-step
case: a 0.9 s mission at 0.3 s cadence previously collected four passive
samples; it now collects three. The 0.85 s final deadline in the comparison
probe still completes at exactly 0.85 s with the appropriate partial interval.

In the preserved before/after probe, the old engine accepted a 0.05 s
checkpoint carrying 1 m of completed motion from a 0.2 s step. The maximum
possible travel at the stated time was 0.25 m. The new configuration fails
before execution instead of exporting that misleading row. A separate
regression uses constant commanded speed to check accepted checkpoint path
lengths, sample counts and the sum of actual control intervals.

This is an intentional configuration contract change. Callers that shorten a
mission must supply an appropriate checkpoint list; two existing test fixtures
were updated to express their actual intended schedules or setup failures.
For exact reproduction of an old result that depended on an invalid schedule
or the decimal-clock defect, use the pinned audit commit. The historical
evidence is not overwritten.

### B2: common physical-start validation

Whenever local inlet sampling is active, the engine tests the starting centre
with the same clearance predicate used for movement. Clearance is half the
configured robot footprint diagonal, normalized by the domain size. The check
runs before controller creation/reset and covers both domain boundaries and
obstacles. The asset-inspection diagnostic retains its established
“reachable start” wording.

The original 6 m fixture placed a 0.70 × 0.31 m robot at normalized x=0.02.
The centre was only 0.12 m from the edge, while the clearance radius was about
0.383 m. Previously the mission recorded 20 blocked movements, zero travel
and an ordinary five-second budget timeout. It now raises a setup error.
Tests cover every controller listed by the factory metadata, all four edges,
obstacle-adjacent centres, valid physical starts, and valid legacy starts.
Legacy point-robot semantics and the existing unsupported physical pulse-jet
restriction remain explicit.

### B3: conservative scalar transport with preserved legacy replay

`conservative-upwind-v1` uses one upwind flux per shared cell face. Interior
transfers cancel exactly between neighbouring cells; solid faces have zero
flux. Exterior inflow concentration is zero and exterior outflow enters the
budget. Diffusion uses the same solid-face connectivity, including obstacles
thinner than a cell. Advection substeps satisfy a measured sum-of-outgoing-face
Courant limit, supplementing the existing design speed estimate.

The new solver records initial mass, source injection, decay, exterior outflow,
initial/ongoing concentration clipping, current mass and the balance residual.
Field and budget checkpoints travel together, including consistent interpolation
between solver ticks. CSV rows ask for the budget at that row's checkpoint,
and reject an attached budget with a different time. The budget unit is
normalized concentration integrated over unit-square area, not kilograms.

Independent review also checked the public point-observation path. A thin
wall could block the cell-average flux while bilinear interpolation still
read donor cells on the other side. The conservative sampler now excludes
donors hidden behind a solid segment; the legacy sampler is preserved.
Unrepresentable derived solver quantities fail clearly instead of entering
an unbounded substep loop or exporting a nonfinite conservative budget.

New `createDefaultConfig()` objects explicitly select the conservative grid
version. A historical configuration without `gridTransportVersion`, or a
direct `GridPlume` call without `transportVersion`, selects
`legacy-semi-lagrangian-v1`. The legacy option returns no conservative budget.
Its original six diagnostic outputs were reproduced byte for byte. An
independent review also compared 28 complete legacy snapshots across
reordered queries. This preserves the historical solver's numerics rather
than relabelling old fields as conservative.

See [grid transport](grid-transport.md) for the API, budget equation, boundary
conditions, clipping semantics and interpolation diagnostics.

## Numerical measurements

The full numerical report is [grid-transport.json](reviews/2026-11-04-followup/grid-transport.json).
It comes from the repository command `pnpm validate:grid`, which exits nonzero
if any of its ten checks fails.

For the original prescribed-wall fixture at six seconds and requested step
0.05 s:

| Grid | Historical mass deficit against initial mass plus injection | Conservative relative accounted residual |
| --- | ---: | ---: |
| 32² | −49.7472% | +1.80 × 10⁻¹⁴ |
| 64² | −47.6195% | −1.58 × 10⁻¹⁴ |
| 128² | −48.5814% | −3.96 × 10⁻¹⁴ |

Across all nine conservative combinations of 32²/64²/128² and requested
0.025/0.05/0.1 s steps, the maximum absolute relative residual is
**3.96 × 10⁻¹⁴**. The source integral is specified independently of the
solver. Exterior outflow and ongoing clipping are zero in these wall cases;
the small configured decay is accounted explicitly.

This is a prescribed constant wind directed into a full-height wall. It is
not a self-consistent incompressible wall-flow solution. The result verifies
scalar handling and accounting under an accepted boundary fixture. It does
not establish obstacle-flow fidelity or imply that the separate SI
half-space atmosphere had this defect.

An additional smooth reference uses uniform divergence-free flow with the
same fixed source width on 64², 128² and 256² grids. At constant Courant 0.2,
the absolute x-variance errors are 8.84 × 10⁻⁴, 4.46 × 10⁻⁴ and 2.24 × 10⁻⁴.
At fixed 128² resolution, requested steps 0.1/0.05/0.025 s give centroid
errors 2.96 × 10⁻³, 1.48 × 10⁻³ and 7.41 × 10⁻⁴. These are normalized
coordinate and squared-coordinate quantities. Both selected refinements
show approximately first-order error reduction. They are moment checks of
this reference, not a universal field-convergence result. Smaller steps at a
fixed spatial grid can increase first-order upwind numerical diffusion;
the report retains variance errors rather than hiding that tradeoff.

The independent one-step exterior-flux integral is 1.1649907040547365 × 10⁻⁷,
matching the reported outflow. The integrated decay/source recurrence predicts
1.0813339276864283 × 10⁻⁵, compared with observed
1.0813339276864285 × 10⁻⁵. A high-source fixture records both initial and
subsequent ceiling losses and closes its budget within floating-point
roundoff. Conservation alone is not evidence of accurate plume shape or
calibrated physical concentration.

## Fresh integration verification

The [command records and logs](reviews/2026-11-04-followup/README.md) retain
the executed commands, exit codes, runtimes and relevant preliminary
failures. Final source and build checks include the independent-review
corrections. No measured input or expected reference was edited to make a
test pass.

| Gate | Result |
| --- | --- |
| Full source tests | 474 passed across 41 files |
| Commissioning tests | 36 passed across 7 files |
| Production build | Passed; the existing large-bundle advisory remains |
| Grid numerical verification | All 10 checks passed |
| Packaged measurements and references | All 74 checksums passed |
| Recorded-data replay | 9 EPFL search flights, 22 Blackpool surveys, 8 MATRIX surveys and 3 EPA passes matched their references |
| Commissioning transfer sensitivity | All 10 commissioning choices matched their recorded results |
| Separate simulated holdout | All 12 mission outcomes, decisions, visits and sensor traces matched their references |
| Fresh standard and challenge missions | 36 standard rows and 14 challenge rows; all ten output CSV files are byte-identical to the audited outputs |

The fresh standard/challenge comparison includes the full readings and
decision files, not only headline mission counts. Its
[checksums and comparison results](reviews/2026-11-04-followup/mission-replay-comparison.json)
identify the originals already retained in the audit ZIP, avoiding a second
copy of identical raw readings. Their protocol/configuration records are new
versioned metadata. The unchanged outcomes include all abstentions, the
close-neighbour attribution limitation in the holdout and the absence of
native source declarations in the simulated survey panel.

## Scientific claims and remaining work

The implementation remains a reproducible simulation and recorded-path
estimation framework. A measured peak, a model endpoint, a gas-supported
estimate, a fitting-reinspection flag, a source declaration and an
evidence-backed no-source rejection are separate claims. UI wording now
matches that distinction. `correctRejection` remains the legacy offline
nondeclaration score on a known absent-source trial; changing its name or
numeric definition would silently alter historical exports, so the field
is retained and explained.

The next installed-system gate is the
[proposed Go2/A2 commissioning and 12-mission pilot](field-validation-plan.md).
It specifies independent channel-response validation, synchronized
gas/wind/inlet-pose records, blinded mapped-fitting/blank/upwind/close-neighbour
conditions, frozen scoring and complete failure denominators. No robot was
operated and no physical performance result is added by this update.

The existing recorded tracks still do not validate autonomous navigation on
unvisited trajectories. The private historical campaign archives remain
outside this checkout, so their large run-count claims are not revalidated.
The audit's optional choice of a top-level software licence remains an owner
decision. CI automation and incremental retention for every historical
campaign runner remain packaging work; neither is presented here as a
completed validation result.
