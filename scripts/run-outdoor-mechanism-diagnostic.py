#!/usr/bin/env python3
"""Replay only: no new transport simulations or cloud interfaces."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import platform
import shutil
import time
from lib.outdoor_mechanism import derive, summarise, refinement, STAGES

INPUT = Path('research/results/outdoor_holdout_campaign_v1_2026-09-22')
PINS = dict(manifest='4b26f5e096d1a1e88e75fb9164b3a24a737ddda069832c366108d66e26158b9a',
            audit='d7893718edf257496a9b12d0c140a72c27d5b775729bdab8029de6874d2406b1',
            report='c93253e10202b67207654235bc2ea00c94cd1cc7020ff65113c6e48e4d039f6f')
SOURCES = ['scripts/lib/outdoor_mechanism.py', 'scripts/run-outdoor-mechanism-diagnostic.py',
           'scripts/audit-outdoor-mechanism.mjs', 'scripts/test-outdoor-mechanism.py',
           'research/protocols/outdoor_mechanism_diagnostic_v1_2026-09-22.md']


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def read(file):
    return json.loads(Path(file).read_text())


def require(test, why):
    if not test:
        raise ValueError(why)


def inputs():
    closure = read(INPUT/'closure.json'); manifest = read(INPUT/'manifest.json')
    require(closure['accepted'] and read(INPUT/'audit.json')['accepted'], 'Input not accepted')
    for key, expected in PINS.items():
        path = INPUT/('report.md' if key == 'report' else f'{key}.json')
        require(sha(path) == expected == closure[key+'Sha256'], 'Accepted input changed: '+key)
    receipt = read(INPUT/'execution-complete.json')
    require(sha(INPUT/'execution-complete.json') == read(INPUT/'audit.json')['executionReceiptSha256'], 'Receipt changed')
    require(len(manifest['specs']) == len(receipt['files']) == 544, 'Input inventory')
    for item in manifest['sourceHashes']:
        require(sha(item['file']) == item['sha256'] == sha(INPUT/'source-snapshot'/item['file']), 'Campaign source changed')
    frozen = manifest['pilot']['manifest']['frozenStage2i']
    require(len(frozen['hashes']) == 141 and sha(frozen['bundle']) == frozen['bundleSha256'], 'Stage2i inventory changed')
    for item in frozen['hashes']:
        require(sha(item['file']) == item['sha256'], 'Stage2i source changed')
    for i, item in enumerate(receipt['files']):
        require(item['index'] == i and item['file'] == f'trace-{i:03d}.json.gz', 'Receipt order')
        require(sha(INPUT/item['file']) == item['sha256'], 'Raw history changed')
    return manifest, receipt


def report(result):
    groups = result['groups']
    selected = [r for r in groups if r['wind'] == .5 and r['rateKgPerSecond'] == 1e-4 and r['k'] == 5
                and r['sensor'].startswith('generic-sigma0.2-')]
    lines = ['# Post-hoc outdoor measurement-chain diagnostic', '',
        '**Same 128 paired worlds; exploratory reanalysis, not new independent validation.**',
        'Read `closure.json` for independent replay acceptance. No new transport run or AWS action.', '',
        '## Primary setting and descriptive speed contrast', '',
        'Wind 0.5 m/s, release 0.1 g/s, noise SD 0.2 ppm, k=5 (1 ppm excess).',
        'Counts are positive worlds /128. Instantaneous stages are idealised truth-informed counterfactuals.', '',
        '| Speed m/s | Rise tau s | Midpoint exposure | Ideal 1 sample | Ideal 3 samples | Delay only | Response, fixed background | Response, actual background | Observed | Misses without / with midpoint exposure |',
        '|---|---|---|---|---|---|---|---|---|---|']
    for row in selected:
        values = [row['stages'][s]['positive'] for s in STAGES[:-1]]
        lines.append(f'| {row["speed"]:g} | {row["sensor"].split("tau")[1]} | '+
            ' | '.join(str(n) for n in values)+f' | {row["missesWithoutMidpointOpportunity"]} / {row["missesWithMidpointOpportunity"]} |')
    lines += ['', '## Paired transitions at speed 1 m/s', '',
        'Left-only is lost; right-only is added in that particular counterfactual. Effects are not assumed nested.', '',
        '| Rise tau s | Transition | Both | Left only | Right only | Neither |',
        '|---|---|---|---|---|---|']
    for row in selected:
        if row['speed'] != 1:
            continue
        for t in row['transitions']:
            lines.append(f'| {row["sensor"].split("tau")[1]} | {t["left"]} → {t["right"]} | '+
                         ' | '.join(str(t[c]['count']) for c in ['both', 'leftOnly', 'rightOnly', 'neither'])+' |')
    lines += ['', '## Complete evidence and limitations', '',
        '- `diagnostics.json.gz` contains all 39168 per-world records, including the refinement histories.',
        '- `summary.json` contains all 288 primary setting summaries, world-level transition membership and all refinement differences. Duplicate blank variants are not pooled.',
        '- Counterfactuals preserve the original threshold; zero noise does not lower kσ. Background-removal is a diagnostic, not a deployable background estimator.',
        '- Exposure is relative to the threshold and the saved substep grid. Failure to cross it is not evidence of literally zero gas, nor proof that route coverage alone caused a miss.',
        '- The 600 s routes cover 295 m (0.5 m/s) or 580 m (1 m/s) of 990 m. They do not complete the prescribed survey. Geometry alone cannot predict longer-mission detection.',
        '- Full-route motion would require 2016 s or 1026 s, respectively, including 18 two-second turns. Those longer missions have not been simulated here.',
        '- No new algorithm ranking, universal minimum rate, commercial-sensor validation, urban/UAV/soil-to-air validation or physical certification follows.', '',
        '## Existing refinement witnesses', '']
    for r in result['refinement']:
        lines.append(f'- Resolution {r["lowResolution"]} → {r["highResolution"]}: {len(r["decisionChanges"])} binary stage changes; '+
            f'{len(r["restrictedTimeChanges"])} restricted-time changes; maximum absolute time change {r["maxRestrictedTimeDifferenceSeconds"]:g} s across 1152 paired setting-world records.')
    lines += ['', 'Any finite-grid ideal-stage differences are disclosed, not hidden or converted into new independent worlds.', '',
        '## Next work', '',
        'Use these post-hoc findings to freeze a fresh-world mission-budget/equal-route contrast before running it. Keep speed, exposure duration and coverage distinctions explicit. Do not tune and re-test on these 128 worlds. Closed-loop GSL comparisons still require source-blind, SI-scale, measurement-parity and timing admissions.']
    return '\n'.join(lines)+'\n'


def dump(file, value):
    with file.open('x') as out:
        json.dump(value, out, indent=2, allow_nan=False); out.write('\n')


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(); out = args.output
    require(not out.exists(), 'Output exists; use a new directory')
    start = time.perf_counter(); manifest, complete = inputs()
    source_hashes = [dict(file=p, sha256=sha(p)) for p in SOURCES]
    out.mkdir(parents=True)
    for p in SOURCES:
        dest = out/'source-snapshot'/p; dest.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(p, dest)
    dump(out/'manifest.json', dict(schemaVersion='outdoor-mechanism-posthoc-v1', createdAt=datetime.now(timezone.utc).isoformat(),
        inputDirectory=str(INPUT.resolve()), inputPins=PINS, inputClosureSha256=sha(INPUT/'closure.json'),
        inputExecutionSha256=sha(INPUT/'execution-complete.json'), sourceHashes=source_hashes,
        python=platform.python_version(), postHoc=True, newIndependentWorlds=0,
        newTransportSimulations=0, awsLaunched=False, paidLaunchAuthorized=False))
    rows, max_error = [], 0.
    for i, (receipt, spec) in enumerate(zip(complete['files'], manifest['specs'])):
        trace = json.loads(gzip.decompress((INPUT/receipt['file']).read_bytes()))
        require(trace['spec'] == spec, 'Trace specification mismatch')
        derived, error = derive(trace, i); rows.extend(derived); max_error = max(max_error, error)
        if (i+1) % 64 == 0:
            print(f'replayed {i+1}/544 accepted histories', flush=True)
    require(len(rows) == 39168, 'Derived outcome inventory')
    result = dict(schemaVersion='outdoor-mechanism-summary-v1', postHoc=True, independentlyAccepted=False,
        newIndependentWorlds=0, independentWorldsPerSetting=128, rawHistories=544,
        primaryHistories=512, primaryRecords=36864, allRecords=len(rows),
        originalScientificFilesUnchanged=141, campaignSourcesUnchanged=len(manifest['sourceHashes']),
        maxObservedReadingReplayErrorPpm=max_error, groups=summarise(rows), refinement=refinement(rows))
    inputs()  # Guard original sources and histories again after computation.
    require(all(sha(r['file']) == r['sha256'] for r in source_hashes), 'Diagnostic code changed during replay')
    result['seconds'] = time.perf_counter()-start
    with (out/'diagnostics.json.gz').open('xb') as f:
        f.write(gzip.compress(json.dumps(rows, separators=(',', ':'), allow_nan=False).encode(), mtime=0))
    dump(out/'summary.json', result)
    with (out/'report.md').open('x') as f:
        f.write(report(result))
    print(json.dumps({k: v for k, v in result.items() if k not in ['groups', 'refinement']}))


if __name__ == '__main__':
    main()
