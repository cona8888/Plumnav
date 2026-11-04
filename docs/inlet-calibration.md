# Calibrate the inlet response before a stop-and-measure survey

Use this procedure to estimate how long a pumped gas channel needs to settle after the robot stops. The fitted quantities are the rise and recovery time constants in seconds. The model accounts separately for tube transit time and instrument averaging.

## Reproduce the numerical check

From the repository root, install the locked dependencies and run the bench example.

```sh
pnpm install --frozen-lockfile
pnpm exec vite-node scripts/field-sensor-calibration.cli.ts
```

The example uses the reference inlet geometry. An independent RK4 calculation produces two methane step traces with a prescribed rise constant of 1.75 s, recovery constant of 3.50 s, and independent additive Gaussian readout noise of 0.002 ppm standard deviation. The fitting code uses the production Plumnav inlet channel. It searches both constants between 0.1 and 60 s by least squares on the first trace. The second trace uses different pulse levels, durations, and noise. Both integrators assume the same physical response model.

| Quantity | Numerical result |
| --- | ---: |
| Training / held-out readings at 1 Hz | 100 / 108 |
| Fitted rise / recovery time constants | 1.754 / 3.497 s |
| Held-out RMSE with the original 0.910 / 2.000 s constants | 0.05281 ppm |
| Held-out RMSE with the fitted constants | 0.00197 ppm |
| Calculated ideal tube transit time | 0.754 s |
| Conservative 95% settling allowance including averaging | 12.231 s |
| Total inspection dwell at a 0.25 s engine tick | 14.5 s |

The dwell includes settling, two sample intervals, and a controller tick, rounded up to a whole tick. No hardware measurements enter this example.

## Use measured bench records

1. Fit the actual backpack inlet, tube, pump and sensor. Record the tube length, inner diameter, actual flow per channel, and instrument averaging interval. Hold these fixed in both records.
2. Zero and span the instrument separately. Start each run with the line and sensor equilibrated at the blank level. Use synchronized excess concentrations in ppm for both the reference delivered **at the inlet** and the sensor reading. Keep the input switching times on the sampling timestamps and hold the commanded level between switches. Signed blank-corrected sensor readings are supported.
3. In the training run, include a sustained rise, fall and washout. In a separate test run, vary the pulse level and duration to resemble the intended survey. Include short transitions and clean-air periods. Keep readings within the calibrated linear, unsaturated range. Fit each channel separately to check how well a common response represents the head.
4. Save each run as a numeric CSV with this header and a first sample at time zero.

```csv
time_s,inlet_ppm,measured_ppm
```

Supply the measured setup as JSON. The following values reproduce the reference setup.

```json
{
  "tubeLengthMetres": 1.0,
  "tubeInnerDiameterMetres": 0.002,
  "actualFlowLitresPerMinute": 0.25,
  "averagingSeconds": 1.0
}
```

```sh
pnpm exec vite-node scripts/field-sensor-calibration.cli.ts training.csv holdout.csv bench-setup.json
```

The CLI reports fitted time constants and absolute held-out error in ppm. Compare the error with the instrument's repeatability and the smallest concentration change the mission must resolve. Inspect separate rising and falling transitions if residuals remain large. Variable flow, humidity, adsorption, saturation, imperfect zero/span and unrecorded pump switching can all change the measured response.

## Apply a fit to a mission

```ts
import { calibrateInlet, withCalibratedSIInlet } from './scripts/field-sensor-calibration'

// training contains the output of parseBenchCsv. design contains the measured bench setup.
const fit = calibrateInlet(training, design)
const config = withCalibratedSIInlet(baseConfig, fit, design, atmosphere)
```

The adapter passes the fitted dynamics to the local-inlet engine and recalculates timing. It checks the tube geometry, flow and averaging against the bench setup. The current SI mission uses one shared pair of time constants for all four channels. Noise, detection threshold and saturation come from the separate atmosphere measurement contract. A real backpack requires independent zero/span, noise, threshold and cross-channel measurements before using these values for field decisions.
