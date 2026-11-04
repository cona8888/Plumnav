# Use measured sensor data

`pnpm field:analyze` accepts local JSON and writes a JSON decision. Both operations are also available as TypeScript functions in `src/sim`. They accept observations without a source coordinate.

## Try two small operator records

Run these commands from the repository root after installing the locked dependencies. Both records are manufactured examples with known inputs.

```sh
pnpm --silent field:analyze blank validation/examples/blank-ppb.json
pnpm --silent field:analyze bearing validation/examples/methane-traverse.json
```

The reference record uses methane in ppb. Its largest settled reading is 2065 ppb and its 10 ppb margin gives a threshold of **2075 ppb**. Convert every signal limit, reading and margin together if changing concentration units.

The oblique traverse uses methane in ppm and positions in metres. Its noisy enhancement is centred about 3.5 m across the wind from (250, −100) m. The wind flows northeast, so the reported upwind bearing is **225°**, with a crossing near **(252.52, −102.52) m**. The example includes an invalid reading, a clipped reading and one retransmitted packet. The result leaves source range unresolved. A wind reported meteorologically as *from* 225° has positive east and north components, each equal to the speed divided by √2.

## Commission the gas threshold

Run `pnpm --silent field:analyze blank preflight.json`. Supply `signalUnit`, `policy` and an ordered array called `samples`. A sample has numeric `time` in seconds and `value` in the stated instrument unit, boolean `valid` and `inReference`, and optional boolean `clipped` and `contaminated`. Clocked copies of the same reading count once. A conflicting reference packet at the same timestamp yields a rejected baseline. Backwards clocks raise an input error. Explicitly invalid samples interrupt the continuous reference window. The caller identifies a known clean-air reference. A steady, contaminated offset can pass statistical tests if the reference is misidentified.

Specify the eight policy fields `flushSeconds`, `spacingSeconds`, `maximumGapSeconds`, `minimumSamples`, `minimumSpan`, `maximumSpan`, `maximumDrift` and `margin`. Times are in seconds. Span, drift and margin use the same signal unit as `value`. Derive these limits from the installed instrument's measured repeatability, dynamic range and flush tests. The tunnel example uses mV for an ethanol MOX sensor. A methane backpack requires its own values. [Worked tunnel example](robot-field-replay.md)

A `ready` result contains the settled maximum plus the margin as the frozen threshold. A rejected result contains a null threshold and the reason. In a live process, instantiate `BlankBaseline`, call `observe()` while commissioning, call `finish()` before beginning search, and use `baselineHit()` on new readings. A null result indicates that a reading cannot be classified.

## Interpret a downwind methane traverse

Run `pnpm --silent field:analyze bearing traverse.json`. Supply `wind`, `samples`, and optionally `minimumEnhancementPpm` (default 0.05 ppm). Each sample has `eastMetres`, `northMetres` and `methanePpm`, with positions relative to a common local origin. Align readings to the inlet pose. Optional boolean flags `valid: false` and `clipped: true` exclude a packet before signal and coverage checks. When timestamps are available, include numeric `time` in seconds on every packet, in acquisition order. An exact retransmission counts once and conflicting or backward timestamps raise an error. Without timestamps, identical position/concentration records count once. Large time gaps may represent different wind conditions, so submit one survey window with representative wind. Supply contemporaneous `eastMetresPerSecond`, `northMetresPerSecond` and `angularSpreadDegrees` in `wind`. Wind components point in the direction air is moving. A wind from the west has a positive east component.

The result contains an observed crossing, its upwind bearing clockwise from geographic north, the wind spread and the width of the measured enhancement, or a reason for abstaining. The algorithm requires coverage on both sides of the enhancement. A single accepted plane leaves `sourcePoint` null. Apply the reported ray in the same coordinate frame as the input. [Eligibility gates and measured results](outdoor-wind-bearings.md)
