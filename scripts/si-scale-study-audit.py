"""Independent arithmetic, archive and selected field checks for SI development runs.

Usage: python scripts/si-scale-study-audit.py [study-directory] [output-directory]
No performance gate or physical validation is inferred from this audit.
"""
import gzip
import hashlib
import json
import math
import sys
from pathlib import Path

from m54_source_reference import Release, pulse

ROOT = Path(__file__).resolve().parents[1]
STUDY = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'research/evidence/si_scale_study_2026-09-14_v2'
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'research/evidence/si_scale_implementation_2026-09-14'
OUT.mkdir(parents=True, exist_ok=True)


def read(path):
    return json.loads(path.read_bytes())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def close(a, b, rel=1e-10, absolute=1e-12):
    assert math.isclose(a, b, rel_tol=rel, abs_tol=absolute), (a, b)


complete, manifest = read(STUDY / 'complete.json'), read(STUDY / 'manifest.json')
assert complete['complete'] and complete['cases'] == 30
for entry in complete['inventory']:
    assert sha(STUDY / entry['file']) == entry['sha256'], entry['file']
for entry in manifest['sources']:
    assert sha(STUDY / 'source-snapshot' / entry['file']) == entry['sha256'], entry['file']
summary = read(STUDY / 'summary.json')['rows']
runs = [json.loads(gzip.decompress((STUDY / f'run-{i}.json.gz').read_bytes())) for i in range(30)]
counts = {'ticks': 0, 'valid_readouts': 0, 'retained_readouts': 0, 'clipped_valid_readouts': 0}
for i, r in enumerate(runs):
    c, s, row = r['config'], r['spec'], r['row']
    p, a = c['localInletSampling'], c['physicalAtmosphere']
    assert row == summary[i] and c == manifest['configurations'][i]['config']
    assert len(r['trace']) == round(c['durationSeconds'] / c['fixedDt'])
    assert len(r['results']) == 1 and len(r['results'][0]['visits']) == 9
    close(c['robotSpeed'] * c['domainMeters'], s['speed'])
    close(p['effectiveDiffusivityMetresSquaredPerSecond'], a['diffusivityMetresSquaredPerSecond'])
    close(c['sensorSaturation'], a['measurement']['saturationKgPerCubicMetre'] / a['measurement']['concentrationScaleKgPerCubicMetre'])
    retained_times = {x['time'] for v in r['results'][0]['visits'] for x in v['samples']}
    retained = [x for x in r['samples'] if x['time'] in retained_times]
    moving = [x for x in r['samples'] if x['phase'] == 'LOCAL HOTSPOT PROBE MOVE']
    trace_by_time = {x['time']: x for x in r['trace']}
    for x in r['samples']:
        assert trace_by_time[x['time']]['measurement']['valid']
        close(x['error'], x['measured'] - x['meanInlet'])
        assert math.isfinite(x['meanInlet']) and x['meanInlet'] >= 0
        assert len(x['inletReadings']) == 4
        assert x['saturated'] == any(ch['saturated'] for ch in x['inletReadings'])
        close(x['measured'], sum(ch['concentration'] for ch in x['inletReadings']) / 4)
    for subset, key in [(retained, 'retainedInstantaneousMismatchRmse'), (moving, 'movingInstantaneousMismatchRmse')]:
        close(row[key], math.sqrt(sum(x['error'] ** 2 for x in subset) / len(subset)))
    assert row['retainedSamples'] == len(retained)
    assert row['saturatedValidReadouts'] == sum(x['saturated'] for x in r['samples'])
    assert row['retainedReadoutsWithClippedInlet'] == sum(x['saturated'] for x in retained)
    assert row['fullySaturatedMeanReadouts'] == sum(x['meanSaturated'] for x in r['samples'])
    delay = math.pi * p['tubeInnerDiameterMetres'] ** 2 / 4 * p['tubeLengthMetres'] / (p['flowLitresPerMinutePerChannel'] * 1e-3 / 60)
    memory = delay + p['recoveryTimeConstantSeconds'] + p['averagingSeconds'] / 2
    g = row['scales']['groups']
    close(row['scales']['quantities']['tubeDelaySeconds'], delay)
    close(g['peclet'], s['wind'] * s['width'] / a['diffusivityMetresSquaredPerSecond'])
    close(g['motionMemoryRecovery'], s['speed'] * memory / s['width'])
    close(g['headToFeature'], p['opposingInletSpacingMetres'] / s['width'])
    close(g['sourceStrength'], a['emissionRateKgPerSecond'] / (a['measurement']['concentrationScaleKgPerCubicMetre'] * s['wind'] * s['width'] ** 2))
    close(row['inspectionSpeedCapMetresPerSecond'], .46 * s['speed'])
    counts['ticks'] += len(r['trace'])
    counts['valid_readouts'] += len(r['samples'])
    counts['retained_readouts'] += len(retained)
    counts['clipped_valid_readouts'] += row['saturatedValidReadouts']

# Telemetry-only rerun: all original policy/readout histories and truth unchanged.
old = STUDY.parent / 'si_scale_study_2026-09-14'
unchanged = []
if old.exists():
    for i, r in enumerate(runs):
        previous = json.loads(gzip.decompress((old / f'run-{i}.json.gz').read_bytes()))
        reduced = json.loads(json.dumps(r['trace']))
        for tick in reduced:
            tick['measurement'].pop('localInletReadings', None)
        assert reduced == previous['trace'], i
        assert r['results'] == previous['results'], i
        for x, y in zip(r['samples'], previous['samples'], strict=True):
            for key in ['time', 'meanInlet', 'measured', 'phase', 'error']:
                assert x[key] == y[key], (i, key)
        unchanged.append(i)

# Same local SI geometry in three coordinate domains; no site-search claim.
domain_checks = []
for i in [28, 29]:
    max_signal = max(abs(a['measurement']['concentration'] - b['measurement']['concentration']) for a, b in zip(runs[0]['trace'], runs[i]['trace'], strict=True))
    max_position = max(abs((a['position'][axis] - .5) * 100 - (b['position'][axis] - .5) * runs[i]['spec']['domain']) for a, b in zip(runs[0]['trace'], runs[i]['trace'], strict=True) for axis in ['x', 'y'])
    assert max_signal < 1e-10 and max_position < 1e-10
    assert runs[i]['row']['status'] == runs[0]['row']['status']
    domain_checks.append({'domainMetres': runs[i]['spec']['domain'], 'maxNormalizedConcentrationDifference': max_signal, 'maxLocalPositionDifferenceMetres': max_position})


def midpoint_mean(run, tick, panels):
    """Independent Python pulse reference, split exactly at emission switches."""
    a, c = run['config']['physicalAtmosphere'], run['config']
    t = tick['time'] + a['sourceAgeAtMissionStartSeconds']
    L = c['domainMeters']
    release = Release(diffusivity=a['diffusivityMetresSquaredPerSecond'], wind=(run['spec']['wind'], 0),
                      source=(L * .5, L * .5, a['releaseHeightMetres']), sigma=a['sourceWidthMetres'])
    edges = [0, t]
    if 'pulse' in a:
        half, phase = a['pulse']['periodSeconds'] / 2, a['pulse']['phaseSeconds']
        edges += [k * half - phase for k in range(math.floor(phase / half), math.ceil((t + phase) / half) + 1) if 0 < k * half - phase < t]
    edges.sort()
    points = [(L * (tick['position']['x'] + ch['effectiveOffset']['x']), L * (tick['position']['y'] + ch['effectiveOffset']['y']), c['localInletSampling']['inletHeightMetres']) for ch in tick['measurement']['localInletReadings']]
    value = 0
    for lo, hi in zip(edges, edges[1:]):
        if 'pulse' in a and ((lo + hi) / 2 + phase) % (2 * half) >= half:
            continue
        n = max(1, math.ceil((hi - lo) / t * panels))
        dt = (hi - lo) / n
        value += dt * sum(pulse(point, t - lo - (j + .5) * dt, release=release) for j in range(n) for point in points) / 4
    m = a['measurement']
    return (value * a['emissionRateKgPerSecond'] + m['backgroundKgPerCubicMetre']) / m['concentrationScaleKgPerCubicMetre']


field_checks = []
for i in [0, 2, 4, 12, 14, 16]:
    r = runs[i]
    time = r['results'][0]['visits'][0]['samples'][-1]['time']
    tick = next(x for x in r['trace'] if x['time'] == time)
    expected = next(x['meanInlet'] for x in r['samples'] if x['time'] == time)
    coarse, fine = midpoint_mean(r, tick, 32768), midpoint_mean(r, tick, 65536)
    refinement, error = abs(fine - coarse) / fine, abs(expected - fine) / fine
    assert refinement < 1e-5 and error < 1e-4, (i, refinement, error)
    field_checks.append({'index': i, 'id': r['spec']['id'], 'timeSeconds': time,
                         'pythonRefinedMean': fine, 'engineMean': expected,
                         'pythonRefinementRelativeChange': refinement, 'engineRelativeDifference': error})

report = {'auditVersion': 'si-scale-audit-v1', 'study': str(STUDY), 'studyCompletionSha256': sha(STUDY / 'complete.json'),
          'auditScriptSha256': sha(Path(__file__)), 'pythonReferenceSha256': sha(ROOT / 'scripts/m54_source_reference.py'),
          'archiveFilesChecked': len(complete['inventory']), 'frozenSourceFilesChecked': len(manifest['sources']),
          'counts': counts, 'telemetryOnlyIdenticalCases': unchanged, 'domainChecks': domain_checks,
          'selectedFieldChecks': field_checks, 'passed': True,
          'limits': 'Selected pointwise quadrature checks and local coordinate invariance; not full trajectory convergence, hardware calibration, physical validation or search performance.'}
(OUT / 'audit.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
