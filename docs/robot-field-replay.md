# Localising a known ethanol release from measured drone flights

Plumnav's production `coverage` estimator placed the source within 1 m on eight of ten recorded Crazyflie flights in a 6 m × 2 m wind-tunnel survey area. The estimator returns the position of the highest admissible sensor reading. We tested all ten physical source-localisation flights in the EPFL ADApprox dataset. Each flight visited a different source configuration. Source coordinates were withheld from the estimator and used only for scoring. The drone flew the experimenters' lawnmower trajectory. [Dataset](https://doi.org/10.5281/zenodo.17189796) · [Experiment and instrument](https://doi.org/10.1109/IROS60139.2025.11246155)

| Estimator or reference | Median horizontal error (m) | Mean error (m) | Worst error (m) | Within 1 m |
| --- | ---: | ---: | ---: | ---: |
| Fixed arena centre | 1.563 | 1.696 | 2.579 | 2/10 |
| Plumnav peak at the recorded pose | 0.579 | 0.723 | 1.464 | 8/10 |
| Plumnav peak at the pose 2 s earlier | 0.539 | 0.651 | 1.461 | 8/10 |

The 2 s alignment uses the sensor delay reported by the experimenters. Flight 2 illustrates its limit. The aligned peak was still 1.46 m from the source. Aligning a reading to an earlier pose can reduce error from sensor delay, but the strongest reading can occur downwind of the release.

| Flight | Source x (m) | Source y (m) | Recorded-pose error (m) | Delay-aligned error (m) |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 5.46 | 2.49 | 0.577 | 0.545 |
| 2 | 6.45 | 2.07 | 1.464 | 1.461 |
| 3 | 7.26 | 2.38 | 1.318 | 1.241 |
| 4 | 8.52 | 1.74 | 0.581 | 0.538 |
| 5 | 3.64 | 1.70 | 0.620 | 0.539 |
| 6 | 3.48 | 1.45 | 0.492 | 0.382 |
| 7 | 7.45 | 1.56 | 0.546 | 0.400 |
| 8 | 8.38 | 2.38 | 0.479 | 0.335 |
| 9 | 4.39 | 1.98 | 0.440 | 0.402 |
| 10 | 4.74 | 2.69 | 0.717 | 0.670 |

## Infotaxis on the same recorded paths

We compared the production Infotaxis controller with the production coverage peak estimator using identical delay-aligned poses and voltages. We selected the first accepted record in each occupied one-second interval. Each flight provided 173 observations. The Infotaxis posterior consumes binary encounters. Before running the comparison, we defined a hit as a reading strictly above that flight's 99th percentile voltage in the authors' upstream reference strip (x > 8.75 m). This is a retrospective, flight-wide reference. A live mission would need a prior upwind baseline. [Authors' reference-strip selection](https://github.com/disal-epfl/ADApprox/blob/4f7b6c964163a8fcb9aeed5ef3993d49ff520aba/data_preparation/data_pipline.py)

| Source estimate at the end of the recorded flight | Median horizontal error (m) | Mean error (m) | Worst error (m) | Within 1 m |
| --- | ---: | ---: | ---: | ---: |
| Coverage peak using the same 173 observations | 0.609 | 1.143 | 4.371 | 6/10 |
| Infotaxis reported point estimate | 0.475 | 0.876 | 4.223 | 9/10 |
| Centre of highest-weight Infotaxis posterior cell | 0.436 | 0.838 | 4.381 | 9/10 |

The two Infotaxis estimates are summaries of the same posterior. Its native output refines the highest-weight grid location using recent encounters. Nine of ten native endpoint estimates were within 1 m. On flight 6 it received eight above-threshold observations and missed the source by 4.223 m. No flight met the controller's separate declaration rule. The replay does not calibrate the amplitude gates in that rule.

The controller used the reported wind-tunnel setting (−0.7 m/s along x, equivalent to −0.1167 domain lengths/s). We disabled synthetic gusts and meander, restricted admissible source cells to the published 6 × 2 m search area, and left the built-in open-domain diffusion and hit-likelihood parameters at their reference values. The test uses the prevailing tunnel setting in place of local anemometer observations. No parameters were selected against source coordinates. The dataset has a single MOX trace and continuous sweeps, so it provides no four-inlet clipping evidence or repeated settled dwell readings to evaluate the mapped-fitting controller.

## Measurement and scoring

The source is ethanol. The onboard MiCS-5524 metal-oxide sensor records a voltage in mV. An external motion-capture system records the drone position in metres. The experimenters report 0.7 m/s wind and a 1 m flight-lane spacing for these trials. We compare horizontal estimates against the independently listed release coordinates. The arena centre is fixed at (6, 2) m. [Source coordinates, flight list and admissible measurement ranges](https://github.com/disal-epfl/ADApprox/blob/4f7b6c964163a8fcb9aeed5ef3993d49ff520aba/args/realworld_gsl.json)

We applied the authors' published voltage and pose bounds, then retained the first accepted row per timestamp. Both estimators use identical readings starting 2 s after the first accepted row so that position history exists for either delay. For the delayed arm, we linearly interpolate the recorded position at the earlier time. A total of 124,723 pose-synchronised log rows remain. The paper reports a 10 Hz physical gas sensor, so adjacent log rows can repeat an instrument reading. The sample size for performance is ten flights.

The input scalar is raw mV divided by 1,000, which preserves its ordering. The peak estimator needs neither a voltage-to-ppm conversion nor a detection threshold. We used no additional smoothing, deconvolution or parameter fitting. The two arms isolate the change in pose assignment. Every flight contained one source. This replay measures horizontal position error on recorded paths. Testing Plumnav's flight commands, blank rejection, methane response and the Birmingham backpack requires separate experiments.

## Reproduce

From the repository root, install the locked dependencies and run the following commands. The archive is about 13.6 MB. Only the physical source-localisation flights are used. The script verifies the ten flight files and the experimenters' reference coordinates against their published bytes.

```sh
curl -fL 'https://zenodo.org/records/17189796/files/adapprox_dataset.zip?download=1' -o /tmp/adapprox_dataset.zip
unzip -qo /tmp/adapprox_dataset.zip 'data/realworld/2025_02_12/*' -d /tmp/adapprox
pnpm exec vite-node scripts/robot-field-replay.ts /tmp/adapprox/data/realworld/2025_02_12
```

The JSON output includes the predictions, reference coordinates, horizontal errors, threshold, reference-strip row count and binary hit count for each flight. The archive SHA-256 is `22afaff97556bcc7fa9cb54ccca7a423bfd7a33a12ed84b3911f2a68dbd34f40`.
