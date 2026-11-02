# Blackpool methane survey inputs

Adil Shah, Hugo Ricketts, Paul I Williams, J Brian Leen, Joseph R Pitt and Grant Allen (2020). *Data from the Blackpool testing controlled methane release field campaign of 2018*. Zenodo, published 13 March 2020. The authors licensed this dataset under Creative Commons Attribution 4.0 International. The license applies to the extracted observations distributed here. [Dataset and authors](https://doi.org/10.5281/zenodo.3708518) · [Zenodo license and file metadata](https://zenodo.org/api/records/3708518) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

| Publisher file | Size (bytes) | Zenodo MD5 | Verified SHA-256 |
| --- | ---: | --- | --- |
| `Testing Data.zip` | 112690365 | `9825ff79de75931b5f848f27cc1ea34c` | `4f1053c692a4210092238bba855ff2236ae6357bb7dada86ea1bce16c986b603` |

## Changes made for PlumeNav

From the authors' 22 analysed MATLAB surveys, we selected all 77,135 rows of recorded time, absolute latitude/longitude and methane mole fraction. We retained their original sequence, precision and instrument-specific timing corrections. Each gzip file contains a JSON object for one survey. Seven `T1` files correspond to UAV1 and fifteen `T2` files to UAV2.

| JSON field | Source and units |
| --- | --- |
| `rows` | Each array contains `FullData.Time` in seconds, `FullData.IntLatitude` and `FullData.IntLongitude` in decimal degrees, and `FullData.CH4` in ppm. The decoder checks the latter against the separate unit-mole-fraction channel. |
| `wind` | Eastward and northward wind components in m/s from the survey's 3.30 m reference height. Angular sensitivity in degrees is computed from the archived component uncertainties using the four corners of their joint rectangle. |
| `truth` | `Variables.SourceLatitude` and `Variables.SourceLongitude`, retained separately for scoring. |
| `survey` | Original flight survey identifier, e.g. `T1.1`. |

The decoder selects these fields from the authors' analysis files and serializes the binary64 readings without decimal rounding. Related modelling, flux and instrument channels are available in the complete dataset. Preserving the authors' surveyed trajectories allows a recorded-path replay. The aircraft followed their own flight plans. [Upstream archive](https://zenodo.org/records/3708518/files/Testing%20Data.zip?download=1) · [Study](https://doi.org/10.5194/amt-13-1467-2020)

## Replay and rebuild

From the repository root, `pnpm exec vite-node scripts/blackpool-field-replay.ts` runs directly on these files. The loader verifies SHA-256 `616a543fa8d4cc2c1ceb7be58c6637a6f5eff5c6b6ed89b9b2962407ff237d54` over the concatenated, decompressed records in numerical flight order (UAV1 followed by UAV2), including their trailing newlines.

Rebuild the compact files into a fresh directory from the unmodified publisher ZIP using Python 3.11 or later, NumPy and SciPy. The extraction checks the original archive hash and the wind bearing convention for every flight. On the validated inputs the bundled and original replay modes produced byte-identical JSON, including wind estimates, matched line errors and abstentions.

```sh
python3 scripts/package-outdoor-validation-data.py blackpool /path/to/Testing_Data.zip /tmp/blackpool-rebuilt
pnpm exec vite-node scripts/blackpool-field-replay.ts /path/to/Testing_Data.zip
```
