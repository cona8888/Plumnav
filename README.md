# PlumeNav Lab

PlumeNav Lab is an offline, two-dimensional gas-source-localization demonstrator and seeded research workbench. It presents one algorithm at a time in the live simulator, then compares selected algorithms at fixed checkpoints on paired plume realizations.

Current research status (13 September 2026): M71 v7 completed and passed the
independent archive audit (280 cells, 67,200 runs). Quad-Sniff-Refine produced
zero correct declarations in 6,960 emitting missions. The
[updated publication plan](research/protocols/publication_plan_review_2026-09-13.md)
prioritizes physical sampling/evaluation integration, observable independent
transport cases, mechanism tests and then held-out comparison. The demo's
normalized remote sampling footprint is not a validated suction device.

[Stage 1 diagnostic progress](research/results/m72_stage1_diagnostic_findings_2026-09-13.md):
eleven selected frozen-code M71 replays now retain full decision histories and
match the original scientific metrics exactly. A separate active-leak evaluator
distinguishes false leak declarations, supported rejection and unresolved
surveys. Confirmation-contract defects have reproducible fixtures; the live
controller and demo sensing were left unchanged at that diagnostic stage.

[Local-inlet integration](research/results/m73_local_inlet_integration_2026-09-13.md):
an opt-in research mode now connects SI head spacing, tube delay, sensor response,
sampling cadence and robot motion to the engine. Its confirmation contract fixes
the diagnosed timing/geometry mismatches. The normal demo still uses legacy mode;
eight short physical-mode checks completed but did not localise a source.

[Bounded-scan diagnostic](research/results/m74_bounded_scan_findings_2026-09-13.md):
an additional opt-in acquisition policy limits stationary repeats and requires a
small relocation. It removed the observed repeat-scan stall on the paired test
worlds, but all eight missions remained unresolved. Candidate acquisition and
the complete physical confirmation lifecycle still require validation.

[Directional-information and timing audit](research/results/m75_directional_audit_2026-09-13.md):
an opt-in geometry correction preserves direction estimates across coordinate
scales, but the existing physical-head trajectories have insufficient expected
directional contrast. The current refinement sequence also exceeds the short
mission budget and conflicts with evidence expiry. Controlled acquisition and
confirmation-lifecycle repair are the next local gates; AWS is not needed yet.

[Bounded inspection commissioning](research/results/m76_inspection_lifecycle_2026-09-13.md):
an opt-in bounded candidate prior now allows a fresh physical confirmation circuit
to finish after raw rays expire. A seeded narrow-peak control passed using actual
motion and channel dynamics; negative controls did not declare. All five unseeded
controlled-field cases remained unresolved. Acquisition is the next local gate,
not a large benchmark or a claim of end-to-end localisation success.

[Acquisition scheduling audit](research/results/m77_acquisition_scheduling_2026-09-13.md):
a scheduling-only variant returned a second broad-peak bearing at 47 s instead
of 102 s and retained two rays instead of one in two development seeds. None of
24 unseeded controlled runs formed a multi-ray candidate or declared. Physical
spatial scaling and the bearing model remain unresolved; thresholds were not relaxed.

[Physical bearing-geometry revision](research/results/m78_physical_bearing_geometry_2026-09-13.md):
a separately versioned local-gradient/uncertainty variant now completes unseeded
acquisition and fresh confirmation on the near-peak fixture in two development
seeds. Broader and unobserved peaks remain unresolved. A coherent-bias
counterexample shows why nominal uncertainty cannot establish field accuracy.
Independent transport validation and mechanism ablations are still required.

[Ablations and controlled robustness](research/results/m79_bearing_ablations_2026-09-13.md):
180 paired local runs now isolate four component removals across nine conditions
and four new development seeds. The full variant succeeded in all 12 steady,
coincident-peak reference/rotated/narrower cases, but broad and intermittent cases
remained unresolved. Displaced peaks were found while the designated buried
source was missed by about 2 m. These are controlled peak-localisation results,
not a validated buried-leak or outdoor-performance claim.

[Pointwise transport transfer check](research/results/m80_halfspace_integration_2026-09-13.md):
a 3-D analytical advection–diffusion reference now feeds the four physical inlets
at 5 cm height while robot motion stays 2-D. Cross-implementation and inlet
quadrature checks passed, but all 24 emitting missions remained unresolved;
two blank controls also made no declaration. Good local-gradient sensing did
not establish source-bearing accuracy. Transport-aware acquisition and the
oldest-ray scheduling guard are the next local gates, not a larger AWS run.

[Rolling acquisition and physical-gate diagnostics](research/results/m81_rolling_ray_window_2026-09-13.md):
60 paired missions isolate an opt-in scheduling repair. It removes waiting for
the oldest ray without extending evidence lifetime; lower-wind steady cases
increase from 20 to 37 scans. Atmospheric localisation still fails in all 24
emitting cases, with inconsistent/unstable bearing fits, while the two static
positive controls retain their success. All 30 original decision histories
replay exactly. Revising the gradient-to-source assumption is the next local task.

[Local-gradient acquisition experiment](research/results/m82_local_gradient_acquisition_2026-09-13.md):
60 paired missions test one-head-spacing gradient moves without inventing source
bearings. Final release proximity improves in 9/24 atmospheric pairs, worsens in
13 and ties in two. Some runs approach the airborne maximum, which is displaced
15–26 cm from the release in the steady reference fields. Static runs reach the
peak but then leave when direction weakens. This is acquisition-only, not a new
localisation-success result; bounded local-maximum verification is next.

[Bounded local-contrast verification](research/results/m83_local_maximum_2026-09-13.md):
68 completed missions test a fresh nine-visit cross pattern. One static hotspot
is supported and held about 3 cm from the peak; another candidate and four
plateau/ridge attempts are rejected. No atmospheric case initiates a probe.
Thirty M82 histories replay exactly. A retained temporal-alias counterexample
limits the result to local contrast, not proof of a spatial maximum or leak source.

[Nomination and recentering component experiment](research/results/m84_local_maximum_components_2026-09-13.md):
152 missions separate broader candidate nomination from bounded half-step
recentering while keeping acceptance unchanged. Combined support reaches 5/24
emitting transport cases (all continuous) and 2/2 static peaks; pulsed transport
remains unresolved. All 38 M83 reference histories replay exactly, and fresh
sample provenance passes audit. These are local-contrast witnesses, not source
declarations. Temporal-alias sensitivity is the next local gate; AWS is not needed.

[Temporal-alias and repeat-order experiment](research/results/m85_temporal_order_2026-09-13.md):
162 seeded verification-only missions reproduce false spatial support in two
oscillating-uniform controls through actual sensor dynamics. Both repeat orders
remove those supports but also reject all modulated peaks; reversal has no
acceptance advantage over a same-order repeat. Steady peaks remain supported.
Temporal nuisance separation, not automatic repeat integration, is the next
local gate. No leak-source claim or AWS launch follows from these results.

[Centre-only temporal nuisance experiment](research/results/m86_temporal_nuisance_2026-09-13.md):
90 verification missions test an offline time-aware score on new temporal
conditions and seeds. It recovers 4/6 slow-oscillation peaks, but overall peak
support falls from 18/42 to 14/42; uniform and blank controls remain unsupported.
Separate numerical and sample audits pass. Noise-aware model selection and
interpolation validity need work before controller integration; no AWS is needed.

[Completed model-selection experiment](research/results/m87_model_selection_2026-09-13.md):
126 fresh simulations plus 198 archived rescoring records test affine-first and
per-round temporal fits. Fresh peak support is 17/48 versus 9/48 for the original
repeat rule, with 0/78 non-peak supports. The new selection variants add no fresh
acceptance gain over M86, although they repair archived failures. Tests and a
separate numerical/provenance audit pass. This bounded experiment is complete;
scores remain offline and are not validated leak-source declarations.

[Settling-time control experiment](research/results/m88_settling_timing_2026-09-13.md):
252 missions compare unchanged timing, longer dwell and later sampling; all 84
reference histories replay exactly. Later sampling leaves time-aware peak support
at 11/32 overall; longer dwell reaches 13/32 but retains more samples. All 52
non-peak controls per arm remain unsupported. Audit passes. Extra waiting is not
adopted as a general fix; sensor-history modelling remains a separate task.

[Independent channel-history reference](research/results/m89_channel_history_2026-09-13.md):
12 exact replays record local inlet histories for an offline response audit.
Independent integration agrees with clean simulator outputs within 5.12e-12;
20% response-time mismatch exceeds the contrast-margin scale at retained samples
in 8/12 cases. This uses true inputs only as an oracle and is not an inverse
estimator or new localisation result. Observation-only fitting with calibration
uncertainty is the next experimental boundary.

[Observation-only inverse commissioning](research/results/m90_observation_inverse_2026-09-13.md):
120 fits on 30 archived records use measured concentrations and candidate-relative
poses, without true inlet histories. A restricted quadratic/linear-time model
supports 4/10 peaks and 0/20 non-peak controls, with no acceptance advantage from
response correction. Calibration remains ambiguous on settled observations.
Input-isolation, forward-prediction and residual audits pass; the estimator stays
offline pending a controlled temporal-model extension.

[Periodic inverse-model ablation](research/results/m91_periodic_inverse_2026-09-14.md):
120 new fits and 120 exact M90 fit replays test a training-selected oscillatory
term. Peak support increases from 4/10 to 6/10, with 0/20 non-peak supports.
The instantaneous comparator gains the same cases, so added temporal structure,
not response correction, explains the acceptance improvement in this set.
Other temporal conditions need a frozen transfer check before integration.

[Frozen inverse transfer](research/results/m92_inverse_transfer_2026-09-14.md):
96 archived cases, 768 fits; periodic peak support 20/38 versus 8/38 affine.
Response-aware variants reject all 58 non-peak controls.

[Fresh response safety](research/results/m93_response_safety_2026-09-14.md):
192 new verification missions support 72/72 in-range peaks and reject 72/72
corresponding uniform controls; out-of-range response remains a limitation.

[Transport transfer](research/results/m94_transport_inverse_2026-09-14.md) and
[offset-peak ablation](research/results/m95_offset_ablation_2026-09-14.md):
the centred model fails all tested transport candidates. Adding spatial gradients
recovers 6/6 steady candidates and 2/2 static peaks but reduces oscillating-peak
support. Pulsed transfer remains unsupported. These are research-only local
maximum checks, not end-to-end leak localisation. AWS is not yet justified.

[Fresh adaptive-model transfer](research/results/m96_adaptive_transfer_2026-09-14.md):
72 fresh missions test a training-only simpler-model-first rule. Calibration-range
scoring supports 12/12 centred peaks, 4/12 offset peaks and 0/48 non-peak controls.
Offset/lag robustness and pulsed transport remain scientific gates before scaling.

[SI review handoff validation](research/results/si_integrity_round1_2026-09-14.md):
44 fresh local missions add clipping abstention, diagonal inspection and full
quadratic curvature checks. Peaks and steady SI transport receive conditional
support; saddle/ridge/flat/blank controls, clipping and pulsed inconsistency do not.
Only 6/22 timestep comparisons pass all frozen tolerances despite unchanged
decisions. Numerical timing/noise isolation is the next gate; no AWS was launched.

[SI timing follow-up](research/results/si_clocked_arrival_2026-09-14.md):
the zero-noise rerun confirms that readout noise does not explain the timing
failure. A versioned clock-aligned dwell policy makes retained sample timestamps
identical across timesteps and raises tolerance passes to 14/22 with nominal
noise and 13/22 without noise. Matched-sample concentration and pose differences
still block the full numerical gate. The Mac completed all 99 follow-up missions.

[Matched-pose sensor replay](research/results/si_matched_pose_response_replay_2026-09-14.md):
the audited offline replay decomposes 1,870 matched readouts and independently
checks 9,312 channel outputs. Steady-case differences mostly follow waypoint
position; the pulsed case also reflects sensor history. The numerical gate
remains open.

[Precision-arrival numerical diagnostic](research/results/si_precision_arrival_2026-09-15.md):
the versioned 1 mm effective waypoint policy completes 66 local missions and
raises the frozen timestep pass count to 42/44. Both remaining failures are
coarse-timestep pulsed readouts. Every retained waypoint is hit exactly in
this ideal simulator, so the result establishes neither real 1 mm positioning
nor buried-leak localization. The pulse integration and nonzero pose-error
gates remain open; AWS is not yet needed.

[Fixed-pose pulse/interface isolation](research/results/si_pulse_interface_isolation_2026-09-15.md):
36 stationary runs and 17,280 independently replayed channel readouts identify
approximately first-order error at the zero-order-held plume-to-sensor boundary,
not in the localization algorithm. Against dt=0.015625 s, dt=0.0625 passes all
54 frozen pose-windows; dt=0.125 passes 40 and dt=0.25 passes none. A short
moving-path fine-step confirmation is the remaining local numerical gate.

[Moving pulse fine-step confirmation](research/results/si_pulse_moving_convergence_2026-09-15.md):
all four nominal/zero-noise comparisons at dt=0.0625 and 0.03125 pass against
dt=0.015625 under the original median, coefficient, timing and decision gates.
The current 20 s pulse model therefore adopts dt=0.0625 as a restricted operating
timestep. A nonzero pose/heading-uncertainty pilot is next; AWS is not yet needed.

[Pose/head uncertainty pilot](research/results/si_pose_uncertainty_pilot_2026-09-15.md):
68 audited missions show that observed sample pose preserves all decisions through
3 cm bounded waypoint error and 7/8 at 5 cm, whereas assuming commanded pose loses
all positive confirmations even at the 1.5 cm bound. Tested head errors through
20° preserve all decisions, and no control becomes a false positive. This is a
two-seed hypothesis-setting pilot; its larger registration study is suitable for
parallel AWS execution after a local packaging dry run.

## Run locally

Requirements: Node.js `^20.19.0` or `>=22.12.0`, plus pnpm. Determinism checks
must use the same Node and V8 versions across compared runs.

```bash
pnpm install
pnpm dev
```

Open the URL printed by Vite. Production and verification commands are:

```bash
pnpm build
pnpm test
pnpm preview
```

The production build is written to `dist/` and works without a server-side API.

### Reproducible research benchmark

The research runner is separate from the browser demonstration. Publication
designs create
nominal development, validation, and test partitions; gives every method the
same world/source/controller/observation-model seed quadruplet; and generates a new
navigable source, start, initial heading, and source–wind relationship for each
paired layout. The test partition becomes genuinely held out only when the
documented operational freeze/unlock procedure is followed.

```bash
# Validate the independent development-only commissioning design
pnpm benchmark:design

# Run its 20-second, single-worker end-to-end workflow check
pnpm benchmark:ci

# Recommended M3 Max commissioning run (fresh directory required)
pnpm benchmark:local -- --profile commissioning \
  --output /private/tmp/plumenav-local-commission-run --workers 8

# Continue an interrupted run; every reused cell is re-hashed and revalidated
pnpm benchmark:local -- --profile commissioning \
  --output /private/tmp/plumenav-local-commission-run --workers 8 --resume

# Verify the manifest, runner, and analysis modules
pnpm test:research

# Validate the frozen source-present and no-target development pilots only
pnpm phase2:dry-run
pnpm phase3:safety-dry-run

# Verify the checked-in development comparator replay archive
pnpm baseline:replay-verify
```

`pnpm baseline:replay-evidence` executes the 18 development comparator
fixtures and publishes a new, atomically written evidence generation. It
refuses to overwrite an existing generation; set a new
`BASELINE_REPLAY_OUTPUT_DIR` when a separately named rerun is required. The
archive contains exact traces, outputs, source snapshots and checksums, but it
is a software-conformance record—not a performance benchmark or canonical
reproduction of the cited methods.

The local coordinator currently permits only the separate `commissioning`
profile: 24 independent development cells using seeds that are absent from the
nominal development/validation/test designs. This prevents worker tuning from
consuming a future confirmatory layout. It enforces one token-owned coordinator
lock, same-runtime workers, strict cell fingerprints, full raw hashes and a
scientific hash that excludes only the two host execution-timing columns.

The `pilot` profile has 32 independent paired layouts per scenario/partition.
The `full` profile has 200 and must be run only after the protocol and code are
frozen and a stage-specific holdout runner is implemented; the local
commissioning CLI intentionally refuses these profiles. See
`research/protocols/headless_benchmark_protocol.md` for invocation and
resumption. Commissioning outputs include a source-file inventory, runtime
fingerprint, raw per-checkpoint CSV, paired comparison CSV, full JSON analysis,
cryptographic cell records, a complete deterministic-core inventory, and an
append-only execution ledger.
The measured M3 Max worker decision and Mac-to-AWS sequence are recorded in
`research/protocols/mac_first_compute_runbook.md`.

The runner labels Quad-Suction active, time-matched zero-strength sham, and
sampler-disabled arms separately. Single-inlet, serial-inlet, systematic-wind-bias,
and true passive-four-channel controls remain declared gaps rather than being
approximated by an unrelated setting. A completed workflow check is not a
scientific result; only the preregistered held-out profile may support the
defined simulation claim.

Only the untouched test partition receives the runner's default inferential
analysis. Every raw row is bound to the frozen manifest digest and checked
against its cell, arm, checkpoint, seeds, placement, wind, physics, resolution,
and nuisance settings before pairing. Development and validation data remain
available for tuning and sensitivity work without being pooled into the
confirmatory comparison.

### Single-file offline demo

After `pnpm build`, run `pnpm build:portable`. This creates
`release/OPEN_ME_PlumeNav_Lab.html`, with all CSS and JavaScript embedded. Copy
that one file to another computer and double-click it in a current Chrome,
Edge, Firefox, or Safari browser; no installation, internet connection, or
local server is required.

The 0.15.0 demo includes the separate experimental **Quad-Suction Confirmation
Priority** (`quad-sniff-confirmation`, M12) controller. It preserves the M10
candidate/declaration rules but gives confirmation approach and stationary
dwell priority over gradient bursts. The original `quad-sniff` remains the M10
comparator. This correction is not a demonstrated localization-performance or
active-suction advantage. Its small, reused-development-world mechanism check
is documented in `research/protocols/m12_confirmation_scheduling_protocol.md`.
The canonical current portable build is `OPEN_ME_PlumeNav_Lab.html`; older
similarly named HTML/ZIP files in `release/` are not updated by this command.

Version 0.17.1 retains six commercially anchored point/extractive methane-sensor
presets (MPS MEMS, lower-cost MEMS-MOS, sub-£50 MQ-4, NDIR, TDLAS and CRDS), adds an informational open-path TDLAS
comparator, and applies measurement noise after causal sensor memory so
rectified noise is not accumulated as physical signal. Manufacturer-native ppm specifications are translated only through
an explicit concentration-bridge assumption; they are not presented as a
calibration of the dimensionless plume solver. See
`research/protocols/commercial_sensor_presets.md`.

Version 0.17.1 also adds the development-only **Wind-Constrained Quad-Suction**
arm (`quad-sniff-wind`). It combines an upwind transport bearing with only the
crosswind component of the four-head concentration gradient. M62 development
results improved endpoint error but produced no correct source declarations;
the arm is therefore not promoted as a validated candidate. See
`research/analysis/m62_wind_constrained_diagnosis_2026-09-12.md`.

The separate **Quad-Suction Range Belief** (`quad-sniff-range`) is retained as
a labelled negative ablation. In M63 it applied a truth-blind one-dimensional
hit/non-hit posterior along the wind-constrained bearing. On 240 new-seed
development missions its median error was 3.07–4.08 times the bearing-only
controller, despite reducing the obstructed-case p90 tail; neither arm made a
native declaration. It is not the proposed method and must not be described as
validated. See
`research/analysis/m63_range_belief_diagnosis_2026-09-12.md`.

Version 0.18.0 adds **Quad-Corridor** (`quad-sniff-corridor`) as a second
labelled negative ablation. Its frozen M64 two-dimensional posterior represented
angular uncertainty and failed back to Quad-Wind when diffuse. In 240 new-seed
missions it lowered the dry-open p90 error but worsened all four median errors
and reduced strict proximity from 15/120 to 9/120; neither arm declared a
source. It failed its pre-specified advancement rule and is not the proposed
method. See
`research/analysis/m64_corridor_belief_diagnosis_2026-09-12.md`.

Version 0.19.0 adds **Quad-Bracket** (`quad-sniff-bracket`) as a third labelled
negative ablation. It replaced absolute terminal concentration thresholds with
an alternating centre/cardinal, paired rank test while retaining Quad-Wind
navigation. Across 240 emitting and 240 no-emission development missions it
made no correct, wrong, or spurious declaration, and therefore failed its
pre-specified advancement rule. A post-outcome replay found confirmation phases
in many dry-sand runs but exposed missing bracket-gate telemetry that must be
fixed before redesign. See
`research/analysis/m65_spatial_bracket_diagnosis_2026-09-12.md`.

Version 0.19.1 adds a behavior-preserving bracket audit trail. A replay of all
120 M65 emitting Quad-Bracket worlds matched every checked scientific output.
Only 5/65 initiated bracket attempts completed the full route, and all five
completed attempts failed the paired centre-win gate. This localizes both a
route/candidate-lifecycle bottleneck and a genuine local-rank failure without
retuning M65. See
`research/analysis/m66_bracket_telemetry_audit_2026-09-12.md`.

Version 0.20.0 adds **Quad-Refine** (`quad-sniff-refine`). It uses a shorter
three-direction bracket and at most two bounded moves toward a stronger flank
before local-maximum confirmation. It passed its frozen M67 development rule:
one correct and zero wrong declaration, median improvement in three of four
emitting cells, 22/120 versus 21/120 strict proximity, and zero spurious
declarations in 120 no-emission safety trials. The dry-open p90 worsened sharply
and only one correct declaration occurred, so this is a development candidate,
not validated superiority evidence. See
`research/analysis/m67_coordinate_refinement_result_2026-09-12.md`.

Version 0.20.1 restricts coordinate-refinement evidence to commanded stationary
dwell samples, correcting a transit-sample provenance defect found by M68.
M69 passed four-direction tail retesting and M70 passed sensor, slope and
obstacle nuisance smoke gates. Those development gates led to the M71 AWS
campaign; they did not establish reliable declarations or a physically
validated sensing model. See the historical record in
`research/analysis/m68_m70_local_transfer_and_aws_gate_2026-09-12.md`.

M60–M61 adds a narrow homogeneous-soil sensitivity study: representative
ROSETTA-prior sand and clay columns at water saturations 0.2, 0.5 and 0.8 feed a
locked 2,160-mission localization benchmark through relative seven-day surface
flux. The result is negative for the current candidate and must not be cited as
superiority evidence. See
`research/analysis/m61_soil_localization_2026-09-12/stage4-report.md`.

M13 adds a research-only flow-aware confirmation diagnostic, not a selectable
app controller. It passed the open known-source case but failed the predefined
obstructed-source/geometry checks; M12 therefore remains unchanged. See
`research/protocols/m13_flow_confirmation_execution.md` for the completed
24-run result, four unavailable prescribed jobs, verification and limitations.

M14 adds a research-only **sniff–turn–sniff** policy with map-safe repositioning
fallback. In forty bearing-corrected diagnostic runs, turning restored
directional identifiability at the obstructed source (0/12 to 11/12 returns)
but did not pass the source-confirmation criteria. Two separate controls with
concentration noise disabled passed the obstructed source and still failed the
open source. These are prescribed-pose diagnostics, not localization success
or evidence of algorithm superiority. The live app remains unchanged. See
`research/protocols/m14_sniff_turn_execution.md` for results, preserved
corrections, verification and the next measurement-calibration target.

M15 completed that controlled calibration: 1,440 manufactured-field observation
trajectories and 2,880 paired-window analyses. Smaller footprints reduced
noise-free spatial error but amplified measurement noise; a shorter fitting
window only partly reduced time-varying-field error. These are mathematical
calibration controls, not independent outdoor/urban performance trials. See
`research/protocols/m15_measurement_calibration_execution.md` for the measured
tradeoffs and the joint space/time, scale-aware confirmation target. No
experimental estimator has been promoted to the live app.

M16 implemented the two-scale space/time candidate and tested 390 additional
parameter-transfer trajectories. It improved steady noise-free reconstruction,
but failed the predefined changing-field and pooled noisy-error gates. It is
not promoted to the app or a larger physical-plume benchmark. See
`research/protocols/m16_space_time_multiscale_execution.md` for the conditional
comparisons, verification and the proposed paired-acquisition/prediction-check
direction. A better fit to sensor readings did not guarantee better physical
derivative estimates.

## Physics fidelity and interactive flow

The live simulator offers two deterministic forward models:

- **Fast puffs:** the original Lagrangian filament approximation for responsive demonstrations and broad Monte Carlo studies.
- **2D numerical:** a selectable 32²–128² live grid using semi-Lagrangian convection, a stable five-point diffusion stencil, first-order dilution, a boundary-aware resolution-normalized source kernel, and solid obstacle cells. Research manifests may request up to 256² for convergence checks. The field is evaluated on canonical solver ticks, so results do not depend on visualization or query order. The requested grid step is separate from controller/sensor/motion cadence and may be reduced by stability or Courant limits; exports retain both requested and effective values.

Both modes use the same configured wind field, source, start, obstacles and seeded randomness. The numerical forward field deliberately retains the lightweight analytical inverse encounter model used by the controllers. This creates an explicit forward/inverse model-mismatch test rather than giving an algorithm the true grid solver as an oracle. Neither mode is CFD or a Navier–Stokes solution.

The target-condition control separates three private truth states. `Emitting`
has a source and configured gas output. `Zero emission` retains the private
source coordinate but produces no physical gas, so localization remains
source-referenced under an intentionally uninformed controller prior. `Absent`
has no source coordinate and no gas; localization error and source-relative
path overhead are therefore N/A, while spurious declaration, explicit
abstention and correct rejection at the fixed deadline are scored separately.
Controllers do not receive the selected truth label.

The live scenario card exposes six transport and source overrides. Every change rebuilds the seeded run so the canvas, sensor, controller likelihood and later benchmark use the same atmosphere and source forcing.

- **Wind direction (toward):** compass heading, where 0° is north and angles increase clockwise.
- **Mean speed:** dimensionless multiplier of the selected scenario's baseline convection speed.
- **Turbulence:** multiplier of the baseline directional meander and wake variability.
- **Gust amplitude:** upper bound on local speed oscillation around the mean.
- **Diffusivity:** multiplier of the scenario's baseline diffusion coefficient.
- **Source emission rate:** dimensionless multiplier of the scenario's baseline source output. `1.00×` is the reference output; this is not a calibrated mass-flow rate or source pressure.

`Restore defaults` resets only these six controls. Open and obstructed scenarios retain different baseline speed, turbulence and diffusivity, while overrides are applied consistently to every algorithm. The CSV export records all six values.

In fast-puff mode, puff centres advect with the controlled mean wind and bounded gust factor, while Gaussian width grows as `sigma = sigma0 + sqrt(2 D t)`. Gaussian amplitude is adjusted as width changes so a diffusivity override redistributes, rather than creates, emitted puff mass. The emission-rate multiplier scales source forcing before transport; it changes signal strength without changing the source location, wind, or diffusion. Turbulence adds crosswind meander, and puff intensity decays through dilution. Obstructed fast flow adds orientation-aware heuristic wake displacement and line-of-sight attenuation.

Emission rate is intentionally dimensionless because the simulator has no calibrated gas species, nozzle geometry, pressure–flow relation, or concentration unit. Raising it can increase plume contacts but can also drive the configurable sensor into saturation; lowering it can push readings below the detection threshold. Treat it as a signal-strength sensitivity variable, not as a physical leak-rate prediction.

## Planar 2.5D slope model

Slope is implemented without turning the simulator into a three-dimensional flow solver. The canvas, obstacles, localization estimates, and controller coordinates remain a horizontal 2D plan view. A single implicit elevation field is attached to that plane:

`h(x,y) = tan(α) a · ([x,y] - [0.5,0.5])`,

where `α` is the selected slope angle and `a` is the selected uphill unit vector. A robot segment therefore has exact surface length `sqrt(dx² + dy² + dh²)`, even though only its plan projection is drawn. The controls expose slope angle, uphill compass direction, a gas-response class, buoyancy-coupling strength, and a robot reference grade.

Robot motion uses a transparent reduced-order mobility proxy. Plan speed includes the exact surface-to-horizontal projection. Uphill speed is additionally limited by a constant-specific-power approximation using rolling resistance plus the gravity component along the commanded direction; cross-slope travel receives a bounded stability derating. Downhill surface speed is capped at the nominal command to represent braking. This produces directional travel-time and distance effects, but it is not a wheel-slip, soil, suspension, rollover, or motor thermal model. The engine records plan distance, surface distance, ascent, descent, and mean mobility separately.

Near-surface gas transport is deliberately separated from measured ambient air velocity:

- **Neutral:** gas follows the configured ambient wind; slope adds no buoyancy term.
- **Dense:** the gas transport velocity receives a uniform downslope sensitivity term with magnitude `0.04 k sin(α)` domain lengths per second, where `k` is the user coupling control. This is a shallow gravity-current proxy inspired by dense-gas slope studies, not a species-calibrated closure.
- **Light:** no fictitious uphill plan velocity is added. Instead, represented near-ground gas receives an **additional heuristic slope-coupled depletion** at first-order rate `0.06 k sin(α)` per second. It intentionally vanishes on flat terrain for paired flat-regression tests; it is not a general law for vertical buoyancy, which would not scale this way.

Both fast-puff and numerical-grid forward models use the same terrain gas response. Wind arrows, wind observations, and controller anemometry still show ambient air velocity; only plume transport includes dense-gas drainage. The active-olfaction probe's axial reach is interpreted as a surface length and projected into the map; its small lateral sampling fan remains a plan-view observation kernel. Diffusivity remains the configured **effective plan-view diffusivity** in both solvers: the app does not claim to implement a Laplace–Beltrami surface diffusion tensor or vertical dispersion.

Model knowledge is intentionally explicit but not identical across method families. Infotaxis, SMC/KL, and PMFS evaluate their candidate-source likelihoods with the selected reduced-order terrain gas response. Surge–Cast and Pulse–Sniff act from measured ambient wind and concentration and do not receive dense-gas drift as an artificial anemometer signal. A sloped benchmark therefore compares terrain-aware inverse models with ambient-wind-reactive policies as well as comparing search logic; performance gaps must not be attributed to algorithm quality alone.

The benchmark treats every slope angle, aspect, gas class, coupling value, and robot reference grade as a separate experimental stratum. CSV export records those controls plus nominal rise, dense-gas drift, surface error/path metrics, ascent/descent, and mean mobility. Recommended comparisons include flat versus 5°, 10°, 15°, and 20° slopes; uphill, downhill, and cross-slope search orientations; all three gas classes; both plume solvers; and L0–L5 process-floor complexity on held-out paired seeds.

The dense-gas treatment is consistent in direction with established observations and reduced shallow-layer models of gravity currents over slopes ([Hankin et al., 2003](https://doi.org/10.1016/S0304-3894(03)00224-3); [TWODEE model](https://doi.org/10.1016/S0304-3894(98)00269-6)). The robot grade term follows the standard gravitational power contribution `mgv sin(θ)` ([NASA vehicle power analysis](https://ntrs.nasa.gov/api/citations/19800014727/downloads/19800014727.pdf)). These sources motivate the structure, not the simulator's uncalibrated coefficients. Complex terrain boundary layers, vertical concentration profiles, dense-gas pooling, slope breaks, 3D obstacle wakes, and gas-specific buoyancy require CFD or experimental data and are outside this model. The numerical solver caps an estimated advective Courant number at 0.9 using ambient gust, obstacle-deflection allowance, and terrain drift in addition to its diffusion-stability cap. This reduces long-backtrace diffusion but is not a convergence proof; formal work should still report 48²/96²/128²/192² spatial refinement at a common effective step and an independent 0.05/0.025/0.0125 s physics-step refinement rather than treating one grid as ground truth.

## Fractal-inspired process-floor complexity

The obstructed scenario has a clear geometry control plus five seeded complexity levels. L0 retains the obstructed process-flow turbulence, diffusion, intermittency, and sensor baseline but removes solid geometry. A finite-depth binary spatial subdivision then places equipment inside two fixed process bays while reserving a central service aisle and clear side corridors. Levels L1–L5 contain 2, 4, 8, 16, and 32 non-overlapping rectangles. Their geometric occupied area stays approximately constant while the number of boundaries, corners, and heuristic wake interactions increases.

This is a **fractal-inspired procedural stress test**, not a claim that the floor has a measured fractal dimension. A level simultaneously changes navigation fragmentation and the simulator's obstacle–transport interaction, so a performance trend cannot be attributed to “fractality” alone. For a causal study, compare against non-recursive layouts matched on count, area, aspect ratio, and seed.

All levels preserve a clearance-dilated start-to-source route. L5 requires at least a 48² numerical grid so its smallest units remain resolved; the app upgrades an incompatible 32² selection automatically. A cell-centred grid does not reproduce continuous occupied area exactly, so the live panel shows both geometric and grid-realized area. CSV files record the requested level, obstacle count, geometric area, normalized perimeter, grid-realized area, deterministic layout hash, and generator version. Benchmark summaries and charts keep each level in a separate stratum rather than pooling them.

## Sensor model and replay

The sensor panel exposes concentration noise, response time, detection threshold, saturation, false-positive rate, false-negative rate, and wind-direction noise. Defaults preserve the original deterministic acceptance runs. Non-zero classification-error rates use the experiment seed and are therefore reproducible and paired across algorithms. Controllers receive the resulting observed reading; Quad-Suction additionally receives the configured concentration-noise standard deviation as public calibrated instrument metadata for its gradient-significance gate.

The live view records immutable frames at one-second intervals. The replay timeline can pause a run, scrub its plume, path, observations, belief state and metrics, then jump back to the latest engine state. Playback speed changes presentation only; it changes neither the controller cadence nor the grid solver step.

## Included methods

| Method | Family | Implementation note | Primary reference |
| --- | --- | --- | --- |
| Coverage Zig-Zag | Deterministic baseline | Boustrophedon sweep; reports the strongest filtered reading | [A coverage baseline](https://doi.org/10.1145/3378184.3378220) |
| Surge–Cast | Bio-inspired reactive | Acquisition sweep, upwind surge, expanding crosswind cast | [Lochmatter & Martinoli, 2008](https://doi.org/10.1109/ICMLA.2008.128) |
| Zigzag–Spiral | Model-free coarse-to-fine | Broad zig-zag discovery followed by local spiral refinement | [Xu et al., 2026](https://doi.org/10.1016/j.measurement.2026.121852) |
| Infotaxis | Bayesian information search | Grid posterior and one-step expected entropy reduction | [Vergassola et al., 2007](https://doi.org/10.1038/nature05464) |
| Information-based SMC / KL | Particle Bayesian search | Joint position/strength particles and expected-KL planning | [Hutchinson et al., 2019](https://doi.org/10.1109/TCST.2018.2860548) |
| PMFS | Map- and physics-informed | Probabilistic hit map plus lightweight filament-hypothesis scoring | [Ojeda et al., 2024](https://doi.org/10.1109/TRO.2024.3426368) |
| Pulse–Sniff Search | Bio-inspired active-olfaction prototype | Serial directional air-pulse probes, burst/cast navigation, passive-evidence verification | [Catania, 2006](https://doi.org/10.1038/4441024a); [Staymates et al., 2016](https://doi.org/10.1038/srep36876) |
| Quad-Suction Soil Search | Simultaneous directional aspiration prototype | Four ground-facing channels, common-mode rejection, confidence-gated surface-emergence following | [Ishida et al., 1994](https://doi.org/10.1016/0924-4247(94)00829-9); [Uno et al., 2020](https://doi.org/10.1109/SENSORS47125.2020.9278629) |

These are transparent educational approximations, not line-for-line reproductions of the papers. The three Bayesian methods use the paper's core search idea and share an explicit simulator extension: a high filtered-concentration sample near the inferred candidate is required before a strict native declaration. The extension is shown in each method card rather than being hidden as an algorithm-specific advantage.

## Pulse–Sniff Search: active-olfaction research prototype

Pulse–Sniff Search is a testable algorithmic synthesis, not a claim of a biologically complete model. It takes two mammalian observations as inspiration. Star-nosed moles and water shrews can exhale bubbles onto a submerged object or scent trail and re-inhale them for olfactory sampling ([Catania, 2006](https://doi.org/10.1038/4441024a)). Measurements and flow visualization of canine sniffing show that ventrolateral expiration jets can entrain vapor from a surface toward the following inspiration ([Staymates et al., 2016](https://doi.org/10.1038/srep36876)). The implemented controller turns that active-sampling idea into a closed-loop search policy:

1. Record a local passive baseline without disturbing the observation.
2. Hold position during a directed exhale–settle–return cycle and receive one delayed scalar response.
3. Repeat the probe in serial bearings and compare each return with the baseline rather than treating absolute concentration as perfectly calibrated.
4. Use the directional contrast for a short burst when evidence is coherent; otherwise cast more broadly to reacquire an intermittent plume.
5. Require repeated scan consistency and nearby **passive** plume evidence before declaring a source. An active response can guide motion, but it cannot by itself certify the terminal estimate.

The air pulse is deliberately implemented as a **near-surface observation proxy**. It samples a short, directed, obstacle-clipped neighborhood and mixes that signal into the delayed sensor return. It does not alter the global plume, solve the jet flow, model a deposited chemical layer, or simulate literal surface desorption. Consequently, it can express and test the information value and mission cost of active sampling in both forward models, but it cannot support claims about nozzle geometry, boundary-layer transport, or physical odor recovery. Those questions require a coupled surface reservoir, actuator-flow model, calibrated sensor dynamics, and CFD or experimental validation.

Three additional costs are recorded for this method: accepted active-probe count, time committed to active sampling, and a dimensionless air-pulse energy proxy. They should be reported beside localization error, success, elapsed time, distance, plume contacts, and compute time. Passive hit/contact metrics are kept separate from active-return samples and hits, so an active method cannot inflate its encounter count by requesting extra probes. A method that improves error by using unlimited pulses is not automatically the better mission policy.

### Ablation and benchmark protocol

Any performance claim should be evaluated on pre-registered, held-out seeds with paired plume realizations, across both open and obstructed scenarios and both fast-puff and numerical transport. At minimum, compare the full controller with: active probing disabled; a zero-strength sham pulse that consumes the same blanking and hold time; one bearing versus the serial multi-bearing scan; no passive-baseline subtraction; no wind cue; and planned sensitivity ranges for probe strength, reach, cycle time, sensor lag, false detections, source emission, diffusion, turbulence, gusts, and obstacle complexity. The disabled and zero-strength controls are available through the live active-olfaction controls; deeper structural ablations remain an evaluation protocol.

Report distributions and uncertainty, not only the best seed: median and p90 normalized error, proximity-within-tolerance rate, time to first correct declaration, correct- and false-declaration rates, normalized distance, plume contacts/reacquisitions, active-probe count, active-sampling time, energy proxy, and compute time. Compare against Coverage, Surge–Cast, Zigzag–Spiral, Infotaxis, SMC/KL, and PMFS at identical checkpoints and mission budgets. Parameters should be tuned on separate seeds and then frozen before the held-out comparison.

Finally, "bio-inspired," "novel," and "best-performing" are different claims. The app supports the first and provides a platform for testing the second and third. It has not performed an exhaustive literature or patent search, and simulator results alone cannot establish novelty or real-world superiority. Until independent comparisons, ablations, and physical trials are complete, Pulse–Sniff and Quad-Suction should be described as **experimental active-olfaction prototypes** or **candidate research contributions**.

## Quad-Suction Soil Search: simultaneous four-channel aspiration

Quad-Suction Soil Search is distinct from Pulse–Sniff. Pulse–Sniff applies one directed exhale–return probe at a time and compares serial bearings; Quad-Suction stops and aspirates through body-frame front, left, aft, and right ground-facing channels simultaneously. Each nozzle has its own sensor state. All four channels sample the same sequence of times during the draw and return a duration-weighted temporal mean, avoiding serial-bearing time skew. A low-cadence reconnaissance draw at the configured collection strength can occur before the first passive threshold crossing; stronger active evidence then triggers wind-dominated tracking. The sampling footprints can overlap and the pumps can alter the air being measured, so the simulator treats them as calibrated directional observation kernels, not literal nozzle or pump CFD.

In the ideal special case of equal reach, full obstacle support, matched channels, and cardinal geometry, let `z_F`, `z_L`, `z_A`, and `z_R` be the sensor-processed front, left, aft, and right channel responses, and let `z̄ = (z_F + z_L + z_A + z_R) / 4` be their common mode. With body-forward and body-left unit vectors `u` and `v`, the directional cue is

`d = (z_F - z_A)u + (z_L - z_R)v = Σ_i (z_i - z̄)e_i`,

where `e_i` is the unit vector of channel `i`. The implementation uses a support-weighted local-plane fit, `min_(b,g) Σ_i w_i [z_i - b - g·r_i]^2`, where `r_i` is the retained kernel's effective centroid and `w_i` is its squared obstacle-support fraction. A model-based gradient-significance gate abstains when the geometry is rank-deficient or the cue is weak relative to configured white noise. For trapezoidal duration weights `a_j`, the white-noise-equivalent sample count is `n_eff = (Σ_j a_j)² / Σ_j a_j²`, so the modeled standard deviation falls as `1/√n_eff`; this is an idealized SNR mechanism, not a calibrated hardware prediction. The default gradient gate is 3.03, corresponding to roughly a 1% per-scan false-direction rate only for ideal full-support cardinal geometry with independent Gaussian channel noise. Pump-correlated noise, drift, channel bias, and cross-talk do not disappear through averaging, and the significance gate is not calibrated for correlated plume fluctuations. Common-mode centering cancels an additive shared offset but does not remove heterogeneous plume intermittency, gain mismatch, pump-flow error, sensor lag, humidity sensitivity, or aerodynamic cross-talk, all of which require calibration and repeated-scan tests.

For robustness experiments, the Quad panel exposes four opt-in,
dimensionless channel stressors: shared white-noise fraction, deterministic
gain mismatch, signal mixing with the channel mean, and deterministic response-
lag mismatch. Zero values preserve the original return path and random-number
sequence. These controls are exported to CSV and included in frozen manifests;
they are sensitivity proxies, not estimates of real pump or sensor behaviour.

For the soil-oriented interpretation, the four responses are only a **near-surface emergence proxy**. They can indicate which side of the robot currently contains stronger gas in the represented near-ground air layer; they do not directly point to a buried pipe rupture. Controlled releases show that soil moisture, snow, and asphalt can inhibit surface emission and redistribute methane migration ([Jayarathne et al., 2024](https://doi.org/10.1021/acs.estlett.4c00039)). The app does not solve cracks or heterogeneous permeability, porous-medium Darcy flow, subsurface storage or oxidation, soil–atmosphere coupling, calibrated mass flux, or accumulation/flux-chamber physics. It must not be used to estimate a physical leak rate or excavation point.

The broad hardware and sensing idea is not new. Four-direction gas and airflow probes were reported by [Ishida et al. (1994)](https://doi.org/10.1016/0924-4247(94)00829-9); an active two-sensor fan compass was reported by [Ishida et al. (1996)](https://doi.org/10.1016/S0925-4005(96)02009-6); dog-inspired differential pump sampling was demonstrated by [Kohnotoh and Ishida (2008)](https://doi.org/10.1109/ICMLA.2008.101); and ground-impinging fans were used to lift a floor-borne chemical toward robot sensors by [Uno et al. (2020)](https://doi.org/10.1109/SENSORS47125.2020.9278629). A particularly close patent, [US20030043379A1](https://patents.google.com/patent/US20030043379A1/en), describes a vehicle-mounted ground detector combining an air curtain, a jet toward the surface, suction, and chemical sensing. Active sampling can improve analyte delivery, but sniff speed and amplitude can trade sensitivity against dilution or disturbance rather than guaranteeing an SNR gain ([Spencer et al., 2021](https://doi.org/10.1038/s41467-021-21405-y)). The app's simultaneous, support-aware, multi-pose decision rule is a testable synthesis, not evidence that the system is legally or scientifically novel, and no claim of first or best performance is made.

Physical validation should proceed from a tracer-flow bench to controlled soil releases: map each inlet footprint and inter-channel cross-talk; calibrate flow, gain, lag, noise, humidity, and robot-heading bias; then test blinded buried releases across depth, rate, soil texture/moisture, slope, and surface cover. Independent surface-flux measurements should distinguish surface-vent error from buried-source error. Comparisons should include one passive sensor, a passive four-sensor array, continuous aspiration without differential steering, serial Pulse–Sniff, and raster coverage under equal time and measured pump-energy budgets. Report angular cue error, calibrated SNR, detection and false-declaration rates, vent and buried-source localization error, elapsed time, path length, measured energy, and any measurement-induced disturbance before making a novelty or superiority claim. In the simulator, only the dimensionless four-channel actuation-cost proxy `4 s² T` is available.

## Experimental protocol

- The internal domain is the unit square. The display-scale selector converts normalized values to 1 m, 10 m, 100 m, or 1 km labels; it does not rescale the dimensionless physics.
- Success is fixed at normalized Euclidean error `<= 0.01`. That is 0.01 m on a 1 m square and 1 m on a 100 m square.
- Four independently logged seeds separate roles: the world seed controls public start/layout and plume/sensor realization, the private source seed controls hidden source placement, the controller seed controls method-side exploration, and the observation-model seed controls the source-blind controller planning prior. Batch runs pair all four across algorithms while varying them independently between runs.
- Frozen research manifests may privately override the generated source, robot start, and initial plan heading to balance orientation and remove the legacy left-to-right placement prior. These values are applied by the world builder but remain excluded from the controller environment.
- User-selected wind, turbulence, gust, diffusion, and source-emission overrides are part of the experiment configuration and are held fixed across paired algorithms.
- User-selected slope, uphill aspect, gas-response class, buoyancy coupling, and robot reference grade are also held fixed across paired algorithms and are never pooled across benchmark strata.
- Paired comparisons reuse the same seed and scenario for every selected algorithm.
- Controller invocation, sensing and robot motion use a fixed 0.25 s cadence. The numerical grid has a separate requested physics step (0.25 s by default) that is automatically reduced when diffusion stability or the Courant accuracy cap requires it. The default filtered sensor response is intentionally fast (0.05 s time constant) so the binary encounter likelihood is not dominated by pose/lag misregistration.
- Controllers receive filtered concentration, hit/miss, noisy local wind, pose, and a deep-frozen copy of the public obstacle map as required by each method. Model-based arms query the versioned, separately seeded `controller-observation-v1` planning prior rather than the truth plume. Quad-Suction also receives configured sensor-noise calibration, actuator timing, and reach. The controller interface excludes the hidden source, world seed, source seed, truth plume object, and unfiltered concentration truth. Source placement is not derivable from the public layout/start seed.
- Live mode can stop on a method's native declaration. In fixed-budget benchmarking, a declared estimate and its mission costs are carried forward to later checkpoints; all methods therefore receive the same post-declaration semantics.

The benchmark reports median and p90 normalized error, proximity-within-tolerance rate, direct-distance path overhead, passive plume-contact episodes, browser compute time, active-probe costs, and declaration behavior. The overhead denominator is straight-line start-to-source distance, not the obstacle-aware shortest path, so it must not be interpreted as navigation efficiency across different clutter levels. Time-resolved charts show median error with descriptive interquartile ranges and proximity rate with Wilson 95% intervals; correct terminal declaration is the publication-facing source-present primary endpoint. Raw CSV export includes per-run metrics, source/start/estimate coordinates, all four seeds, controller-observation-model version, physics mode, grid resolution, requested/effective grid step, process-floor geometry, transport/source settings, and sensor configuration. Emission and complexity sensitivity should be reported as separate pre-registered strata; selecting favorable settings after seeing results would confound algorithm quality with scenario difficulty.

## What the two scenarios mean

`Open flow` is the better matched verification case: stable prevailing wind, mild meander, no obstacles. `Obstructed process floor` is deliberately a harder robustness case with wakes, intermittent transport, local wind deflection, and obstacles.

The open/obstructed contrast changes several factors at once and is therefore a composite stress comparison, not an obstacle-only ablation. To study recursive floor complexity, hold the obstructed flow, sensor, grid resolution, emission rate, and seed quadruplets fixed and vary only L1–L5. Even then, changing geometry also changes the simulator's heuristic wakes; report that coupling explicitly.

The obstructed generator and the algorithms' inexpensive inverse plume models are not identical. Large errors or abstentions there are meaningful model-mismatch results, not proof that a cited method fails in general. A formal PMFS study would need candidate-specific obstacle-aware flow simulation, calibrated sensors, navigation planning, more diverse layouts, and held-out field or CFD validation.

## Review of the attached HTML prototype

The attached single-file simulator was a useful visual starting point, but it was not suitable for fair algorithm comparison:

- its “MCK Mammalian Weave” label did not map cleanly to an established source-localization method;
- its “Bayesian optimization” path used kernel smoothing and a heuristic upper-confidence score rather than a Gaussian-process BO posterior;
- source estimation and Gaussian-plume behavior were simplified and sometimes mixed with algorithm-specific overrides;
- animation-frame timing affected physics and controller behavior;
- runs had no paired seed protocol, fixed checkpoints, batch statistics, or raw export;
- source truth, public scenario state, and controller randomness were not separated at the controller boundary.

PlumeNav replaces that structure with typed controllers, a deterministic fixed-step engine, a common sensor/environment interface, independent world/source/controller/observation-model seeds, a source-blind versioned planning prior, explicit assumptions and citations, paired batch execution, strict normalized evaluation, and tests for determinism and oracle isolation. This software-boundary separation reduces inverse-crime risk but is not a substitute for an independent validated truth solver.

## Important limits

The current publication roadmap is the
[11 September scientific review and revised plan](research/protocols/publication_plan_review_2026-09-11.md).
It distinguishes numerical verification from physical validation, records sensor
preset and soil-connectivity limitations, and assigns this demo a supplementary
explanation/replay role. Current commercial sensor presets are illustrative and
are not accepted for paper-facing product-performance rankings.

This app is appropriate for teaching, method inspection, sensitivity experiments, and generating hypotheses. It is not a CFD package, safety system, certified leak detector, or evidence of real-world superiority. “Convergence score” values are method-specific diagnostics and must not be compared as calibrated probabilities. Browser compute timings depend on the device and run order. Formal work should pre-register parameters, use many held-out seeds and scenario strata, report uncertainty intervals, and validate against independent simulation or field data.

## M54 soil-physics research extension (not integrated into the demo)

The [soil-to-air design](research/protocols/m54_soil_to_air_localization_design.md) separates intrinsic permeability, saturation-dependent gas/water mobility, diffusion connectivity, subsurface storage, surface emergence and buried-source truth. It includes literature-backed texture priors with uncertainty and an observation-only multi-region revisit-policy prototype. These are isolated research components, not a coupled soil solver, calibrated sensor model or demonstrated algorithm improvement. Existing frozen simulation evidence is unchanged. The [M54 extension audit](research/results/m54_soil_extension_status.md) records tests, review corrections and remaining integration gates.

M55 adds a [controlled one-dimensional frozen-moisture column](research/protocols/m55_frozen_moisture_column_verification.md) that converts prescribed buried pressure/concentration boundaries into a conservative surface flux. It is a numerical verification step, not the later heterogeneous lateral-migration model.

M56 adds the first [two-dimensional vertical soil cross-section](research/protocols/m56_2d_soil_cross_section_verification.md). It can redirect a localized release through heterogeneous wet and low-permeability regions and returns a spatial surface-flux distribution. M57 adds directional permeability and records a [partial convergence result](research/results/m57_anisotropy_convergence_status.md): steady pressure/centroid checks improve under refinement, but early methane breakthrough remains spatially unconverged. It is therefore still a fixed-moisture development solver rather than a field-validated soil model.

M58 adds a [bounded backward-Euler transport reference](research/protocols/m58_implicit_transport_verification.md). It confirms that the failed early-breakthrough gate is spatial rather than an explicit timestep-stability artefact; it does not promote those results into benchmark truth.

M59 adds [bounded MUSCL/SSP-RK2 transport](research/protocols/m59_muscl_transport_verification.md). It recovers approximately second-order smooth-advection convergence and a 0.450% fine-grid change in a declared wet-cap breakthrough-time metric, while retaining the unresolved pre-breakthrough tail as a failed/sensitivity quantity.

## Explicit SI atmosphere and scale study — 14 September 2026

The opt-in research atmosphere now records diffusivity, source geometry and mass rate, source age, and instrument concentration units in one validated contract. The generic local-inlet adapter also accepts physical diffusivity and maps it as `D_map = D_SI / domainMeters²`. Configurations that omit the new SI fields retain their legacy behaviour.

Use the research helper from a TypeScript runner:

```ts
import { createDefaultConfig } from './src/sim/config'
import { SimulationEngine } from './src/sim/engine'
import { withSIResearchDesign } from './scripts/lib/si-research-config'
import { siScaleAnalysis } from './scripts/lib/si-scale-analysis'

const config = withSIResearchDesign(createDefaultConfig('quad-sniff-refine', 'open'))
const engine = new SimulationEngine(config)
const scales = siScaleAnalysis(config, 0.10) // Independently chosen feature length, metres.
```

This half-space field is a headless research backend for flat, open, neutral transport; browser plume rendering is not supplied for it. The [implementation report](research/results/si_scale_implementation_2026-09-14.md) describes its physical scope, 30 prescribed inspection cases, tests, numerical checks and limitations. The [journal subsection draft](research/manuscript/sections/dimensional_analysis_v1.md) and [evidence notes](research/manuscript/sections/dimensional_analysis_notes.md) retain the dimensional formulation for later manuscript assembly.

To reproduce the development study, choose an output directory that does not exist:

```sh
pnpm exec vite-node scripts/si-scale-study.ts /absolute/path/to/new-study
python scripts/si-scale-study-audit.py /absolute/path/to/new-study /absolute/path/to/audit
```

The authoritative archive is `research/evidence/si_scale_study_2026-09-14_v2/`. The first generation is preserved but superseded for saturation accounting: individual inlet clipping can be hidden by a below-limit scalar mean. The v2 archive records channel flags and reproduces all original trajectories and scalar observations exactly. These prescribed inspections do not establish autonomous localisation performance or validate the historical cross diagnostic as a general maximum test.
