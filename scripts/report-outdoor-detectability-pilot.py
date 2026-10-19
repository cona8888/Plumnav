#!/usr/bin/env python3
"""Seal the accepted development pilot, preserving the earlier failed run."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--input', type=Path, required=True)
args = parser.parse_args()
root = args.input
read = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
audit = read(root/'audit.json')
manifest = read(root/'manifest.json')
repeat = read(root/'reproducibility.json')
assert audit['accepted'] and audit['developmentOnly'] and repeat['passed']
assert audit['manifestSha256'] == repeat['manifestSha256'] == sha(root/'manifest.json')
assert audit['executionReceiptSha256'] == sha(root/'execution-complete.json')
assert audit['rawHistories'] == 24 and audit['primaryOutcomes'] == 1152
assert audit['independentWorldsPerSetting'] == 4 and len(audit['resolutionTriplets']) == 4
assert all(x['passed'] for x in audit['resolutionTriplets'])
assert all(sha(Path(r['file'])) == r['sha256'] for r in manifest['sourceHashes'])
assert all(sha(Path(r['file'])) == r['sha256'] for r in manifest['frozenStage2i']['hashes'])
old = root.parent/'outdoor_detectability_pilot_v1_2026-09-22'/'audit.failed.json'
assert read(old)['accepted'] is False
primary_minutes = audit['projected128WorldPrimarySeconds']/60
refinement_minutes = 4*(audit['executionSeconds']-audit['primaryExecutionSeconds'])/60
projected_minutes = primary_minutes+refinement_minutes
field_points = sum(x['independentFieldPoints'] for x in audit['checks'])
report = f'''# Outdoor detectability pilot: accepted numerical prototype

Accepted {audit['checkedAt']}. This is a **development pilot**, separate from
Stage 2i, not a held-out performance study or physical validation.

## Delivered and checked

- 100 m × 100 m prescribed outdoor survey in SI units, local 3-D concentration
  queries, six hypothetical sensor models, delay/response/recovery/noise,
  persistent measurement state and measurement-only alarms.
- **24 full histories**, including **16 primary histories** and **4 resolution
  triplets**. The 1152 primary outcomes represent only **4 independent worlds
  per setting**, not 1152 independent trials.
- Independent reconstruction of all sensor histories and alarms, {field_points}
  separately integrated field points, exact source/configuration/hash checks,
  and identical paired blank measurements across wind conditions.
- All **141 original Stage 2i scientific files unchanged**.
- Complete first-primary-history regeneration is identical: 2400 inlet rows and
  24 sensor histories. This reproducibility witness is not a repeat of all cases.
- Nine TypeScript unit-test groups, six Python audit tests and eight corruption-
  rejection checks passed during development. New-code and main-app typechecks
  passed using existing bundled Node type definitions; no dependencies installed.

## Numerical correction and preserved failure

The first run failed an independent near-peak field check. Its original data
and failure receipt remain in `../outdoor_detectability_pilot_v1_2026-09-22/`.
Candidate v2 reduced quadrature panel duration fourfold and reran every case.
Physical parameters, seeds, sensor timing, alarm logic and acceptance tolerances
were not changed. No failed output is included in accepted summaries.

## What this does and does not establish

The measurement pipeline and numerical pilot passed their declared checks.
The independent field calculation is a numerical verification of the same
idealised physical equation, **not independent physical validation**.

The 600 s survey covers 295 m at 0.5 m/s or 580 m at 1 m/s, including stationary
turn penalties, out of a 990 m prescribed route. Neither completes the full route.
This coverage/response trade-off must be retained in interpretation.

There is **no qualified minimum detectable emission rate**, real-device ranking,
new algorithm ranking, certification or urban/UAV/buried-source validation from
these four worlds. Generic sensor factors are not commercial calibration data.
All descriptive setting-level results and pointwise Wilson intervals are saved
in `audit.json`; no favourable subset is promoted to a performance conclusion.

## Compute decision and next work

Local execution: **{audit['executionSeconds']:.2f} s**;
independent audit: **{audit['auditSeconds']:.2f} s**.
The proposed 128-world study has 512 primary histories and 32 additional refined
histories. Serial extrapolation is **{primary_minutes:.1f} min primary +
{refinement_minutes:.1f} min witnesses = {projected_minutes:.1f} min simulation**.
Allow roughly **{projected_minutes*1.5:.0f} min simulation headroom**, plus independent
audit and I/O. This is an estimate from this Mac, not a completed campaign or
measured parallel speedup.

**Recommend the Mac for this bounded next sweep; AWS is not needed yet.** No
AWS job was launched, no credentials changed, and the old monitor stays paused.
The held-out worlds remain unused. Freeze the full campaign manifest/statistical
rules and executable before running them. Selected existing GSL controllers
still require separately tested source-blind SI/closed-loop integration.

See the [prospective protocol](../../protocols/outdoor_detectability_v1_2026-09-22.md),
[held-out preparation plan](../../protocols/outdoor_detectability_holdout_plan_2026-09-22.md)
and [benchmark usage notes](../../OUTDOOR_BENCHMARK_README.md).
'''
with (root/'report.md').open('x') as f:
    f.write(report)
closure = dict(schemaVersion='outdoor-detectability-pilot-closure-v1', accepted=True,
    developmentOnly=True, checkedAt=datetime.now(timezone.utc).isoformat(),
    manifestSha256=sha(root/'manifest.json'), auditSha256=sha(root/'audit.json'),
    reproducibilitySha256=sha(root/'reproducibility.json'), reportSha256=sha(root/'report.md'),
    preservedFailedAuditSha256=sha(old), originalScientificFilesUnchanged=141,
    rawHistories=24, primaryOutcomes=1152, independentWorldsPerSetting=4,
    formalCampaignRun=False, physicalValidation=False, awsLaunched=False,
    projectedSerialSimulationMinutes=projected_minutes)
with (root/'closure.json').open('x') as f:
    json.dump(closure, f, indent=2, allow_nan=False); f.write('\n')
print(json.dumps(closure, indent=2))
