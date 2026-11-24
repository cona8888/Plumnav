# Survey planning validation plan

**Status:** planned on 24 November 2026; this document records no new test results.
It supports [SP1–SP4](research-plan.md). Keep snapshot, excluded-archive and open
[PR #1](https://github.com/cona8888/Plumnav/pull/1) evidence distinct; see
[repository scope](../../REPOSITORY_SCOPE.md).

## Gates before broad cloud execution

1. **Reproducibility and information access.** Record the exact commit, dependency
   lockfile, Node/V8 versions, scenario configuration and seed roles. Reproduce
   relevant existing checks using available materials. Identify missing archives
   explicitly. Verify that planners receive only permitted geometry, priors and
   observations, without hidden source coordinates or truth concentrations.
2. **Units and numerical behaviour.** Establish the mapping between geometry,
   time, emission rate and sensor concentration units. Check coordinate transforms,
   obstacle clearance, boundaries and source representation. Use analytical or
   manufactured cases and separate spatial/timestep refinement, including
   intermittent emissions. Report transport conservation where applicable and
   quantify errors in concentrations and survey decisions. A stable timestep or
   attractive plume image is not a convergence result.
3. **Sensor and motion response.** Characterise detection threshold, noise,
   saturation, response time, sampling cadence, inlet placement and pose error.
   Verify channel history and sample timing against an independent reference;
   distinguish controlled calibration from field validity. The legacy normalized
   remote sampling footprint is not a validated suction instrument. Freeze
   acceptance tolerances before inspecting evaluation outcomes.

After these gates support the operating range, a small GCP pilot checks
reproducibility, runtime, storage and cost. Larger ensembles require a recorded
pilot review with failures retained.
The [funding budget](../funding/google-cloud-research-credits.md) is an allowance,
not an instruction to launch paid jobs.

## Prediction and route evaluation

Separate development, validation and untouched test scenarios by geometry,
source priors and environmental conditions, not merely random rows from one
simulation. Freeze models and decision thresholds before unlocking the test set.
Compare routes with systematic coverage under paired scenarios, sensor settings
and equal mission budgets.

Report detection rate, false detections, correct and incorrect source declarations,
unresolved missions, localisation error and survey duration separately. Include
emitting, zero-emission and absent-source controls; source error is undefined when
no source exists. Evaluate predicted probability calibration with reliability
plots and a proper score such as Brier score, alongside uncertainty intervals.
Test sensitivity to incorrect pipe priors, emission strength, wind and sensor
calibration; a concentration maximum need not coincide with the release location.

## Independent validation and release

Compare selected cases with an independent transport reference, then controlled
robotic measurements with recorded geometry, release conditions, wind and sensor
calibration. Agreement with the training simulator alone cannot establish field
performance. Report the conditions tested and limits of the 2D model.

Retain configuration hashes, predictions, observations, exclusions and analysis
scripts. Store evidence according to repository scope, with accessible references
and integrity checks. SP4 outputs must distinguish numerical verification,
simulation performance and experimental validation without implying unperformed
work or broader deployment readiness.
