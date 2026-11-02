# Localising a known ethanol release from measured drone flights

We tested Plumnav's unchanged Infotaxis source estimator on nine physical Crazyflie ethanol flights. We reserved a tenth flight for pre-search sensor commissioning. The median final horizontal error was **0.399 m** for Infotaxis and **0.551 m** for the peak-reading estimator on the same 1 Hz observations. None of the flights triggered a native source declaration. The drone followed the experimenters' recorded paths in a 6 m × 2 m wind-tunnel survey area. [Dataset](https://doi.org/10.5281/zenodo.17189796) · [Experiment and instrument](https://doi.org/10.1109/IROS60139.2025.11246155)

## Pre-search calibration

The onboard MiCS-5524 logs a voltage in mV. The authors use x > 8.75 m as their upwind reference strip. The drone reaches it about 155 s into a 174 s scan, too late to set the initial detection threshold from that same flight. We designated ex1 as a commissioning record and froze the threshold before reading any search flights. This tests transfer from a separate reference flight. It makes no assumption about the original flight order. [Authors' reference region](https://github.com/disal-epfl/ADApprox/blob/4f7b6c964163a8fcb9aeed5ef3993d49ff520aba/data_preparation/data_pipline.py)

The streaming blank-calibration component first requires an operator-designated reference region. It discards the first 4 s there for purge and settling. It then requires at least eight valid readings spaced by 2 s. A gap longer than 0.5 s, leaving the region, or invalid input restarts the collection. Explicit clipping or contamination flags veto that session. The acceptance checks require at least 1 mV of variation among the spaced readings, at most 20 mV total span across settled readings and at most 8 mV difference between the early and late median. On acceptance, the frozen hit threshold is the largest settled reading plus 1 mV. These are engineering choices for this instrument replay. Time separation reduces repeat counting, but cannot demonstrate statistical independence. The archive supplies no independent clean-air certificate or clipping flag. A stable contaminated reference can pass the numerical checks.

The ex1 blank passed with eight spaced readings, a settled range of 194.4–211.4 mV and a 3.3 mV median shift. All nine search flights used **212.4 mV**. A failed commissioning record produces skipped searches with a reason and no fitted threshold. The ordinary production component is in `src/sim/baseline.ts`. It exposes the accepted or rejected state to callers and returns no hit classification for a missing observation or rejected baseline.

## Held-out source estimates

Each estimator received the first recorded reading in every occupied one-second interval, yielding 173 per flight. We attributed readings to the interpolated position 2 s earlier using the experimenters' published sensor delay. We used the reported −x tunnel wind (0.7 m/s, equivalent to 0.1167 domain lengths/s), no synthetic gusts or meander, and Plumnav's reference diffusion prior. Possible source cells were restricted to the surveyed rectangle. The Infotaxis posterior uses a binary hit when voltage strictly exceeds the frozen threshold. Voltage divided by 1,000 preserves the rank used by the peak estimator. No conversion to ppm or tuning against the source coordinates entered either estimator. The experimenters' reference coordinates were loaded only after predictions were frozen. [Flight list, admissible ranges and source coordinates](https://github.com/disal-epfl/ADApprox/blob/4f7b6c964163a8fcb9aeed5ef3993d49ff520aba/args/realworld_gsl.json)

| Source estimate or control | Median error (m) | Mean error (m) | Worst error (m) | Within 1 m |
| --- | ---: | ---: | ---: | ---: |
| Fixed arena centre | 1.610 | 1.804 | 2.579 | 1/9 |
| Infotaxis with every gas input forced to a miss | 2.837 | 2.521 | 4.870 | 3/9 |
| Peak voltage at matched 1 Hz poses | 0.551 | 1.116 | 4.371 | 6/9 |
| Infotaxis native final point estimate | 0.399 | 0.370 | 0.610 | 9/9 |
| Centre of highest-weight Infotaxis grid cell | 0.294 | 0.306 | 0.477 | 9/9 |

| Flight | Threshold exceedances | Peak error (m) | Native Infotaxis error (m) | All-miss error (m) |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 17 | 1.454 | 0.542 | 2.837 |
| 3 | 12 | 1.241 | 0.399 | 3.691 |
| 4 | 15 | 0.539 | 0.610 | 4.870 |
| 5 | 2 | 0.551 | 0.390 | 0.101 |
| 6 | 0 | 0.386 | 0.228 | 0.228 |
| 7 | 3 | 0.440 | 0.122 | 3.798 |
| 8 | 16 | 4.371 | 0.443 | 4.792 |
| 9 | 6 | 0.398 | 0.477 | 0.830 |
| 10 | 4 | 0.667 | 0.119 | 1.540 |

Flight 6 illustrates a limitation of endpoint error. All of its gas readings fell below threshold. Its 0.228 m error was reproduced with the gas signal removed, and the output withholds an encounter-supported estimate. Eight flights supplied at least one hit. For those eight, native Infotaxis had a median error of 0.421 m (8/8 within 1 m), compared with 0.609 m for the matched peak (5/8). The recorded paths contain no target-absent sorties. They provide a single MOX trace without the four-inlet channel and repeat-dwell observations required by the mapped-fitting policy.

## Historical comparison

The optional protocol `upstream-retrospective-v1` computes a separate 99th-percentile upstream threshold from each full search record. It reproduces the previous ten-flight result of 0.475 m median native error, 9/10 within 1 m, and a 4.223 m worst error. The causal protocol reserves one flight, uses an independent fixed threshold, and scores a different cohort. Read the paired results within each protocol when comparing methods.

## Reproduce

From the repository root, install the locked dependencies and run the following commands. The archive is about 13.6 MB. Only the physical source-localisation flights are used. The script verifies the ten flight files and the experimenters' reference coordinates against their published bytes.

```sh
curl -fL 'https://zenodo.org/records/17189796/files/adapprox_dataset.zip?download=1' -o /tmp/adapprox_dataset.zip
unzip -qo /tmp/adapprox_dataset.zip 'data/realworld/2025_02_12/*' -d /tmp/adapprox
pnpm exec vite-node scripts/robot-field-replay.ts /tmp/adapprox/data/realworld/2025_02_12
```

The default output includes the protocol, frozen calibration record, skipped flight and reasons, predictions, hit counts, native declaration flags, and horizontal errors including the all-miss control. Add `--legacy-retrospective` after the directory argument to reproduce the historical protocol. The archive SHA-256 is `22afaff97556bcc7fa9cb54ccca7a423bfd7a33a12ed84b3911f2a68dbd34f40`.
