# Measured methane transect replay

How much does the sampling interval change the location that Plumnav marks as the highest reading on a driven transect? We replayed the three Durham, North Carolina passes recorded downwind of one controlled methane release of 0.6 g/s. EPA reports a nominal acquisition rate of 10 samples/s. The workbook gives the GPS coordinates and methane concentration for each row. [EPA dataset and original study](https://catalog.data.gov/dataset/methane-transect-dataset)

We fed each recorded pose and concentration into the production `coverage` controller. Its motion commands were ignored so that the vehicle followed the recorded path. Each full-pass estimate matched the position of the independently calculated maximum. We then retained every tenth row and tested all ten possible starting offsets.

| Pass | Measured readings | Peak in full record (ppmv) | Lowest peak across offsets (ppmv) | Largest shift from full-record peak (m) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 182 | 23.42 | 2.22 | 30.08 |
| 2 | 214 | 37.11 | 1.88 | 2.53 |
| 3 | 201 | 113.17 | 3.68 | 5.41 |

These shifts quantify how sensitive peak logging was to which rows the instrument retained. Each distance is the horizontal separation between two measured GPS positions. The workbook lacks release coordinates and per-row timestamps, so source-location accuracy and the exact timing of individual samples remain unknown. The observations already include the EPA instrument response. The replay applies no additional inlet filter. All three passes came from the same release.

## Reproduce

Run from the repository root after installing the locked Node dependencies. The existing workbook extractor requires Python and `openpyxl`. Use a fresh output path for the extracted JSON.

```sh
curl -fL 'https://pasteur.epa.gov/uploads/10.23719/1390071/Methane%20Transect%20Data%20Set.xlsx' -o /tmp/plumnav-epa.xlsx
python3 scripts/inspect-public-methane-workbook.py --input /tmp/plumnav-epa.xlsx --sha256 d408f8d7b9b0630132720ad069095230f442a6d24a8be159a8558bdb4b9e1b4d --output /tmp/plumnav-epa-rows.json
pnpm exec vite-node scripts/empirical-epa-replay.ts /tmp/plumnav-epa-rows.json
```

The extractor verifies the XLSX digest. The replay independently checks the row numbers, coordinates, and methane readings for all three passes against the expected cell digest. The output identifies each peak by workbook row, records all ten offsets, and reports the peak concentration and displacement for each offset. The replay uses a local equirectangular projection centred at the first recorded point in each pass.
