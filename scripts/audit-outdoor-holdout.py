#!/usr/bin/env python3
"""Independent acceptance of smoke or all 544 held-out histories."""
import argparse
from datetime import datetime, timezone
import gzip
import importlib.util
import json
from pathlib import Path
import time
import numpy as np
from lib.outdoor_holdout_statistics import summarise

spec = importlib.util.spec_from_file_location('pilot_audit', Path(__file__).with_name('audit-outdoor-detectability.py'))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)
require, read, sha = pilot.require, pilot.read, pilot.sha
WITNESSES = [1000, 1042, 1085, 1127]
HOLDOUT = dict(version='outdoor-detectability-holdout-v1', worlds=[1000, 1127], witnessWorlds=WITNESSES,
    primaryHistories=512, totalHistories=544, independentWorlds=128, primaryOutcomes=36864,
    primaryContrast=dict(noisePpm=.2, fastRiseSeconds=.5, slowRiseSeconds=5, wind=.5, speed=1,
                         rateKgPerSecond=1e-4, k=5, direction='fast-minus-slow'),
    bootstrap=dict(seed=2230922, resamples=10000, generator='numpy-PCG64', intervalQuantiles=[.0125, .9875],
                   endpoints=['alarm-fraction', 'restricted-time-seconds'],
                   interpretation='Nominal Bonferroni-adjusted 97.5% percentile intervals for two endpoints; bootstrap coverage is approximate.'),
    targets=dict(pod=.9, falseAlarm=.05, interval='pointwise-Wilson-95-not-simultaneous'),
    sourceProbeOffsetsMetres=[[0, 0], [.25, 0], [1, 0], [0, .25]], sourceProbeTimesSeconds=[.125, 600.125],
    workers=4, maxRuntimeSeconds=3600, physicalValidation=False, paidLaunchAuthorized=False)


def specs(mode):
    require(mode in ['smoke', 'campaign'], 'Unknown mode')
    return [dict(world=w, wind=u, speed=v, resolution=r) for w in ([0] if mode == 'smoke' else range(1000, 1128))
            for u in [.5, 2] for v in [.5, 1] for r in ([0, 1, 2] if mode == 'campaign' and w in WITNESSES else [0])]


def max_overlap(receipts):
    events = sorted([(r['startedMs'], 1) for r in receipts] + [(r['endedMs'], -1) for r in receipts])
    count = maximum = 0
    for _, delta in events:
        count += delta
        maximum = max(maximum, count)
    require(count == 0, 'Worker interval imbalance')
    return maximum


def source_checks(trace):
    expected = [(t, dx, dy) for t in [.125, 600.125] for dx, dy in [(0, 0), (.25, 0), (1, 0), (0, .25)]]
    require(len(trace['sourceProbes']) == 8, 'Source witness count')
    errors = []
    source = trace['world']['source']
    for row, (t, dx, dy) in zip(trace['sourceProbes'], expected):
        require(row['t'] == t and row['x'] == source['x']+dx and row['y'] == source['y']+dy and row['z'] == .05, 'Source witness geometry')
        require(np.isfinite(row['referenceExcessPpm']) and row['referenceExcessPpm'] >= 0, 'Source witness value')
        reference = pilot.independent_concentration(row, trace['fieldSettings'], t+600)
        error = abs(row['referenceExcessPpm']-reference)
        require(error <= 1e-6 + .001*abs(reference), f'Source-proximal quadrature failed: {error}')
        errors.append(error)
    return dict(points=8, maxErrorPpm=max(errors))


def resolution_checks(traces):
    lookup = {(t['spec']['world'], t['spec']['wind'], t['spec']['speed'], t['spec']['resolution']): t for t in traces}
    out = []
    for world in WITNESSES:
        # Only relabel the lookup index for the frozen world-0 resolution checker.
        # No history, geometry, clock, measurement or decision is transformed.
        indexed = [dict(t, spec=dict(t['spec'], world=0)) for key, t in lookup.items() if key[0] == world]
        out.extend(dict(row, world=world) for row in pilot.resolution_check(indexed))
    require(len(out) == 16, 'Resolution triplet count')
    return out


def audit(root):
    manifest, complete = read(root/'manifest.json'), read(root/'execution-complete.json')
    mode = manifest['mode']
    require(manifest['schemaVersion'] == HOLDOUT['version'] and manifest['holdout'] == HOLDOUT, 'Frozen holdout design changed')
    require(manifest['design'] == pilot.EXPECTED_DESIGN and manifest['specs'] == specs(mode), 'Physical settings/cases changed')
    require(manifest['workers'] == 4 and manifest['maxRuntimeSeconds'] == 3600, 'Resource settings')
    require(complete['executionComplete'] and complete['independentlyAccepted'] is False and not (root/'failure.json').exists(), 'Execution incomplete/failed')
    require(complete['manifestSha256'] == sha(root/'manifest.json') and complete['eventLogSha256'] == sha(root/'execution-events.jsonl'), 'Execution/manifest integrity')
    for row in manifest['sourceHashes']:
        require(sha(root/'source-snapshot'/row['file']) == row['sha256'] == sha(row['file']), 'Frozen source changed')
    pp = Path(manifest['pilot']['directory'])
    require(sha(pp/'closure.json') == manifest['pilot']['closureSha256'], 'Pilot closure hash')
    pc = read(pp/'closure.json')
    require(pc['accepted'] and pc['manifestSha256'] == sha(pp/'manifest.json') and pc['auditSha256'] == sha(pp/'audit.json'), 'Pilot acceptance')
    require(read(pp/'manifest.json') == manifest['pilot']['manifest'], 'Pilot provenance mismatch')
    frozen = manifest['pilot']['manifest']['frozenStage2i']
    require(len(frozen['hashes']) == 141 and sha(frozen['bundle']) == frozen['bundleSha256'], 'Stage2i inventory')
    require(all(sha(row['file']) == row['sha256'] for row in frozen['hashes']), 'Stage2i source changed')
    if mode == 'campaign':
        smoke = manifest['smokeEvidence']; sr = Path(smoke['directory'])
        require(sha(sr/'audit.json') == smoke['auditSha256'], 'Smoke hash')
        sa = read(sr/'audit.json')
        require(sa['accepted'] and sa['mode'] == 'smoke' and sa['compatibilityPassed'] and sa['maxConcurrentWorkers'] == 4, 'Smoke admission')
        require(read(sr/'manifest.json')['sourceHashes'] == manifest['sourceHashes'], 'Not same-source smoke')
    else:
        require(manifest['smokeEvidence'] is None, 'Unexpected smoke link')
    expected = specs(mode); count = len(expected)
    require(len(complete['files']) == count and sorted(p.name for p in root.glob('trace-*.json.gz')) == [f'trace-{i:03d}.json.gz' for i in range(count)], 'Output inventory')
    require(len(complete['exits']) == 4 and all(x['code'] == 0 for x in complete['exits']) and
            len({x['pid'] for x in complete['exits']}) == 4, 'Worker exits')
    traces, checks = [], []
    for i, (receipt, setting) in enumerate(zip(complete['files'], expected)):
        require(receipt['index'] == i and receipt['file'] == f'trace-{i:03d}.json.gz', 'Receipt ordering')
        file = root/receipt['file']
        require(sha(file) == receipt['sha256'] and file.stat().st_size == receipt['bytes'] and
                read(root/f'trace-{i:03d}.receipt.json') == receipt, 'Raw history hash/receipt')
        require(receipt['endedMs'] > receipt['startedMs'] and receipt['userCpuMicroseconds'] > 100000, 'Worker did not show actual CPU/time work')
        require(receipt['pid'] in {x['pid'] for x in complete['exits']}, 'Unknown receipt worker PID')
        trace = json.loads(gzip.decompress(file.read_bytes()))
        checked = pilot.check_trace(trace, setting)
        checked['sourceProbes'] = source_checks(trace)
        if mode == 'smoke':
            previous_index = [0, 3, 6, 9][i]
            previous = json.loads(gzip.decompress((pp/f'trace-{previous_index:03d}.json.gz').read_bytes()))
            require({k: v for k, v in trace.items() if k != 'sourceProbes'} == previous, 'Pilot full-history compatibility')
        traces.append(trace); checks.append(checked)
        if (i+1) % 16 == 0 or i+1 == count:
            print(f'audited {i+1}/{count}', flush=True)
    maximum = max_overlap(complete['files'])
    require(maximum == 4, 'Did not observe four concurrent active workers')
    triples = resolution_checks(traces) if mode == 'campaign' else []
    # All four wind/speed variants have exactly the same temporal blank input.
    for world in ([0] if mode == 'smoke' else range(1000, 1128)):
        rows = [t for t in traces if t['spec']['world'] == world and t['spec']['resolution'] == 0]
        require(len(rows) == 4 and all(t['measurements'][:6] == rows[0]['measurements'][:6] for t in rows), 'Blank pairing')
    result = dict(schemaVersion='outdoor-holdout-audit-v1', mode=mode, accepted=True,
        manifestSha256=sha(root/'manifest.json'), executionReceiptSha256=sha(root/'execution-complete.json'),
        checkedAt=datetime.now(timezone.utc).isoformat(), rawHistories=count,
        primaryHistories=sum(s['resolution'] == 0 for s in expected),
        independentWorldsPerSetting=1 if mode == 'smoke' else 128,
        compatibilityPassed=mode == 'smoke', maxConcurrentWorkers=maximum,
        originalScientificFilesUnchanged=141, executionSeconds=complete['seconds'],
        checks=checks, resolutionTriplets=triples, physicalValidation=False)
    if mode == 'campaign':
        result['statistics'] = summarise(traces)
    return result


def report(a):
    if a['mode'] == 'smoke':
        return '# Four-worker compatibility smoke\n\nAccepted: four complete histories match the accepted pilot; source-proximal checks and actual four-worker CPU/time overlap pass. No held-out world has been used.\n'
    stats = a['statistics']; p = stats['primaryContrast']
    rows = [r for r in stats['groups'] if r['k'] == 5]
    lookup = {(r['wind'], r['speed'], r['sensor'], r['rateKgPerSecond']): r for r in rows}
    lines = ['# Held-out outdoor detectability study', '',
        'All 544 histories, 16 resolution triplets, sensor/decision replays and provenance gates passed.',
        '**128 independent paired worlds per setting; 36864 primary outcomes are not independent replicates.**', '',
        '## Prespecified fast-minus-slow sensor contrast', '',
        'Noise SD 0.2 ppm, wind 0.5 m/s, speed 1 m/s, release 0.1 g/s, k=5; rise tau 0.5 vs 5 s.', '',
        f'- Alarm-fraction difference: {100*p["alarmFractionDifference"]:.3f} percentage points; nominal adjusted interval {np.array(p["alarmFractionInterval975"])*100} pp.',
        f'- Restricted mean time difference: {p["restrictedMeanTimeDifferenceSeconds"]:.3f} s; interval {p["restrictedTimeInterval975"]} s (nondetections assigned 600 s).',
        f'- Paired counts: fast only {p["fastOnly"]}; slow only {p["slowOnly"]}; both {p["both"]}; neither {p["neither"]}.',
        '- Intervals use 10000 paired resamples and nominal Bonferroni allocation for two endpoints. Coverage is approximate; a degenerate interval is not proof of equivalence.', '',
        '## All primary-threshold settings', '',
        'Entries are alarms /128 independent worlds. Release-rate columns are g/s; blank is no release.', '',
        '| Generic sensor (noise SD ppm; rise tau s) | Wind m/s | Speed m/s | Blank | 0.01 g/s | 0.1 g/s | 1 g/s |',
        '|---|---:|---:|---:|---:|---:|---:|']
    for wind in [.5, 2]:
        for speed in [.5, 1]:
            for noise in [.02, .2, 2]:
                for tau in [.5, 5]:
                    sensor = f'generic-sigma{noise:g}-tau{tau:g}'
                    counts = [lookup[wind, speed, sensor, q]['alarms'] for q in [0, 1e-5, 1e-4, 1e-3]]
                    lines.append(f'| {noise:g}; {tau:g} | {wind:g} | {speed:g} | ' + ' | '.join(f'{n}/128' for n in counts) + ' |')
    lines += ['', '## Interpretation boundary', '',
        'All settings, Wilson pointwise intervals, k=3/7 sensitivity results and matched-blank counts are in `audit.json`. Tested-grid target flags are pointwise only, not simultaneous certification or a universal minimum detectable emission rate.',
        'This study uses a prescribed route, abstract sensors and constant-coefficient open-field transport. It does not rank adaptive GSL algorithms or validate commercial products, urban wakes, UAV downwash, soil coupling or buried-defect localisation.',
        'Source/background/noise worlds are paired across conditions. Identical blank variants must not be pooled to inflate sample size. Detection is not source localisation, and nondetection is not proof of no leak.', '',
        f'Execution: {a["executionSeconds"]:.1f} s on four local workers. Independent audit: {a["auditSeconds"]:.1f} s. No AWS run. All 141 Stage 2i scientific files remain unchanged.']
    return '\n'.join(lines)+'\n'


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--input', type=Path, required=True)
    args = parser.parse_args(); root = args.input
    require(not (root/'audit.json').exists(), 'Audit already exists')
    start = time.perf_counter()
    try:
        result = audit(root)
    except Exception as error:
        with (root/'audit.failed.json').open('x') as f:
            json.dump(dict(accepted=False, diagnosticOnly=True, error=str(error)), f, indent=2)
        raise
    result['auditSeconds'] = time.perf_counter()-start
    with (root/'audit.json').open('x') as f:
        json.dump(result, f, indent=2, allow_nan=False); f.write('\n')
    with (root/'report.md').open('x') as f:
        f.write(report(result))
    with (root/'closure.json').open('x') as f:
        json.dump(dict(accepted=True, mode=result['mode'], manifestSha256=sha(root/'manifest.json'),
                       auditSha256=sha(root/'audit.json'), reportSha256=sha(root/'report.md'),
                       physicalValidation=False, awsLaunched=False), f, indent=2)
    print(json.dumps({k: v for k, v in result.items() if k not in ['checks', 'statistics', 'resolutionTriplets']}))


if __name__ == '__main__':
    main()
