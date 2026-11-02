# Transferring the blank threshold between EPFL flights

We repeated the pre-search calibration with each of the ten physical flights in turn. Each fold reserved one complete flight to establish the upstream blank. A successful fold applied that one frozen threshold to the other nine flights. The fixed ex1 commissioning protocol remains the default.

The upstream region, purge, blank acceptance criteria, signal margin, 2 s delay alignment, 1 Hz sample selection, Infotaxis prior, native declaration rule and source scoring were identical in all folds. Each target flight remained unavailable during blank calibration. The known source positions entered only after predictions were calculated. A rejected blank skipped all nine intended searches in that fold. The flights are being assigned calibration and search roles offline, so the fold order does not assert acquisition order.

Five reference flights passed commissioning. The resulting thresholds ranged from **188.9 to 212.4 mV**. With ex4 as the reference, every held-out flight registered an encounter, yet the median final Infotaxis error was **3.595 m**. The peak method reached **0.667 m** on those same flights. With the other accepted references, median Infotaxis errors ranged from **0.421 to 0.591 m** among flights with at least one encounter. These endpoint estimates did not trigger native declarations.

| Reference flight | Accepted threshold (mV) | Gas-positive searches / scored | Infotaxis median (m) | Paired peak median (m) |
| --- | ---: | ---: | ---: | ---: |
| ex1 | 212.4 | 8/9 | 0.421 | 0.609 |
| ex4 | 188.9 | 9/9 | 3.595 | 0.667 |
| ex5 | 205.1 | 9/9 | 0.477 | 0.667 |
| ex6 | 201.0 | 9/9 | 0.537 | 0.667 |
| ex9 | 200.2 | 9/9 | 0.591 | 0.667 |

Ex2, ex3, ex7 and ex10 produced too few valid time-separated readings in the final uninterrupted calibration segment. Ex8 had conflicting records at one timestamp about whether the instrument was inside the reference area. The CSV includes every reference flight and its outcome. Empty outcome columns denote withheld searches. Both error medians in each row use exactly the same gas-positive flights. The other flights can be examined individually with the command below. The folds reuse measurements from the same ten flights and should be interpreted individually.

## Reproduce offline

After installing the locked dependencies, run these commands from the repository root.

```sh
node scripts/robot-field-sensitivity.mjs
pnpm exec vite-node scripts/robot-field-replay.ts --commissioning-flight=4
```

The first command prints the complete CSV. The second prints per-flight estimates, binary hit counts and native declaration flags for one reference. [All fold results](commissioning-sensitivity.csv) · [Replay method](../../../docs/robot-field-replay.md)
