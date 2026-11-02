# PlumeNav validation dataset

Run the measured-data checks from a fresh checkout of the validation branch. Use Node.js 22.13 or newer and pnpm 11.9.0. Git downloads the sensor inputs as ordinary repository files. The install step needs access to the package registry or a populated pnpm cache. The replay itself reads local files and runs on a CPU.

```sh
git clone --branch validate/controlled-release https://github.com/cona8888/Plumnav.git
cd Plumnav
pnpm install --frozen-lockfile
pnpm validate:data
```

The command verifies `SHA256SUMS`, replays all four external datasets through the production controllers, checks all ten choices of tunnel calibration, then reruns the simulated fitting holdout in a temporary directory. It compares outputs to versioned references and exits with an error on a mismatch. Labels, rejection reasons, row identities, counts and declared decisions must match. Numeric comparisons allow floating-point roundoff (absolute `1e-8` plus relative `1e-12`). The committed measurements keep the published units. A passing run establishes reproducibility of these cases. It does not certify field accuracy on a new sensor.

| Included data | What the replays use and check |
| --- | --- |
| [EPFL ADApprox](data/epfl/SOURCE.json) · 10 physical ethanol flights | Original MOX voltages, poses, times and release coordinates. One commissioning flight and nine held-out searches in the default protocol. Includes all ten calibration choices in a separate sensitivity test. |
| [Blackpool methane](data/blackpool/SOURCE.md) · 22 physical UAV surveys | All 77,135 survey-window GPS/methane readings, wind information and reference coordinates from the authors' aligned data. The replay checks peak position, bearing, abstention and distance to the release. |
| [Swiss MATRIX methane](data/matrix/SOURCE.md) · 18 flight files | Eight files with explicit release coordinates supply 4,436 in-window readings for scoring. Ten further files are included so exclusions can be checked. Wind components cover both scored days. |
| [EPA Durham methane](data/epa/SOURCE.md) · 3 vehicle passes | All 597 measured GPS/CH₄ records from one controlled release. The replay compares the measured peak at full resolution and at ten thinning offsets. Release coordinates were unavailable for this dataset. |
| [Simulated fitting holdout](synthetic/fitting-holdout/README.md) · 12 ground missions | Fixed source cases, pointwise sensor traces, visits and outcomes. Flags for two neighbours 0.15 m from a fitting remain in the reference outputs. |

The external archive is distributed as lossless, selected replay inputs. Each dataset's source note identifies its original download, checksums, selection and attribution. Per-survey files can be decompressed using standard gzip tools. GPS is in degrees in the field archives; the operator CLI accepts local east/north positions in metres. EPFL's voltage in mV and outdoor methane concentrations in ppm are different measurement quantities. The input data keep their original reuse terms. The repository currently has no top-level software licence.

## What transfers to another operator

- **Software and reference data.** After installing dependencies, a second user can reproduce the same outputs with `pnpm validate:data`. [Per-flight results and conditions](../docs/real-flight-validation.md)
- **Calibration.** A group can commission its own clean-air threshold using a separate reference record. Across the ten EPFL reference choices, only five passed. The median error on gas-positive search flights was 0.421–3.595 m across those choices. These folds reuse the same ten flights. They do not represent ten independent laboratories. [Sensitivity and failures](data/epfl/commissioning-sensitivity.md)
- **New telemetry.** The two [runnable operator examples](examples/) cover a blank in ppb and a methane traverse with local EN coordinates in metres. Follow the schema for quality flags, timestamps, clipping, readout-to-pose alignment and wind direction. A single traverse may produce an upwind bearing or an abstention; it cannot give source range. [Operator instructions](../docs/field-records.md)
- **A different robot or gas instrument.** Measure the inlet delay and response, baseline, noise and clipping of the installed system. Test with independently surveyed releases, nearby confounders and blanks. None of these aircraft or vehicle records validates another robot's steering or four-channel independent revisit sequence. [Fitting mission conditions](../docs/fitting-survey.md)

## Inspect or rebuild

Run an individual campaign with `pnpm exec vite-node scripts/robot-field-replay.ts`, `scripts/blackpool-field-replay.ts`, `scripts/methane-field-matrix.ts` or `scripts/empirical-epa-replay.ts`. Each prints machine-readable JSON. The four reports in `expected/` were retained from source-archive runs. They serve as frozen comparisons for the bundled path. Use `node scripts/robot-field-sensitivity.mjs` to print the per-fold CSV. Existing raw-input modes remain available; see each dataset's source note. The optional rebuild from the original Blackpool MATLAB archive requires Python, NumPy and SciPy.
