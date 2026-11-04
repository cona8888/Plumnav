# Measured source-location error on Swiss methane flights

On 13 and 14 March 2020, the MATRIX team flew a UAV carrying a quantum cascade laser spectrometer through vertical sampling planes downwind of a controlled methane release near Dübendorf, Switzerland. The Empa methane files record UTC time, aircraft position, corrected methane readings and the measurement window. Eight files explicitly identify the release latitude and longitude. This gives two independently labelled release positions, one per day. [Morales et al., 2022](https://doi.org/10.5194/amt-15-2177-2022) · [MATRIX data archive](https://doi.org/10.5281/zenodo.6335359)

We replayed each recorded track through PlumeNav’s production Coverage peak estimator with motion commands ignored. A separate scan verified the earliest maximum of the measured methane signal. We scored horizontal GPS distance from the reported position to the release. The nearest sampled position gives the best distance that any choice *among recorded positions* could have attained.

| Flight | Valid readings | Peak signal (ppm) | Source error (m) | Closest sampled position to source (m) |
| --- | ---: | ---: | ---: | ---: |
| 313_01 | 478 | 7.834 | 37.82 | 30.62 |
| 313_02 | 521 | 13.749 | 39.17 | 34.02 |
| 313_03 | 451 | 4.695 | 68.31 | 66.01 |
| 313_04 | 674 | 3.528 | 67.04 | 60.27 |
| 313_05 | 660 | 8.816 | 37.56 | 29.39 |
| 314_01 | 517 | 4.464 | 32.36 | 29.74 |
| 314_02 | 666 | 4.623 | 43.64 | 29.41 |
| 314_03 | 469 | 16.093 | 48.73 | 27.16 |

The median horizontal error was **41.40 m**. The aircraft stayed at least 27.16 m from the release in every scored flight window. Marking the largest reading on such a track identifies downwind methane. Estimating a source beyond the track requires another inference method or new measurements. This replay evaluates the peak estimator on flown trajectories. The study originally designed the flights for emission-rate quantification. These records provide no test of PlumeNav steering, false alarms on blank flights or quadruped backpack calibration.

## Input selection

We examined the Empa methane file in each of the archive’s 18 flight directories. Eight explicitly label the source location. The other ten specify a generic location in the methane header and were excluded. The release was at 47.390525° N, 8.603439° E on 13 March and 47.390697° N, 8.603264° E on 14 March. The evaluator reads these coordinates only for scoring.

We used the inclusive UTC start and end times in each file header. This retained 4,436 of 5,636 records from the eight flights. The 1,200 excluded records fell outside the stated measurement windows. All in-window rows had numeric positions, finite sensor readings and the archive flag `o`. The receiver rejects invalid values marked `-999.99` and other flags. It divides the corrected signal `CH4_spec_corr` by 1,000 to convert ppb to ppm and retains signed readings. No background subtraction, smoothing or fitting uses the release coordinates. Distances follow a spherical great-circle calculation and ignore flight height.

## Reproduce

Run from the project root after installing the locked dependencies. These commands verify the published archive bytes before extraction. The receiver prints per-flight source and peak coordinates, times, selection counts and distances in JSON.

```sh
curl -fL 'https://zenodo.org/records/6335359/files/MATRIX_Dataset.zip?download=1' -o /tmp/plumnav-matrix.zip
python3 -c "from hashlib import sha256; from pathlib import Path; assert sha256(Path('/tmp/plumnav-matrix.zip').read_bytes()).hexdigest() == '0877ded553b69db936e9bb4de0a61c3ff01fe0945ada1b0349331fa044c9a047'"
unzip -qo /tmp/plumnav-matrix.zip -d /tmp/plumnav-matrix
pnpm exec vite-node scripts/methane-field-matrix.ts /tmp/plumnav-matrix/MATRIX_Dataset
```
