# Proposed installed Go2/A2 validation pilot

**Status: proposed; no hardware missions have been performed for this protocol.** This is a twelve-mission diagnostic pilot for one installed Go2 or A2 sensing system. It tests whether measured inlet dynamics, robot motion and local wind support the fitting-reinspection decision. It does not establish deployment reliability or authorize physical robot operation. A second robot, inlet layout or sensor configuration requires a separate commissioning record and panel.

The current evidence is simulation and recorded-path replay. The [fitting-survey case](fitting-survey.md) flags a fitting for reinspection; it does not confirm a leak at that fitting. The [inlet calibration example](inlet-calibration.md) uses manufactured traces. This pilot supplies the missing installed-system measurements.

## 1. Commission independently, then freeze the protocol

Before scoring any mission, record the hardware identifiers, inlet positions and heights, tube lengths and internal diameters, actual operating flow per channel, sensor units, averaging windows, firmware and code commit. Calibrate gas units against a traceable reference and measure background, detection threshold, noise, clipping limits and drift. Record temperature and humidity over the tested range; document untested cross-sensitivities and environmental limits.

On the fully installed system, acquire clean-air → reference-gas → clean-air sequences on each channel, with valve events, inlet reference concentration and output on a common clock. Measure transport and clock delays, then fit rise and recovery using one training record. Validate the frozen fit against a separately acquired pulse sequence with different durations and levels, including a fresh setup and baseline. Preserve both raw records. Do not use mission outcomes to choose the fit, threshold, averaging window or dwell. A failed validation requires a new fit and a new unused validation sequence.

Report residuals and observed settling separately for every channel and direction of response. Freeze a dwell that covers the slowest validated channel, tube delay, instrument averaging and the required settled readings. The synthetic 12.23 s settling allowance and 14.5 s dwell are not measured hardware values. Check the installed wind sensor with the robot stationary and moving, including interference from the body, pump and fans.

Before mission 1, archive a signed-off protocol with numerical limits for concentration residual, clock alignment, pose error, useful wind, clipping and missing readings. Derive these limits from the reference instruments and commissioning results. Check that timing and pose uncertainty can resolve the planned station/flank comparisons; otherwise revise the geometry before collecting the panel. Freeze controller settings, start pose, route, detection/flag rules, spatial scoring tolerance, exclusions and analysis code. Keep commissioning records separate from all twelve mission records.

## 2. Twelve diagnostic missions

Use four conditions with three independently re-established trials each. A trial includes a fresh baseline, release setup, surveyed source coordinate, starting pose and wind check; restarting software against the same continuous release is not a new trial. Randomize the order within each of three blocks containing all four conditions. Record the randomization seed. An evaluator holds the release schedule and truth coordinates; the controller receives only the public fitting map, measured pose, gas and permitted wind observations.

| Condition | Three trials per condition | Diagnostic question |
| --- | --- | --- |
| Release beside a mapped fitting | Survey the actual displacement from the fitting; target about 0.05 m | Does the intended fitting receive a repeatable reinspection flag? |
| Blank | No controlled release; retain ambient background and any contamination measurements | Does background alone produce a flag or source declaration? |
| Off-map release upwind of a fitting | Target about 0.50 m separation; survey the actual geometry and wind | Does transported gas cause a mapped-fitting flag or mistaken source attribution? |
| Close off-map neighbour | Target about 0.15 m separation from a fitting | Can the system retain uncertainty when the two locations are difficult to distinguish? |

The distances are proposed diagnostic cases motivated by the simulation panel, not established resolution limits. Fix actual geometry and release rates before scoring. Measure release rate and its uncertainty independently, log release start/stop times, and retain the surveyed truth even if the release or wind departs from plan. Repeat the same intended condition across the three blocks, while re-establishing its physical setup. Report shared site, day and wind conditions: repeated setup does not create independent evidence across environments.

Start from the documented A–B–C–D route with two passes and the existing upwind/crosswind verification visits. Proposed initial limits are 0.10 m/s and 450 s; confirm or revise them using commissioning before the panel, then freeze them. Travel, turning, sensor settling, failed visits and recovery all consume the mission clock. Keep the control geometry accessible and log all actual visits. This pilot compares screening and verified flags within the recorded mission. A claim of superiority over another navigation policy requires separate randomized physical missions with comparable budgets; replay cannot supply unvisited measurements.

## 3. Synchronized record

Retain raw data and a documented export with one mission identifier and one common monotonic time base. Record clock offsets and drift checks at the start and end. Preserve acquisition time, averaging-window support, transport delay and readout time separately; do not silently shift samples to the robot's current position.

Log body pose and orientation, pose uncertainty, the measured body-to-inlet transforms, each inlet's world position, gas values and units, raw wind and its coordinate frame, wind speed/direction uncertainty, channel flow, temperature/humidity, validity and clipping flags. Wind vectors use documented east/north **towards** components after transformation. Include commanded and achieved motion, station arrival/departure, settling completion, accepted/rejected readings, baseline freeze, flags, abstentions, declarations and stop reasons. Retain reference-gas, release and surveyed-truth records in an evaluator-only stream.

The [field-record format](field-records.md) supports gas quality flags and baseline/bearing analysis; it is not a complete robot logging interface. Document any new export adapter, units and timestamp conversion and retain its code with the raw logs.

## 4. Stopping and outcome definitions

The installed controller stops on its frozen terminal rule or the fixed deadline. The operator may abort for loss of robot control, collision, unusable sensing or an unsafe condition. Record the actual stop time, reason and any decision made beforehand; an abort cannot erase an earlier flag or declaration. Operator knowledge of the true source must not trigger a successful stop.

- **Reinspection flag:** the recorded mapped fitting passes the frozen repeated-visit and flank-comparison rule. Report the fitting identity and time. A flag is not a source declaration.
- **Blank false flag:** any reinspection flag in a blank trial. Report its count against all three scheduled blanks and separately against completed blank exposures. Mark unstarted or incompletely observed trials as unknown, never as negative evidence.
- **Off-map fitting flag:** a mapped-fitting flag in either off-map condition; report this separately from blank false flags. If the system explicitly attributes the source to that fitting, score the attribution against the surveyed release.
- **Source declaration:** an explicit terminal source claim with coordinate and time. Score localization error in metres against independently surveyed truth and the tolerance fixed before mission 1. A declaration in a blank is false; an emitting-trial declaration outside tolerance is wrong.
- **Abstention, deadline or abort:** unresolved unless a valid source declaration occurred earlier. Record all such outcomes and the fraction without a declaration. Neither abstention nor silence confirms source absence; this pilot has no accepted absence certificate. The repository's legacy `correctRejection` metric counts absent-source nondeclaration and must not be reported as a verified no-leak decision. See the [strict decision scorer](../src/sim/researchEvaluation.ts).

## 5. Analysis and retained failures

Create a row for every scheduled mission, including missions never started, aborted or invalidated. Retain raw logs, calibration failures, setup deviations and all restart attempts under distinct identifiers. Record exclusion reasons before unblinding outcomes. A replacement is an additional attempt; it does not replace the original row or improve the primary twelve-mission denominator.

For each condition report counts out of three, flagged fitting identities, strict declaration/abstention/deadline/abort outcomes, declaration error, elapsed time, travelled distance, invalid and clipped readings, failed station visits and collisions. Show all individual missions and distributions. Label any error or completion-time summary restricted to declarations or successes, alongside the full mission denominator. Report realized wind, pose and timing uncertainty with each trial. Three repetitions are diagnostic; intervals will be wide and shared setup limits independence. Do not infer a field false-alarm rate or a minimum resolvable separation from this panel.

Archive the frozen protocol, source commit, dependencies, hardware configuration, commissioning training/validation records, raw synchronized logs, evaluator truth, checksums, conversion/analysis scripts and per-mission outputs. The pilot is complete only when all twelve scheduled outcomes and failures are accounted for. Any hardware or policy changes prompted by these results start a new panel with new held-out missions.
