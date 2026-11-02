# Use measured sensor data

`pnpm field:analyze` accepts local JSON and writes a JSON decision. Both operations are also available as TypeScript functions in `src/sim`. They accept observations without a source coordinate.

## Commission the gas threshold

Run `pnpm --silent field:analyze blank preflight.json`. Supply `signalUnit`, `policy` and an ordered array called `samples`. A sample has numeric `time` in seconds and `value` in the stated instrument unit, boolean `valid` and `inReference`, and optional boolean `clipped` and `contaminated`. The caller identifies a known clean-air reference. A steady, contaminated offset can pass statistical tests if the reference is misidentified.

Specify the eight policy fields `flushSeconds`, `spacingSeconds`, `maximumGapSeconds`, `minimumSamples`, `minimumSpan`, `maximumSpan`, `maximumDrift` and `margin`. Times are in seconds. Span, drift and margin use the same signal unit as `value`. Derive these limits from the installed instrument's measured repeatability, dynamic range and flush tests. The tunnel example uses mV for an ethanol MOX sensor. A methane backpack requires its own values. [Worked tunnel example](robot-field-replay.md)

A `ready` result contains the settled maximum plus the margin as the frozen threshold. A rejected result contains a null threshold and the reason. In a live process, instantiate `BlankBaseline`, call `observe()` while commissioning, call `finish()` before beginning search, and use `baselineHit()` on new readings. A null result indicates that a reading cannot be classified.

## Interpret a downwind methane traverse

Run `pnpm --silent field:analyze bearing traverse.json`. Supply `wind`, `samples`, and optionally `minimumEnhancementPpm` (default 0.05 ppm). Each sample has `eastMetres`, `northMetres` and `methanePpm`, with positions relative to a common local origin. Use valid, unsaturated readings aligned to the inlet pose. Supply contemporaneous `eastMetresPerSecond`, `northMetresPerSecond` and `angularSpreadDegrees` in `wind`. Wind components point in the direction air is moving. A wind from the west has a positive east component.

The result contains an observed crossing, its upwind bearing clockwise from geographic north, the wind spread and the width of the measured enhancement, or a reason for abstaining. The algorithm requires coverage on both sides of the enhancement. A single accepted plane leaves `sourcePoint` null. Apply the reported ray in the same coordinate frame as the input. [Eligibility gates and measured results](outdoor-wind-bearings.md)
