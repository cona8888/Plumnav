# Following a methane plume upwind from a survey plane

A crosswind survey can show where the aircraft crossed a plume. Repeated passes over a single vertical plane under one mean wind provide a transverse constraint. Source range remains unresolved under this model. PlumeNav returns an **upwind bearing from the crossing** and a width of the measured enhancement, or abstains if the data do not support a crossing. The receiver returns a null source point for every single-plane survey.

## Measured performance

Both replays used the recorded methane signal, aircraft positions and contemporaneous wind. They preserved the original flight windows and peak estimates. Reference source coordinates entered scoring after the bearing had been computed. On every returned bearing, the source lay on the upwind side of the crossing.

| Campaign | Bearings / surveys | Median perpendicular miss (m) | Range (m) | Same-wind line from track midpoint (m), median | Same-wind line from measured peak (m), median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Blackpool, UK | 13 / 22 | 4.69 | 0.29–26.52 | 7.27 | 10.27 |
| MATRIX, Switzerland | 1 / 8 | 29.80 | Single result | 23.98 | 11.61 |

Each distance in the table is perpendicular from the known source to a line. The controls use exactly the same wind and the same accepted surveys. For the midpoint control we use the middle of the sampled crosswind span. Blackpool investigators deliberately centred their flight tracks using anticipated plume and wind conditions. This makes the midpoint a meaningful control. The methane-weighted crossing was closer than the midpoint on 6 of 13 accepted UK surveys and closer than the peak on 10 of 13. On the one accepted Swiss survey both controls were closer. The campaign comparison produced 14 directional constraints and no two-dimensional source estimates. [Per-survey errors and abstentions](outdoor-wind-bearing-results.csv) · [Blackpool methods](https://doi.org/10.5194/amt-13-1467-2020) · [MATRIX methods](https://doi.org/10.5194/amt-15-2177-2022)

Nine UK surveys produced no bearing. Five profiles had edge or disconnected enhancements, three lacked sustained contrast and one had weak or variable wind. Seven Swiss surveys produced no bearing. Three profiles had edge or disconnected enhancements, two had insufficient crosswind coverage and two lacked contrast. Both campaigns tested controlled releases. Specificity on clean-air flights remains unmeasured.

## Inference from one curtain

Call `estimateCurtainBearing(samples, wind, minimumEnhancementPpm)` in `src/sim/curtainBearing.ts`. Each sample supplies `eastMetres`, `northMetres` relative to a local origin and `methanePpm`. The wind record supplies horizontal velocity components **towards** transport in m/s and an angular variability or sensitivity in degrees. The output bearing is the compass direction **towards the upwind search region**, clockwise from geographic north. Its origin is the estimated plume crossing on the survey plane. A uniform local east/north frame is essential when integrating with a robot map.

1. Require a mean wind of at least 0.3 m/s and a supplied angular spread below 45°. Project the track along and across the mean wind. The middle 80% crosswind span must exceed or equal 4 m. The equivalent along-wind span must be at most 75% of the crosswind span.
2. Divide the full crosswind range into 12 equally wide bins. Require two or more readings in every bin. Use the 75th percentile of methane readings in each bin to reduce sensitivity to a single spike and repeated sampling at one horizontal position. Using a horizontal profile combines overlapping passes and heights.
3. Estimate background from the median of the outer two bin summaries on each flank. Require a bin excess above the greater of 0.05 ppm and three times the flank median absolute deviation scaled by 1.4826. The caller can replace the 0.05 ppm design floor with an independently calibrated value. Require one connected band spanning at least two interior bins with both outer flanks below threshold.
4. Average the median sample positions of the accepted bins, weighted by excess signal. Place the upwind half-line there. Report the measured band width and wind sensitivity with the result. The band width describes enhanced samples on the survey plane. The wind angle describes sensitivity to wind variability or component uncertainty. Neither quantity has been calibrated as a source-location confidence interval.

These geometric and signal gates were fixed before evaluating the known source coordinates. The two-dimensional method assumes one dominant plume transported by a representative wind. A second crossing with a suitably different, independently measured wind would provide an additional directional constraint if the same source and comparable transport could be established. These replays treat every survey separately.

## Wind records and reproduction

**Blackpool.** The stationary anemometer was 3.30 m above ground. We read the east and north velocity components at that height from each archived profile and checked their reverse bearing against the study's archived meteorological wind-from angle. To express angular sensitivity, vary the components over their published individual uncertainty ranges and take the largest bearing deviation at the four corners of the rectangle. A rectangle containing zero speed leaves the direction unresolved. The measure accounts for the coupled sensitivity of heading to the two components without assigning a confidence level. [Archive](https://doi.org/10.5281/zenodo.3708518)

**MATRIX.** We took the mean concurrent ground-station east/north velocities (`uu`, `vv`) over each scored UTC survey window, requiring at least 80% temporal coverage at 1 Hz. For these records, angular variability is the speed-weighted circular standard deviation of wind direction. The replay verifies the checksums of the two meteorology files. The stationary wind series and downwind aircraft measurements can sample different eddies. This contributes to uncertainty when projecting a crossing back towards the release. [Archive](https://doi.org/10.5281/zenodo.6335359)

Run the commands for the [Blackpool](real-flight-validation.md) and [MATRIX](methane-field-matrix.md) replays. Both JSON outputs include the wind, bearing or abstention reason and independent evaluation. For a returned bearing, `signedAlongRayMetres` is positive when the source lies upwind. `crosswindOffsetMetres` gives the distance to the infinite line and `distanceToRayMetres` gives the distance to the half-line. The JSON also includes both matched comparator errors.
