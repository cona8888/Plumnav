# Methane screening at four mapped fittings

The robot measures each fitting on two passes. When both passes select the same fitting, the robot uses the wind measured there to visit three control points 0.4 m from the fitting. It samples upwind, then to the left and right across the wind. A final return to the fitting tests whether the enhancement persists. Every stop uses the calibrated settling time. If a control contradicts the fitting evidence, the robot ends verification early and records which control caused the veto. The surviving output is a fitting to reinspect.

## Closed-loop simulation results

The standard panel contains the original 12 release and blank scenarios. All three current survey methods had a 450 s budget. The original two-pass mission used 360 s and finished screening in 286 s. Both search comparators used the same 450 s as the revised policy here. The verification decisions and trajectories use only the public fitting positions and measurements available to the robot.

| Standard case | Original two passes | Wind-bracket survey |
| --- | --- | --- |
| Release 0.05–0.10 m from a mapped fitting | Corresponding fitting flagged in 8/8 | Corresponding fitting flagged in 8/8 |
| No release | No flags in 2/2 | No flags in 2/2 |
| Unrelated release 0.50 m upwind of fitting A | A flagged in 2/2 | A withheld in 2/2 |

Positive standard decisions took 378–407 s and 17.58–20.30 m of travel. Both blanks ended at the original 286 s with no extra visits. On the same eight mapped releases, Surge–Cast registered gas on eight and Quad-Sniff-Refine on one. Neither search method declared a source. [Standard mission rows](fitting-survey-results.csv)

The first additional panel exercised three new headings, three candidate fittings, weak wind and a short deadline. An initial upwind-only control still flagged all three lateral releases. Adding symmetric crosswind controls suppressed those flags. We then ran a separate panel with new wind headings, wind speeds, locations and noise seeds and scored all its cases.

| Separate 12-case panel | Two-pass flag | Wind-bracket flag |
| --- | ---: | ---: |
| Mapped fitting, release displaced by 0.057 m | 2/2 correct fittings | 2/2 correct fittings |
| Off-map release, 0.28–0.56 m separation, either crosswind side or diagonally upwind | 4/6 | 0/6 |
| Off-map neighbour, 0.15 m separation | 2/2 | 2/2 |
| Blank | 0/2 | 0/2 |

The 0.15 m result sets an important limit. A flag cannot distinguish the fitting from a close neighbour in these cases. These are finite simulations of steady transport. They establish neither a minimum resolvable separation nor a field false-alarm rate. The weak-wind and 295 s budget cases both withheld the flag. [Paired stress and holdout results](fitting-verification-cases.csv)

## Reproduce from the repository root

Use Node.js 22.13 or newer and pnpm 11.9.0. The reported run used Node.js 24.22.1 on Linux.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:commissioning
pnpm sensor:calibrate
pnpm survey:validate
pnpm survey:validate --challenge
pnpm survey:validate --holdout
```

Open `benchmark-output/fitting-survey-bracket/missions.csv` for one row per mission, `decisions.csv` for the reason each run stopped, `visits.csv` for screening evidence, `verification-visits.csv` for actual control poses, times and measured contrasts, and `readings.csv` for time, position and methane excess in ppm. `protocol.json` contains every world and controller configuration. Append `--legacy` to run each panel without the verification visits. Supply a fresh output directory to repeat the run, for example `pnpm survey:validate benchmark-output/repeat-01`.

To run with measured sensor dynamics, provide a training trace and a separate validation trace from the same bench setup. Review the held-out residuals before using the fit. The second command uses the fitted rise and recovery, tube geometry, actual volumetric flow per channel and averaging window recorded in the report.

```sh
pnpm --silent sensor:calibrate training.csv holdout.csv bench-setup.json > bench-report.json
pnpm survey:validate benchmark-output/measured-inlet bench-report.json
```

## Physical and decision assumptions

- The flat 6 m × 6 m site contains fittings at (2, 2), (2, 4), (4, 4) and (4, 2) m. The robot starts at (1, 3) m. Its maximum speed is 0.10 m/s and maximum yaw rate is 45°/s. The model uses ideal pose, no obstacles and no SLAM drift.
- The SI half-space transport model uses a continuous 2 µg/s methane release, source height 0.025 m, Gaussian width 0.15 m, diffusivity 0.001 m²/s and steady 0.02 m/s wind along either direction of the x axis. The atmosphere starts with 300 s of release history. Readings are excess methane relative to a zeroed background. The case does not include outdoor turbulence or ambient-background drift.
- The four inlets sit 0.05 m above the floor. Opposing inlets are 0.10 m apart. Each channel has a 1 m tube with 2 mm internal diameter at an actual flow of 0.25 L/min. The simulator ticks at 4 Hz, publishes gas readings at 1 Hz and applies a one-second averaging window. The synthetic bench fit gave a 12.23 s settling allowance and 14.5 s total station dwell. This is a numerical backpack design. [Calibration procedure and measured-data format](inlet-calibration.md)
- The robot visits A–B–C–D twice. The same station must lead both passes to trigger verification. The robot requires coherent local wind of at least 0.005 m/s and enough remaining time. All three fitting medians must exceed every flank median by at least three configured noise standard deviations. Each winning visit needs at least two above-threshold readings and a median above the detection threshold. Its median must exceed the runner-up by at least three configured noise standard deviations. Too few settled readings or any clipped stationary reading invalidate that pass. This is an engineering margin. It carries no probability-of-correct-identification interpretation.
- Surge–Cast and Quad-Sniff-Refine receive pose, instrument observations and public environmental data. The latter uses the repository's SI head-step acquisition and fresh-cross verification options. The expected source, blanks and offsets are used only for forward simulation and scoring. Route length, seed reuse, mild wind and the known fitting locations constrain the scope of these results.

## Transfer to a robot

For a Go2 or A2 trial, the first measurement is a clean-air → span → clean-air trace on each installed tube at its operating flow. Record valve time, inlet reference concentration and measured gas on the same clock. Use a different pulse sequence for the validation file. On the robot, log the pose of the inlet, wind and methane on that clock. A surveyed release beside a fitting, a blank and a release just upwind of a different fitting test the decision the operator will actually make. The current repository runs this mission in simulation. Physical robot navigation, SLAM and backpack sensing have not been exercised here. [Replay of an independent measured transect](empirical-epa.md)

## Verification scope

The browser build and offline HTML build ran on the locked dependencies. A Chromium smoke test exercised the Quad-Confirm array controls, mission playback and batch telemetry. Regression tests cover the physical sampling clock in Surge–Cast, Infotaxis and PMFS, the distinction between a zero-rate SI emitter and an active leak, station access and the conditions under which the fitting survey abstains. The source checkout also provides an independent recorded-path replay for the coverage peak estimator.

`pnpm test:research` spans archived studies as well as the self-contained checks. On the original commit, 46 tests and one suite that failed to load required omitted archive inputs. Three frozen manifest digest checks and one historical noise-model expectation also failed. Use `pnpm test:commissioning` for the runnable inlet, response calibration, SI transport and baseline replay checks for this case.
