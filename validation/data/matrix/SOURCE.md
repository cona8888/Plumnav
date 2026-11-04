# MATRIX methane survey inputs

Randulph Morales, Jonas Ravelid, Katarina Vinkovic, Piotr Korbeń, Béla Tuzson, Lukas Emmenegger, Huilin Chen, Martina Schmidt, Sebastian Humbel and Dominik Brunner (2022). *Dataset - Controlled release experiment to investigate uncertainties in UAV-based emission quantification for methane point sources*. Zenodo, published 7 March 2022. The authors licensed this dataset under Creative Commons Attribution 4.0 International. The license applies to the files and extracted columns distributed here. [Dataset and authors](https://doi.org/10.5281/zenodo.6335359) · [Zenodo license and file metadata](https://zenodo.org/api/records/6335359) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

| Publisher file | Size (bytes) | Zenodo MD5 | Verified SHA-256 |
| --- | ---: | --- | --- |
| `MATRIX_Dataset.zip` | 13389482 | `f792e7465772c3f0ba0546b5b92e9c29` | `0877ded553b69db936e9bb4de0a61c3ff01fe0945ada1b0349331fa044c9a047` |

## Changes made for PlumeNav

* Each flight directory contains its original Empa spectrometer methane CSV, with gzip compression. Decompression recovers the authors' original file bytes, including headers, units, UTC windows, methane values, GPS, flags, missing values and release descriptions.
* All 18 methane files are included so that eligibility follows from the archived metadata. Eight files explicitly identify the release coordinates. For these flights, the inclusive measurement windows retain 4,436 methane and GPS records. The other ten files remain available to inspect the documented exclusion.
* The two `MATRIX_Meteo` files preserve every daily timestamp and the original textual `uu` and `vv` values, including missing observations. These are the east and north transport components in m/s. For this extract, we selected three columns and standardized the wind CSVs to LF newlines. The receiver derives survey means and angular spread from those time series. Full meteorology files, other meteorology dates, humidity and AirCore data are available in the publisher archive. [Upstream archive](https://zenodo.org/records/6335359/files/MATRIX_Dataset.zip?download=1) · [Study](https://doi.org/10.5194/amt-15-2177-2022)

## Replay and rebuild

From the repository root, `pnpm exec vite-node scripts/methane-field-matrix.ts` runs directly on these files. The loader verifies the joint SHA-256 over the 18 named, decompressed methane files (`c6a674ecdc72061961d46772aaaeae8b949945e49ab3c27a3f5cf4db1b2baeec`) and the individual wind-file hashes. To inspect a flight with standard software, decompress its CSV using `gzip -dc` or any gzip reader.

Rebuild from the unmodified publisher ZIP with Python 3.11 or later and its standard library. To run against the full original files, point the replay at the extracted dataset directory. On the validated inputs the two replay modes produced byte-identical JSON, including window selections, wind estimates, matched line errors and abstentions.

```sh
python3 scripts/package-outdoor-validation-data.py matrix /path/to/MATRIX_Dataset.zip /tmp/matrix-rebuilt
pnpm exec vite-node scripts/methane-field-matrix.ts /path/to/MATRIX_Dataset
```
