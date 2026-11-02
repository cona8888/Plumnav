# Methane screening at four mapped fittings

A quadruped inspects four accessible, mapped locations. Its operator needs to know which fitting warrants a closer inspection after a gas enhancement. The robot visits each fitting twice, stops at each one, waits for the inlet to settle, and compares the two passes. The output is a fitting ID for a follow-up visit. Source position remains hidden throughout the mission.

## What happened in 36 simulated missions

Each of three methods received the same 12 methane-release or blank scenarios. Only the fitting survey received the asset map. All three had the same starting pose, sensor dynamics, wind, concentration field and 360 s time budget. The 12 scenarios are a fixed engineering check. They reuse two seeded noise realisations across conditions.

| Ground truth | Two-pass fitting survey | Surge–Cast | Quad-Sniff-Refine |
| --- | --- | --- | --- |
| Release beside one of four mapped fittings, eight cases | Flagged the corresponding fitting in 8/8 | Registered a passive gas hit in 8/8. Issued 0 source declarations | Registered a passive gas hit in 1/8. Issued 0 source declarations |
| No release, two cases | Flagged no fitting in 2/2 | No source declaration in 2/2 | No source declaration in 2/2 |
| Release 0.50 m upwind of fitting A, two cases | Flagged A in 2/2, although neither release came from A | No source declaration in 2/2 | No source declaration in 2/2 |

The mapped route travelled 15.41 m and issued its follow-up decision at 286 s in each case. Each of its 96 stationary visits yielded two or three settled 1 Hz readings. Both native search methods used the full six minutes. The gas reached A from an unrelated source in both off-map challenges. Two repeat visits made that enhancement repeatable without establishing its origin.

The fitting policy always abstains from an autonomous source declaration. A flag points to the surveyed fitting centre. The on-map fixtures placed each release either 0.05 m or 0.10 m from that centre by design. Those distances reflect the placement geometry. The simulator's strict source tolerance is 0.06 m on this site. The two native policies made zero terminal source declarations in the 20 emitting missions between them. A blank run that ends without a declaration supplies no survey-wide absence certificate. [Individual results](fitting-survey-results.csv)

## Reproduce from the repository root

Use Node.js 22.13 or newer and pnpm 11.9.0. The reported run used Node.js 24.22.1 on Linux.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:commissioning
pnpm sensor:calibrate
pnpm survey:validate
```

Open `benchmark-output/fitting-survey/missions.csv` for one row per mission, `visits.csv` for stationary evidence, and `readings.csv` for time, position and methane excess in ppm. `protocol.json` contains every world and controller configuration. Supply a fresh output directory to repeat the run, for example `pnpm survey:validate benchmark-output/repeat-01`.

To run with measured sensor dynamics, provide a training trace and a separate validation trace from the same bench setup. Review the held-out residuals before using the fit. The second command uses the fitted rise and recovery, tube geometry, actual volumetric flow per channel and averaging window recorded in the report.

```sh
pnpm --silent sensor:calibrate training.csv holdout.csv bench-setup.json > bench-report.json
pnpm survey:validate benchmark-output/measured-inlet bench-report.json
```

## Physical and decision assumptions

- The flat 6 m × 6 m site contains fittings at (2, 2), (2, 4), (4, 4) and (4, 2) m. The robot starts at (1, 3) m. Its maximum speed is 0.10 m/s and maximum yaw rate is 45°/s. The model uses ideal pose, no obstacles and no SLAM drift.
- The SI half-space transport model uses a continuous 2 µg/s methane release, source height 0.025 m, Gaussian width 0.15 m, diffusivity 0.001 m²/s and steady 0.02 m/s wind along either direction of the x axis. The atmosphere starts with 300 s of release history. Readings are excess methane relative to a zeroed background. The case does not include outdoor turbulence or ambient-background drift.
- The four inlets sit 0.05 m above the floor. Opposing inlets are 0.10 m apart. Each channel has a 1 m tube with 2 mm internal diameter at an actual flow of 0.25 L/min. The simulator ticks at 4 Hz, publishes gas readings at 1 Hz and applies a one-second averaging window. The synthetic bench fit gave a 12.23 s settling allowance and 14.5 s total station dwell. This is a numerical backpack design. [Calibration procedure and measured-data format](inlet-calibration.md)
- The robot visits A–B–C–D twice. The same station must lead both passes. Each winning visit needs at least two above-threshold readings and a median above the detection threshold. Its median must exceed the runner-up by at least three configured noise standard deviations. Too few settled readings or any clipped stationary reading invalidate that pass. This is an engineering margin. It carries no probability-of-correct-identification interpretation.
- Surge–Cast and Quad-Sniff-Refine receive pose, instrument observations and public environmental data. The latter uses the repository's SI head-step acquisition and fresh-cross verification options. The expected source, blanks and offsets are used only for forward simulation and scoring. Route length, seed reuse, mild wind and the known fitting locations constrain the scope of these results.

## Transfer to a robot

For a Go2 or A2 trial, the first measurement is a clean-air → span → clean-air trace on each installed tube at its operating flow. Record valve time, inlet reference concentration and measured gas on the same clock. Use a different pulse sequence for the validation file. On the robot, log the pose of the inlet, wind and methane on that clock. A surveyed release beside a fitting, a blank and a release just upwind of a different fitting test the decision the operator will actually make. The current repository runs this mission in simulation. Physical robot navigation, SLAM and backpack sensing have not been exercised here. [Replay of an independent measured transect](empirical-epa.md)

## Verification scope

The browser build and offline HTML build ran on the locked dependencies. A Chromium smoke test exercised the Quad-Confirm array controls, mission playback and batch telemetry. Regression tests cover the physical sampling clock in Surge–Cast, Infotaxis and PMFS, the distinction between a zero-rate SI emitter and an active leak, station access and the conditions under which the fitting survey abstains. The source checkout also provides an independent recorded-path replay for the coverage peak estimator.

`pnpm test:research` spans archived studies as well as the self-contained checks. On the original commit, 46 tests and one suite that failed to load required omitted archive inputs. Three frozen manifest digest checks and one historical noise-model expectation also failed. Use `pnpm test:commissioning` for the runnable inlet, response calibration, SI transport and baseline replay checks for this case.
