# Plumnav: evidence-based engineering review

3 November 2026 | REVIEW_ONLY | Lead review and three independent agent reviews

## Verdict

Plumnav is reproducible as a bounded simulation and recorded-data estimation workbench. It is not yet supported as an independently validated autonomous gas-source-localisation system for the Birmingham Go2/A2 backpack. The recent validation work is materially stronger than an unsupported demonstration: the recorded inputs, adverse results and distinctions between peak, prediction, fitting flag and source declaration are inspectable and reproducible.

The frozen installation, all 355 application tests, all 36 commissioning tests, production build, four empirical replay pipelines, ten commissioning choices and twelve synthetic holdout missions passed in this review. Independent arithmetic checks recovered the raw-data maxima, selections and distances. Independent quadrature and response calculations support the SI half-space and inlet implementations at the tested settings.

Three consequential issues remain: checkpoint timestamps can describe a later state; generic SI controllers accept a physically blocked starting footprint; and the older grid backend has a large unaccounted scalar-mass loss in an accepted prescribed-flow wall fixture. The last result is a quantitative-use limitation under that fixture, not evidence of a defect in the separate SI atmosphere used by the fitting survey. No critical source-coordinate leak was established in the inspected mission interfaces.

This report records a review, not a repair. No tracked source, tests, measurements or reference results were changed. No commit, push, merge, paid compute or physical robot operation was performed.

## A. Scope and evidence inventory

Repository: https://github.com/cona8888/Plumnav

Reviewed branch: validate/controlled-release. Reviewed commit: 3507527250400d25081f3793191084c9c3356a56. The accessible local branch matched the connected GitHub branch. The GitHub default branch main remained at 452d285e3ca6c8cfd6209bfbfe035e7ce0496fe7. Git merge-base confirmed that commit as the comparison base; the validation branch is four commits ahead. The final commit's parent is 8f26458beb855bbd3b7c0dadbe9dd1fe3e4d94bd. The original and isolated checkout were clean before review; final preservation evidence is in results/final-preservation.json.

The comparison contains 139 changed files. The repository inventory contains 1,054 tracked files; this is not a claim that every historical script received a line-by-line audit. We inspected the recent change set, the mission engine and observation boundary, core controllers and evaluation paths, transport and inlet implementations, relevant assertions, field replays, four dataset provenance notes, validation references and reproducibility documentation. No AGENTS.md was found in the inspected project or relevant ancestor locations.

| Reviewer | Independent responsibility | Actual model information |
| --- | --- | --- |
| Lead /root | Scope, setup, full source/commissioning checks, build, replay, mission panels, consequential reruns and synthesis | Session identifies GPT-6 Astra Pro |
| /root/software_review | Mission state, observation boundary, timing, output semantics and controller integrity | Same inherited GPT-6 Astra Pro; no override |
| /root/physics_review | Transport, sensor dynamics, geometry and robot integration | Same inherited GPT-6 Astra Pro; no override |
| /root/validation_review | Raw measurements, selections, metrics, provenance and claim support | Same inherited GPT-6 Astra Pro; no override |

Reviewers formed initial conclusions independently and sent them to the lead. They did not use one another's conclusions as evidence. The lead reran each consequential failure. This is independent task scrutiny within one model family; no different-family panel or independently verified serving-build identity is claimed.

Environment: Linux x86_64, AMD EPYC 9V74 reported by the host, nine logical CPUs visible, Node 24.22.1, pnpm 11.25.0, TypeScript 5.9.3, Vite 8.1.5, vite-node 3.2.4 and Vitest 3.2.7. The repository declares pnpm 11.9.0; that exact package-manager version was not separately exercised. Locked package versions were installed successfully. The initial offline attempt lacked registry metadata; the normal documented frozen-lockfile installation then succeeded in 9.36 s. This was a setup-cache limitation, not a project failure.

Intended use and implemented capabilities: a React/TypeScript two-dimensional simulator, deterministic research runners, alternative gas-localisation controllers, simulated sensor dynamics, recorded-path peak/Infotaxis/bearing estimators, and a mapped-fitting inspection policy. Legacy filament/grid transport is a normalized approximation. The opt-in SI mode uses a three-dimensional reflecting half-space concentration kernel sampled by a two-dimensional robot with local inlets. Default inlet calibration is manufactured parameter recovery. Physical SLAM, ROS/Gazebo/Isaac/hardware operation and the four-inlet backpack are not demonstrated by the reviewed executable workflow.

Unavailable or unfinished: omitted private historical research archives, manuscripts and referenced research documents; fresh downloads of all complete publisher archives; independent re-reading of all upstream ADApprox preprocessing; full publisher licence endpoint verification; every archived research test; fresh browser interaction and portable-HTML smoke testing; robot hardware, pose-error and live wind-frame integration. The normal source/commissioning tests and production build were run. Historical 67,200-run claims were not re-certified from absent archives.

## Complete executable mission trace

The principal executed path was the documented calibrated fitting survey. Standard, challenge and holdout panels all completed. For example, A-90/asset-inspection nominates fitting A at 397.75 s, exports elapsed time 398.00 s, travels 19.5799 m and records zero blocked-motion ticks. Its strict source outcome is unresolved-abstention. The 0.25 s distinction is the engine's final bookkeeping tick; decision time and elapsed time must remain separately labelled.

| Stage | Actual interface | Information and consequence |
| --- | --- | --- |
| Configuration | scripts/validate-fitting-survey.ts; createDefaultConfig; withCalibratedSIInlet | Four public fittings; hidden release/blank; all seeds; 6 m domain; shared manufactured sensor fit |
| World | SimulationEngine constructor; createScenario; PhysicalHalfspacePlume | Continuous 2 microgram/s release, flat reflecting ground, steady flow and fixed transport parameters |
| Observations | senseLocalInlets; LocalInletChannel; senseWind | Four body-oriented inlet locations, tube delay, rise/recovery, averaging, readout noise, clipping flags and local wind |
| Inference/selection | AssetInspectionController.step | Compare settled samples on two passes; require the same leading fitting; inspect upwind and both crosswind flanks, then revisit |
| Motion | SimulationEngine.step; movementIsBlocked | Incremental movement, speed/yaw bounds and swept collision checks; ideal pose and known map |
| Stop | Native abstention/declaration latches | A reinspection nomination is an abstention from source certification; budget, weak wind and contradictory controls produce explicit outcomes |
| Results | evaluateArchivedLeakRun; survey CSV/JSON writer | Separate fitting flag, source score, decision time, elapsed time, path, observations, station/control visits and failure counts |

World x/y coordinates are normalized internally and multiplied by domain length for metres. Time is seconds. The fitting observation export uses excess methane in ppm. Body inlet offsets rotate with robot heading. Geographic curtain inputs instead use local east/north metres, wind components towards transport, and compass bearings clockwise from north. The current simulated wind observation is ideal world-frame wind plus configured noise; a moving robot's body-frame apparent-wind correction is an untested integration task.

The engine strips source and targetStatus before constructing the public controller scenario. The inverse model is separately seeded and does not query the true plume. The evaluator legitimately retains source truth. A counterfactual changed the hidden source seed while preserving the public scenario and candidate likelihood. This supports the inspected boundary, without proving that all possible paths in the entire repository are leak-free. A known map and prescribed transport parameters are strong disclosed priors.

## B. Confirmed defects and numerical limitations

### B1. Off-grid checkpoints contain future state under an earlier timestamp

Severity: medium / P2. Evidence: reproduced by the software reviewer and independently rerun by the lead. Location: src/sim/engine.ts, advanceClock, lines 953-956; getMetrics, line 986 onward; config.ts, lines 343-348; batch.ts, lines 116-119. The mechanism is inherited from the comparison base rather than introduced by the latest validation commits.

Trigger: request a checkpoint between controller ticks. In the lead's physically scaled case, speed is 0.10 m/s, timestep is 0.25 s and checkpoint is 0.10 s. Configuration accepts this. After one step the checkpoint reports elapsedSeconds=0.10 but pathLengthMeters=0.025. The maximum possible travel at 0.10 s is 0.010 m. The exported state actually belongs to 0.25 s. The reviewer's independent 0.20 s-tick fixture similarly fails at 0.05, 0.10 and 0.15 s, while the aligned 0.20 s checkpoint passes.

Root cause: the robot moves for the tick before advanceClock detects crossed checkpoints. Calling getMetrics(checkpoint) changes the time label, not the accumulated state. Related schedule handling accepts [0,1,2] with a 1 s deadline but exports only checkpoint 1; the batch silently skips absent checkpoints. These share one checkpoint-contract root cause.

Consequence: time-resolved path, sampling and cost comparisons can be biased for custom schedules. No effect was established on standard archived checkpoints aligned to the controller timestep. The separate shortened final-deadline motion fix passed 18 new complete-mission checks.

Smallest remedy: validate a documented supported checkpoint schedule, or advance/snapshot at the actual requested times. Require uniqueness and a reachable time range; handle time zero explicitly if supported. Do not relabel a later snapshot. Regression: verify path <= speed x elapsed in a fixed-speed reference and exact correspondence between requested and exported checkpoints.

Reproduce from repo: node node_modules/vite-node/vite-node.mjs ../reproductions/lead_checkpoint_probe.ts. Evidence: logs/lead-checkpoint.log; reviewers/software/probes.ts and probes.json; checkpoint-range.ts and checkpoint-range.json. Pinned source reference: [engine checkpoint code](https://github.com/cona8888/Plumnav/blob/3507527250400d25081f3793191084c9c3356a56/src/sim/engine.ts#L953-L956).

### B2. Generic SI controllers accept an impossible initial robot footprint

Severity: medium / P2. Evidence: reproduced and rerun by the lead. Locations: config.ts lines 114-124 and 163-164; scenarios.ts lines 120-133; engine.ts physical environment construction and lines 967-978. AssetInspectionController.reset already guards its start at assetInspection.ts lines 42-44.

Trigger: use Surge-Cast with the documented SI design on a 6 m domain and a start at normalized (0.02,0.5). The centre lies 0.12 m from the boundary. The 0.70 m x 0.31 m footprint has a circumradius of approximately 0.383 m. The engine's own environment.isBlocked(start) returns true, but construction succeeds.

Expected: fail before mission execution with an actionable invalid-start error. Observed: a 5 s run remains at the same pose, travels 0 m, records 20 blocked-motion attempts and ends with a normal research-budget timeout. A setup error has entered mission statistics as a controller/navigation failure.

Root cause: common validation checks the centre against the unit square and obstacles, while physical motion uses the larger footprint. The extra asset-inspection check does not protect other controllers. The published standard fitting survey is therefore protected; this finding does not invalidate its successful nomination cases.

Smallest remedy: apply the shared physical clearance check in engine initialization before resetting any controller. Regression: edge, obstacle-adjacent and valid starts across the controller factory; keep setup failures distinct from mission timeouts.

Reproduce: node node_modules/vite-node/vite-node.mjs ../reviewers/physics/physics-checks.ts. Evidence: boundary object in logs/lead-rerun-physics.log and reviewers/physics/physics-checks.json. Pinned source: [motion clearance](https://github.com/cona8888/Plumnav/blob/3507527250400d25081f3793191084c9c3356a56/src/sim/engine.ts#L967-L978).

### B3. Grid obstacle handling is not a conservative transport reference

Severity: medium numerical limitation for the normalized demonstrator; consequential for any quantitative obstacle-transport claim. Evidence: reproduced and rerun by the lead. Location: src/sim/gridPlume.ts lines 293-313 (advection), 317-353 (diffusion/source/loss), and 222-225 (integrated scalar mass).

The accepted custom fixture uses a source at (0.25,0.5), uniform wind (0.065,0) in normalized units/s, zero diffusion/intermittency, negligible decay, a low source amplitude and a full-height solid wall at x=0.45-0.55. Concentrations remain below 0.007, excluding clipping as the explanation. An otherwise identical open control isolates the wall effect. Expected scalar mass is initial mass plus the injection budget; the proposed diagnostic tolerance was 1% at 6 s.

| Grid resolution | Open balance residual | Walled balance residual |
| --- | --- | --- |
| 32 x 32 | -0.00872% | -49.75% |
| 64 x 64 | -0.0000211% | -47.62% |
| 128 x 128 | +0.0000447% | -48.58% |

Root cause: backtracing writes only fluid destinations. Scalar carried towards a solid destination has no conservative face-flux accounting. Retaining a destination value when its backtrace crosses a wall does not balance the scalar arriving at the opposite face. Existing wall tests check reduced gas behind a wall, not the full scalar budget.

Qualification: the imposed velocity points normally into the wall and is not a self-consistent impermeable-wall flow. The existing test suite accepts an analogous open-flow-plus-obstacle pattern. This finding establishes nonconservation for that accepted prescribed-flow fixture and the need for a compatible velocity/boundary contract. It does not show a 50% error in every default obstacle world. The class explicitly calls diffusion no-flux; the stronger no-through-flow advection wording appears in its implementation comment. This is also a separate backend from the SI half-space fitting survey, which passed independent mass/response checks.

Smallest remedy: use compatible conservative face fluxes and explicit source/loss/boundary budgets, or reject incompatible flow setups. If the grid remains a qualitative proxy, state the limitation and exclude its integrated scalar from physical conservation evidence. Verify both this fixture and an admissible prescribed flow across spatial and solver-step refinement. A smaller controller timestep alone is not a demonstrated remedy.

Reproduce: node node_modules/vite-node/vite-node.mjs ../reviewers/physics/grid-mass-check.ts. Evidence: logs/lead-grid-mass.log and reviewers/physics/grid-mass-check.json. Pinned source: [grid advection](https://github.com/cona8888/Plumnav/blob/3507527250400d25081f3793191084c9c3356a56/src/sim/gridPlume.ts#L293-L313).

## C. Concerns that remain separate from confirmed defects

The engine's legacy absent-trial metric labels five controllers' silent timeouts correct-rejection-at-deadline, whereas evaluateArchivedLeakRun labels the same runs unresolved-deadline. This difference was reproduced. A no-false-declaration score on a known blank is legitimate offline specificity accounting; it does not establish that the robot confirmed absence. Align claim-facing labels with the conservative evaluator, or call the older metric no declaration in absent-source trials. This is a reporting-contract concern, not demonstrated source leakage.

Physical adequacy remains unverified for channel mismatch, humidity, temperature sensitivity, tubing adsorption/dispersion, variable flow, sensor drift and moving-platform wind. Resolve it with measured installed-channel bench records, common-clock pose/wind/gas records and blinded missions. Do not infer it from a low residual on manufactured traces.

Robustness across real pose errors, missing or delayed live telemetry, inaccessible goals, changing wind, recirculation and obstacle-rich SI missions was not established. Existing focused tests exercise several validity, clipping and weak-wind guards, but neither the current audit nor the supplied field tracks supplies a complete hardware-integrity campaign. The current SI survey intentionally excludes obstacles and SLAM drift; extending its claim requires new tests rather than relabelling those exclusions as existing features.

Publisher archive identity and metadata were inspected, but full original archives were not downloaded again. Bundled files matched the repository's 74-item manifest. Some publisher licence endpoints and upstream ADApprox preprocessing references were inaccessible in the review. A fresh upstream-byte/licence verification remains distinct from a checksum against the repository's own manifest. The repository also has no top-level software licence, as its own validation README states; choose and document reuse terms before broad external adoption.

## D. Physics, calibration and validation: what is actually supported

| Evidence category | Conclusion | Practical boundary |
| --- | --- | --- |
| Code verification | Supported for the tested contracts, with B1-B3 limitations | Tests, independent integrals/response and raw-data arithmetic; not proof of every model/path |
| Calibration | Synthetic parameter recovery reproduced; EPFL blank threshold commissioned on a reserved record | No measured calibration of the installed Birmingham backpack in the reviewed package |
| Synthetic evaluation | Standard, challenge and fixed holdout panels reproduce | Small related panels, steady prescribed transport, ideal pose and known fittings |
| Independent experimental comparison | Specific estimators compared with external recorded observations/release coordinates | Fixed trajectories; conditional bearings; reused campaigns and commissioning sensitivity |
| Hardware demonstration | Not established for this implementation | External aircraft used their own systems; no reviewed Plumnav closed-loop Go2/A2 execution |

The SI transport integrates Gaussian releases with variance sigma squared + 2 D age and a reflected source across z=0. Rate (kg/s) times age increment (s), divided by kernel volume (m cubed), gives kg/m cubed. It samples the three-dimensional field at inlet height while the robot moves in two dimensions. The checked reference has 0.025 m source height, 0.15 m source width, 0.001 m squared/s diffusivity, 0.02 m/s wind and 2e-9 kg/s release. A finite source width, constant horizontal flow, flat reflecting ground and scalar diffusivity are explicit model choices. They do not resolve outdoor wakes, soil migration or buried rupture location.

Independent checks passed: pulse mass from an 80-cubed spatial integral (relative error 4.46e-13); 300 s continuous concentration versus independently written 20,000-panel Simpson integration (2.80e-12); analytical gradients versus central differences (maximum 1.02e-9); zero ground-normal gradient; and an ideal delayed, first-order, averaged rising step (absolute error 1.78e-15). These are numerical verification results at specified settings, not experimental transport validation. One existing SI comparison test imports a re-export of the production class; that particular comparison is wiring equivalence, not independent validation. The new independently written quadrature checks address a real part of that evidence gap.

The default sensor fit uses two different manufactured pulse traces generated with independent noise and an RK4 integrator. It recovered rise/recovery time constants 1.75359/3.49719 s from prescribed 1.75/3.50 s values. Held-out RMSE was 0.001972 ppm, compared with 0.052815 ppm using original constants. Tube delay is approximately 0.754 s; the fitted settling allowance is 12.231 s and dwell is 14.5 s. Both generated traces and fitting model share the same response family. The low error supports fitting/integration consistency, not adequacy on a real instrument.

The controller observes local gas/wind and public geometry. It assumes ideal pose, representative wind and prescribed prior parameters. Source strength, diffusivity, sensor dynamics and source position can trade off in inverse models; no general joint-identifiability or calibrated posterior-coverage claim was established. The curtain method avoids inventing range by returning sourcePoint=null. Its measured width and wind spread are sensitivity descriptors, not calibrated source-position confidence intervals.

## E. Executed tests and benchmark results

Proposed acceptance conditions were written before the audit runs in results/acceptance-criteria.json and the independent scripts. Existing reference matches are reproduction criteria, not a newly preregistered performance study. Commands, exit codes and wall times are stored alongside raw logs. Some checks ran concurrently; these timings describe audit cost and do not support speedup claims.

| Check | Observed result | Approximate wall time |
| --- | --- | --- |
| Frozen-lockfile installation | Pass after offline metadata failure | 9.36 s |
| pnpm test --maxWorkers=2 | 37 files; 355/355 tests pass | 12.08 s |
| pnpm test:commissioning | 7 files; 36/36 tests pass | 4.36 s |
| pnpm build | TypeScript and production bundle pass; bundle-size warning only | 5.32 s |
| pnpm validate:data | 74 checksums; EPFL9, Blackpool22, MATRIX8, EPA3; ten commissioning choices; twelve simulated holdout missions all match | 43.60 s |
| pnpm --silent sensor:calibrate | Manufactured fit and held-out residuals reproduce | 1.17 s |
| Standard fitting panel | All 36 method/case rows retained | 24.35 s |
| Challenge fitting panel | All 14 cases retained | 7.67 s |
| Independent raw-data audit, lead rerun | All assertions pass, without production imports | 0.57 s |
| Operator JSON examples | Blank threshold 2075 ppb; bearing 225 degrees; sourcePoint null | 0.87 s each |

The independent audit checks all 77,135 Blackpool rows, all eight scored MATRIX windows with 4,436 included and 1,200 out-of-window rows, all ten MATRIX metadata exclusions, all nine EPFL aligned/one-Hz peak selections and hit counts, and all 597 EPA records with 30 thinning offsets. It reads committed Infotaxis endpoints to verify arithmetic; the fresh production replay separately establishes endpoint reproducibility. An initial lead invocation omitted the Python script's required repo argument and raised IndexError. That audit-harness error is retained in logs/independent-data.log; the corrected invocation passes and is recorded separately. It is not a Plumnav defect.

### Closed-loop simulated fitting results

| Panel and task | Result | Interpretation |
| --- | --- | --- |
| Standard mapped releases | Correct fitting nominated 8/8; 0 native source declarations | Reinspection sensitivity in these fixed cases |
| Standard blanks / 0.50 m upwind off-map releases | 0/2 and 0/2 flags | These controls pass; field specificity remains unknown |
| Standard alternative methods | Surge-Cast gas hits on 8/8 mapped cases; Quad-Sniff-Refine on 1/8; neither declares | Gas encounter is not source localisation |
| Challenge mapped releases | Correct fitting nominated 3/3 | Three new prescribed headings/locations |
| Challenge off-map / blanks | 0/6 off-map flags; 0/3 blank flags | Includes both upwind and lateral controls |
| Challenge weak wind / 295 s budget | Both withhold a fitting flag | Explicit unresolved outcomes retained |
| Fixed holdout mapped releases | Correct fitting nominated 2/2 | Known and previously scored holdout reproduced |
| Holdout distant off-map / blanks | 0/6 and 0/2 flags | Fixed-panel result only |
| Holdout 0.15 m neighbours | Both flag the adjacent mapped fitting: 2/2 | Fitting identity is not resolved at this separation |

All 62 standard/challenge/holdout simulated mission rows retain explicit outcomes. None establishes a native source declaration. Standard positive nomination times are 377.75-407.00 s; exported elapsed times are 378.00-407.25 s; paths are 17.58-20.30 m. Standard and challenge exports contain zero blocked-motion ticks. These are simulated mission seconds and metres, not wall-clock compute seconds.

The standard panel pairs environments across methods but does not establish a fair general ranking: asset inspection uses mapped-fitting priors and a different decision task, and active sampling changes readout schedules. No claim that it beats general source search is warranted. Standard cases share only two wind/seed settings; challenge and holdout panels are deliberately structured. Scenario counts are not independent field trials, so no binomial field-success interval is reported. The holdout is already public and previously scored; reproducing it adds no new untouched test set.

[FIGURE: figures/mission_trace/mission_trace.png]

Figure 1. Fresh A-90 asset-inspection replay. Position axes are metres; concentration is excess methane in ppm and time is seconds. The marked source is evaluator-only truth; the red curve is the methane readout. The final nomination asks to reinspect A; it is not a source declaration. The trajectory uses one-second readings; the 19.5799 m path is the engine's full motion accumulation. Complete CSV inputs, editable SVG, PDF and plotting code accompany the figure.

### What the real measurements show

| Recorded-data task | Result | Necessary qualification |
| --- | --- | --- |
| EPFL default commissioning plus nine searches | Median Infotaxis numerical endpoint error 0.399 m; paired peak 0.551 m | Eight searches have hits; one does not; 0 native declarations |
| EPFL gas-positive searches | Median Infotaxis error 0.421 m over eight flights | Conditional on reserved commissioning reference |
| EPFL all ten commissioning choices | Five accepted; gas-positive held-out median error 0.421-3.595 m | Reused flights; one accepted reference loses to peak baseline (0.667 m) |
| Blackpool measured peak | Median source distance 79.22 m over 22 surveys | Tracks were downwind; nearest sampled point median 67.33 m |
| MATRIX measured peak | Median source distance 41.40 m over eight scored surveys | Ten bundled flight files excluded by explicit source-metadata rule |
| Blackpool upwind bearing | 13/22 returned; median perpendicular miss 4.69 m | Nine abstentions; beats midpoint-wind baseline on only 6/13 accepted cases |
| MATRIX upwind bearing | 1/8 returned; miss 29.80 m | Seven abstentions; both matched simple controls are closer |
| EPA three passes | Peak selection and thinning sensitivity reproduce | No release coordinates; source-location accuracy not assessable |

The 40-flight headline consists of one commissioning flight plus 39 scored flight replays from three studies. It is not forty Plumnav autonomous robot demonstrations. The EPFL no-hit flight retains a 0.228 m model endpoint even under an all-miss control; its gas-supported estimate is correctly withheld. Outdoor bearing outputs total 14/30 accepted constraints and 16/30 abstentions, always without source range. The 4.69 m is perpendicular distance to a line, not a two-dimensional location-error median over all surveys.

The Blackpool and MATRIX source studies concern downwind methane emission quantification. Their trajectories and calibrated observations are useful estimator tests, but replay discards Plumnav movement commands and supplies recorded poses. It cannot show what a different navigation policy would have measured at unvisited places. The Shah corrigendum replaces incorrect Figure 8 labels and states that flux results are unchanged; no effect on the reviewed archive-based peak/bearing replay was established. See primary sources S1-S3 below.

## F. Claim-evidence table

| Candidate claim | Status | Evidence and limit |
| --- | --- | --- |
| Another researcher can reproduce this branch's packaged demonstration | Supported for tested environment | Frozen installation, 391 tests, build and offline replay pass; exact pnpm 11.9 not separately run |
| Recent recorded-input selections and peak/distance calculations are consistent | Supported for inspected data | Independent Python recomputation plus fresh production replay |
| SI transport and inlet equations are implemented correctly | Partly supported | Independent specific-case checks pass; not exhaustive physical/numerical validation |
| Controller receives no hidden source coordinates on inspected path | Supported within inspected boundary | Source stripping, code trace and source-seed counterfactual; not a whole-repository proof |
| Mapped fitting screening works under the specified steady ideal conditions | Supported as a bounded simulation result | 8/8 standard and 2/2 holdout mapped flags; no source declarations |
| 0.15 m neighbouring releases can be assigned to the correct fitting | Unsupported | Both close neighbours flag the mapped fitting |
| 0.399 m is a general expected localisation accuracy | Unsupported | Commissioning sensitivity, no-hit endpoint and fixed trajectories |
| Outdoor bearing returns a full source location | Unsupported | sourcePoint always null; range unresolved |
| The grid backend is a conservative obstacle-transport reference | Unsupported under accepted wall fixture | Approximately 48-50% unaccounted normalized scalar loss |
| Manufactured sensor calibration validates the installed backpack | Unsupported | No installed-channel measurements in default traces |
| Plumnav has demonstrated closed-loop Go2/A2 autonomy or field false-alarm rate | Not established by inspected evidence | No corresponding integrated trial records; replay is not navigation |
| Historical large campaigns remain fully reproducible from this checkout | Not assessed / incomplete public inputs | Required historical archives deliberately omitted |

## G. Prioritised actions

First, repair the checkpoint contract and common physical-start validation. They are bounded changes with direct regressions. Preserve the original failures and record how new output semantics affect saved comparisons. Keep this review's source snapshot unchanged when implementing those fixes later.

Second, decide what the normalized grid backend is permitted to support. If it is used for quantitative transport studies, add a compatible velocity/boundary model, conservative budgets and spatial/time refinement. If it remains a qualitative comparison environment, make that limitation visible in configuration and result exports. The current SI fitting work does not need to wait for an unrelated CFD rewrite.

Third, standardize claim-facing outcomes. Keep measured peak, model endpoint, gas-supported estimate, fitting-reinspection flag, explicit source declaration and evidence-backed no-source rejection distinct. The existing recent docs largely do this well; align the older batch/UI rejection wording. Include every abstention, no-hit record, setup error and timeout in denominators.

Fourth, measure the actual backpack. For each installed tube/channel, record a synchronized clean-air/span/clean-air sequence, actual flow, inlet reference and sensor output. Fit one sequence; evaluate different pulse durations/levels independently. Freeze rise/recovery, blank threshold, clipping and wind-validity rules before release tests. Record temperature/humidity and enough information to identify cross-channel bias and pose/time misalignment.

Smallest useful physical gate (proposed, not executed): twelve blinded complete missions across four conditions, with three independently re-established trials each: release beside a mapped fitting; blank; approximately 0.5 m off-map upwind release; and a 0.15 m neighbour. Keep the operator's release truth hidden from the policy and freeze commissioning beforehand. Log every inlet pose, gas channel, wind reading, quality flag, movement, dwell and decision on one clock. This is a diagnostic gate, not enough to certify a field false-alarm probability. Extend across independent days/winds/sites only after that gate works.

For a later autonomous-search comparison, give policies comparable priors, sensors, movement limits, observation/time budgets and declaration rules. Randomize or pair genuinely independent release sessions; split calibration and evaluation by whole missions or conditions. Compare a suitable simple reactive/coverage policy. Fixed recorded tracks cannot replace these closed-loop experiments. Decide the acceptable localisation/reinspection task and tolerance before inspecting results.

Optional packaging improvements: document a single public demonstration path separately from archive-dependent commands; choose a top-level software licence; retain a small CI job that runs source/commissioning tests and packaged validation; record run failures incrementally so a mid-campaign exception retains completed evidence. These suggestions are proportional next steps, not claims that every historical script should be rewritten.

## H. Reproduction commands and evidence locations

Unzip the evidence package, change into its plumnav_review directory and place the reviewed repository beside reproductions/ and reviewers/. The archive deliberately excludes the repository and node_modules; obtain the exact public commit below. This preserves the independent script import layout.

```sh
git clone --branch validate/controlled-release \
  https://github.com/cona8888/Plumnav.git repo
git -C repo checkout --detach \
  3507527250400d25081f3793191084c9c3356a56
cd repo
pnpm install --frozen-lockfile
pnpm test --maxWorkers=2
pnpm test:commissioning
pnpm build
pnpm validate:data
pnpm --silent sensor:calibrate
pnpm --silent survey:validate ../results/new-standard
pnpm --silent survey:validate --challenge ../results/new-challenge
pnpm --silent survey:validate --holdout ../results/new-holdout
node node_modules/vite-node/vite-node.mjs \
  ../reproductions/lead_checkpoint_probe.ts
node node_modules/vite-node/vite-node.mjs \
  ../reviewers/software/probes.ts
node node_modules/vite-node/vite-node.mjs \
  ../reviewers/software/checkpoint-range.ts
node node_modules/vite-node/vite-node.mjs \
  ../reviewers/physics/physics-checks.ts
node node_modules/vite-node/vite-node.mjs \
  ../reviewers/physics/grid-mass-check.ts
python3 ../reviewers/validation/independent_data_audit.py .
```

Use a new mission output directory for every rerun; the runner intentionally refuses to overwrite one. The archive's run_checks.py orchestrates the original bounded checks; its original fitting-standard/fitting-challenge destinations already contain retained results, so use the fresh-destination commands above for repeat runs. The separate Python data audit uses the standard library; figure regeneration additionally needs NumPy and Matplotlib. Source checks use the lockfile dependencies.

Evidence inventory: logs/ contains raw command outputs, including failures and corrected invocations; results/ contains command metadata, environment, acceptance criteria and all fresh standard/challenge protocol/readout/visit/decision/mission files; reviewers/ contains independent reports and standalone scripts/results; figures/mission_trace/ contains CSV, plot.py, SVG, PDF and PNG. The holdout was recomputed by validate:data in a temporary directory and compared fully before deletion; its retained authoritative traces remain in the pinned repository. Original scripts contain exact seeds/configuration; standard seeds are 81000/81001 world, 82000/82001 source, 83000/83001 controller and 84000/84001 observation model. Challenge replicates are 31-33,40,41; fixed holdout arms are versioned in validation/synthetic/fitting-holdout/cases.json.

## I. Rejected allegations and final readiness judgement

The review did not substantiate hidden source coordinates or full concentration fields being passed to policies on the traced path. Evaluation-only truth is legitimate. Fitting nominations are explicitly kept separate from declarations; all tested fitting strict outcomes remain unresolved. The recorded-flight code intentionally ignores movement commands and does not pretend to supply counterfactual observations. Failures, commissioning rejections, no-hit cases, distant outdoor peaks, bearing abstentions and neighbour flags remain visible. Large outdoor peak errors do not prove faulty peak selection: the independent maxima agree and the trajectories remained downwind.

The SI mass units and reflecting-ground normalization were challenged and passed the independent checks. Manufactured calibration is disclosed as manufactured. Travel, turning, settling and sampling time are charged in the SI mission; the inspected mission does not teleport. Conversely, neither passing tests nor reviewer agreement establishes field readiness, and a known absence scored offline does not prove operational absence confirmation.

| Intended use | Readiness based on this review |
| --- | --- |
| Reproducible demonstration | Ready for the documented, bounded examples in the tested environment |
| Simulation study | Conditionally usable; repair checkpoint/start contracts and scope the chosen transport backend and endpoint |
| Externally supported research claim | Ready only for narrow recorded-path estimator findings with complete denominators and commissioning sensitivity |
| Real Go2/A2 autonomous deployment | Not established; installed-channel calibration and blinded closed-loop evidence are required |

The most defensible current claim is: Plumnav provides a reproducible simulation and measured-data replay framework, with a simulated mapped-fitting reinspection policy and explicit unresolved outcomes. Autonomous source confirmation, field transfer and accurate close-neighbour attribution remain open research tasks.

## Primary references and source map

S1. Shah et al. (2020), Testing the near-field Gaussian plume inversion flux quantification technique using unmanned aerial vehicle sampling, Atmospheric Measurement Techniques 13, 1467-1484. https://doi.org/10.5194/amt-13-1467-2020

S2. Morales et al. (2022), Controlled-release experiment to investigate uncertainties in UAV-based emission quantification for methane point sources, Atmospheric Measurement Techniques 15, 2177-2198. https://doi.org/10.5194/amt-15-2177-2022

S3. Shah et al. (2020) corrigendum: https://amt.copernicus.org/articles/13/1467/2020/amt-13-1467-2020-corrigendum.pdf

Publisher records inspected by the evidence reviewer: ADApprox https://zenodo.org/records/17189796; Blackpool https://zenodo.org/records/3708518; MATRIX https://zenodo.org/records/6335359; EPA https://catalog.data.gov/dataset/methane-transect-dataset. Licence and raw-byte access limitations are stated above.

All code references resolve against commit 3507527250400d25081f3793191084c9c3356a56. Principal evidence documents in that snapshot are validation/README.md, validation/SHA256SUMS, validation/data/epfl/commissioning-sensitivity.csv, docs/real-flight-validation.md, docs/outdoor-wind-bearings.md, docs/inlet-calibration.md and docs/fitting-survey.md. New quantitative findings cite the independent scripts and raw logs delivered with this review. References are evidence locations, not endorsement of unverified historical claims.
