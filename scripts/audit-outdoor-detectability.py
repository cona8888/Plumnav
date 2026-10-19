#!/usr/bin/env python3
"""Independent numerical/measurement audit; never imports the TS implementation."""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import time
import numpy as np
from scipy.integrate import quad

VERSION = 'outdoor-detectability-pilot-v2'
EXPECTED_DESIGN = dict(version=VERSION, domainMetres=100, durationSeconds=600,
    sourceAgeSeconds=600, diffusivity=.2, sourceSigmaMetres=.25,
    releaseHeightMetres=.025, inletHeightMetres=.05, temperatureKelvin=298.15,
    pressurePascal=101325, backgroundPpm=2, referenceRateKgPerSecond=1e-5,
    ratesKgPerSecond=[0, 1e-5, 1e-4, 1e-3], windSpeeds=[.5, 2], robotSpeeds=[.5, 1],
    thresholdMultipliers=[3, 5, 7], primaryThresholdMultiplier=5, consecutiveSamples=3,
    turnSeconds=2, pilotWorlds=[0, 1, 2, 3], reservedTestWorldRange=[1000, 1127],
    seedBase=927001, backgroundOffsetBoundPpm=.05, backgroundDriftBoundPpm=.05,
    resolutions=[dict(dt=.25, panel=.25), dict(dt=.125, panel=.125), dict(dt=.0625, panel=.0625)])


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def stream(seed):
    # Independent unsigned implementation of the recorded Mulberry32 stream.
    mask = (1 << 32) - 1
    while True:
        seed = (seed + 0x6d2b79f5) & mask
        t = ((seed ^ (seed >> 15)) * (seed | 1)) & mask
        t = (t ^ ((t + ((t ^ (t >> 7)) * (t | 61))) & mask)) & mask
        yield (((t ^ (t >> 14)) & mask) + .5) / 4294967296


def expected_world(world):
    seed = 927001 + 17 * world
    r = stream(seed)
    return dict(world=world, seed=seed, source=dict(x=10 + 80 * next(r), y=10 + 80 * next(r), z=.025),
                backgroundOffsetPpm=(2 * next(r) - 1) * .05,
                backgroundDriftPpm=(2 * next(r) - 1) * .05)


def expected_noise(world, n):
    r = stream(1927001 + world * 17)
    return np.array([math.sqrt(-2 * math.log(next(r))) * math.cos(2 * math.pi * next(r)) for _ in range(n)])


def models():
    return [dict(id=f'generic-sigma{sigma:g}-tau{tau:g}', evidence='hypothetical-factorial-not-product-calibrated',
                 noisePpm=sigma, riseSeconds=tau, recoverySeconds=2*tau, delaySeconds=1,
                 sampleSeconds=1, saturationPpm=10000) for sigma in [.02, .2, 2] for tau in [.5, 5]]


def expected_specs():
    return [dict(world=w, wind=u, speed=v, resolution=r) for w in range(4)
            for u in [.5, 2] for v in [.5, 1] for r in ([0, 1, 2] if w == 0 else [0])]


def route_at(times, speed):
    points = []
    for i in range(10):
        for x in ([95, 5] if i % 2 else [5, 95]):
            points.append(np.array([x, 5 + 10*i, .05], dtype=float))
    result = np.tile(points[-1], (len(times), 1))
    distance = np.full(len(times), 990.)
    clock = travelled = 0.
    for i, (a, b) in enumerate(zip(points, points[1:])):
        length = np.linalg.norm(b - a)
        duration = length / speed
        moving = (times >= clock) & (times <= clock + duration)
        fraction = (times[moving] - clock) / duration
        result[moving] = a + fraction[:, None] * (b - a)
        distance[moving] = travelled + fraction * length
        clock += duration
        travelled += length
        if i < len(points) - 2:
            turning = (times >= clock) & (times <= clock + 2)
            result[turning] = b
            distance[turning] = travelled
            clock += 2
    return result, distance


def replay(inlet, dt, sensor, noise, initial=2.):
    every = sensor['sampleSeconds'] / dt
    delay = sensor['delaySeconds'] / dt
    require(every.is_integer() and delay.is_integer(), 'Nonintegral sensor clock')
    every, delay = int(every), int(delay)
    require(len(inlet) % every == 0 and len(noise) == len(inlet) // every, 'Input clock length')
    output = []
    state = initial
    for i in range(len(inlet)):
        value = initial if i < delay else inlet[i-delay]
        tau = sensor['riseSeconds'] if value >= state else sensor['recoverySeconds']
        state = value + (state-value) * math.exp(-dt/tau)
        if (i+1) % every == 0:
            output.append(min(sensor['saturationPpm'], max(0., state + sensor['noisePpm'] * noise[len(output)])))
    return np.asarray(output)


def alarm(values, threshold, consecutive=3):
    hit = np.asarray(values) > threshold
    if len(hit) < consecutive:
        return None
    candidates = np.flatnonzero(np.convolve(hit.astype(int), np.ones(consecutive, dtype=int), 'valid') == consecutive)
    return int(candidates[0]) + consecutive if len(candidates) else None


def wilson(successes, n):
    require(isinstance(n, int) and n > 0 and isinstance(successes, int) and 0 <= successes <= n, 'Invalid binomial counts')
    z = 1.959963984540054
    p, denominator = successes/n, 1 + z*z/n
    middle = (p + z*z/(2*n))/denominator
    half = z * math.sqrt(p*(1-p)/n + z*z/(4*n*n))/denominator
    return [max(0., middle-half), min(1., middle+half)]


def independent_concentration(row, field, age):
    source = field['source']
    x, y, z = row['x']-source['x'], row['y']-source['y'], row['z']
    u = field['wind']['x']

    def integrand(a):
        var = field['sigma']**2 + 2*field['diffusivity']*a
        h = math.exp(-((x-u*a)**2 + y*y)/(2*var))
        vertical = math.exp(-(z-source['z'])**2/(2*var)) + math.exp(-(z+source['z'])**2/(2*var))
        return field['rateKgPerSecond'] * h * vertical / (2*math.pi*var)**1.5

    centre = max(0., min(age, x/u))
    width = math.sqrt(field['sigma']**2 + 2*field['diffusivity']*centre)/u
    points = sorted({p for k in [-8, -4, -2, -1, 0, 1, 2, 4, 8] if 0 < (p := centre+k*width) < age})
    value, error = quad(integrand, 0, age, points=points, epsabs=1e-15, epsrel=1e-9, limit=250)
    require(error <= max(1e-13, abs(value)*1e-6), 'Independent quadrature uncertainty too high')
    factor = 1e6 * 8.314462618 * 298.15 / (101325*.01604)
    return value * factor


def check_trace(trace, spec):
    require(trace['schemaVersion'] == VERSION and trace['spec'] == spec, 'Trace identity')
    w = expected_world(spec['world'])
    require(trace['world'] == w, 'World/seed mismatch')
    resolution = EXPECTED_DESIGN['resolutions'][spec['resolution']]
    require(trace['resolution'] == resolution, 'Resolution mismatch')
    dt = resolution['dt']
    field = dict(source=w['source'], wind=dict(x=spec['wind'], y=0), diffusivity=.2, sigma=.25,
                 rateKgPerSecond=1e-5, panelSeconds=resolution['panel'])
    require(trace['fieldSettings'] == field, 'Field mismatch')
    require(abs(trace['ppmPerKgM3'] - 1e6*8.314462618*298.15/(101325*.01604)) < 1e-8, 'PPM conversion')
    rows = trace['inlet']
    require(len(rows) == round(600/dt), 'Inlet row count')
    values = np.array([[r[k] for k in ['t', 'x', 'y', 'z', 'referenceExcessPpm', 'backgroundPpm']] for r in rows])
    require(np.isfinite(values).all() and (values[:, 4:] >= 0).all(), 'Nonfinite/negative field')
    times = (np.arange(len(rows)) + .5)*dt
    np.testing.assert_array_equal(values[:, 0], times)
    positions, _ = route_at(times, spec['speed'])
    np.testing.assert_allclose(values[:, 1:4], positions, atol=1e-12, rtol=0)
    _, distance = route_at(np.array([600.]), spec['speed'])
    require(trace['distanceMetres'] == distance[0] and trace['routeLengthMetres'] == 990, 'Route distance')
    background = 2 + w['backgroundOffsetPpm'] + w['backgroundDriftPpm'] * times / 600
    np.testing.assert_allclose(values[:, 5], background, atol=1e-14, rtol=0)
    noise = expected_noise(spec['world'], 600)
    np.testing.assert_allclose(trace['noise'], noise, atol=1e-13, rtol=1e-13)
    # Inspect the strongest point, its neighbours and three fixed temporal points.
    peak = int(np.argmax(values[:, 4]))
    indices = sorted({0, len(rows)//2, len(rows)-1, peak, max(0, peak-1), min(len(rows)-1, peak+1)})
    errors = []
    for index in indices:
        r = rows[index]
        reference = independent_concentration(r, field, 600+r['t'])
        error = abs(reference-r['referenceExcessPpm'])
        require(error <= 1e-6 + .001*abs(reference), f'Independent field mismatch at {index}: {error}')
        errors.append(error)
    expected_rows = [(q, s) for q in [0, 1e-5, 1e-4, 1e-3] for s in models()]
    require(len(trace['measurements']) == len(expected_rows), 'Measurement count')
    for measurement, (rate, sensor) in zip(trace['measurements'], expected_rows):
        require(measurement['sensor'] == sensor and measurement['rateKgPerSecond'] == rate, 'Sensor/rate order')
        inlet = background + values[:, 4] * rate/1e-5
        computed = replay(inlet, dt, sensor, noise)
        np.testing.assert_allclose(measurement['readings'], computed, atol=2e-10, rtol=2e-12)
        outcomes = []
        for k in [3, 5, 7]:
            at = alarm(computed, 2 + k*sensor['noisePpm'])
            outcomes.append(dict(k=k, alarmSeconds=at, restrictedTimeSeconds=600 if at is None else at))
        require(measurement['outcomes'] == outcomes, 'Independent alarm mismatch')
    return dict(spec=spec, passed=True, independentFieldPoints=len(indices), maxFieldErrorPpm=max(errors))


def resolution_check(traces):
    outcomes = []
    for wind in [.5, 2]:
        for speed in [.5, 1]:
            triple = [next(t for t in traces if t['spec'] == dict(world=0, wind=wind, speed=speed, resolution=r)) for r in range(3)]
            worst_ratio = 0.
            for coarse, fine, finest in zip(*(t['measurements'] for t in triple)):
                a, b, c = (np.array(x['readings']) for x in [coarse, fine, finest])
                tolerance = max(.005*np.max(np.abs(c-2)), .01*finest['sensor']['noisePpm'])
                error = float(np.max(np.abs(b-c)))
                require(error <= tolerance, f'Sensor convergence {wind}/{speed}: {error} > {tolerance}')
                worst_ratio = max(worst_ratio, error/tolerance)
                for x, y in zip(fine['outcomes'], finest['outcomes']):
                    tx, ty = x['alarmSeconds'], y['alarmSeconds']
                    require((tx is None) == (ty is None), 'Alarm classification changed under refinement')
                    require(tx is None or abs(tx-ty) <= 1, 'Alarm time refinement exceeds one output sample')
                # Primary output must itself agree in decisions with the finest trace.
                for x, y in zip(coarse['outcomes'], finest['outcomes']):
                    tx, ty = x['alarmSeconds'], y['alarmSeconds']
                    require((tx is None) == (ty is None), 'Primary alarm classification not resolved')
                    require(tx is None or abs(tx-ty) <= 1, 'Primary alarm time not resolved')
            outcomes.append(dict(wind=wind, speed=speed, passed=True, worstFineErrorToTolerance=worst_ratio))
    return outcomes


def summarize(traces):
    groups = defaultdict(list)
    for trace in traces:
        spec = trace['spec']
        if spec['resolution'] != 0:
            continue
        for m in trace['measurements']:
            for o in m['outcomes']:
                key = (spec['wind'], spec['speed'], m['sensor']['id'], m['rateKgPerSecond'], o['k'])
                groups[key].append((spec['world'], o['alarmSeconds'], o['restrictedTimeSeconds']))
    output = []
    for (wind, speed, sensor, rate, k), rows in sorted(groups.items()):
        require(sorted(x[0] for x in rows) == [0, 1, 2, 3], 'Not four independent pilot worlds per setting')
        hits = sum(x[1] is not None for x in rows)
        output.append(dict(windMetresPerSecond=wind, speedMetresPerSecond=speed, sensor=sensor,
            rateKgPerSecond=rate, rateKgPerHour=rate*3600, k=k, n=4, alarms=hits,
            metric='false-alarm-per-survey' if rate == 0 else 'probability-of-detection',
            estimate=hits/4, wilson95=wilson(hits, 4),
            restrictedMeanTimeSeconds=sum(x[2] for x in rows)/4,
            envelopeQualified=False, developmentOnly=True))
    return output


def audit(root):
    manifest, complete = read(root/'manifest.json'), read(root/'execution-complete.json')
    require(not (root/'failure.json').exists(), 'Failed execution')
    require(manifest['schemaVersion'] == VERSION and manifest['mode'] == 'development-pilot' and manifest['campaignEnabled'] is False, 'Mode')
    require(manifest['design'] == EXPECTED_DESIGN and manifest['sensors'] == models() and manifest['specs'] == expected_specs(), 'Prospective design changed')
    require(complete['executionComplete'] is True and complete['independentlyAccepted'] is False, 'Completion semantics')
    require(complete['manifestSha256'] == sha(root/'manifest.json'), 'Manifest hash')
    for record in manifest['sourceHashes']:
        require(sha(root/'source-snapshot'/record['file']) == record['sha256'], 'Snapshot hash')
        require(sha(record['file']) == record['sha256'], 'Live source changed; run the frozen checker or version the pilot')
    frozen = manifest['frozenStage2i']
    require(sha(frozen['bundle']) == frozen['bundleSha256'] and len(frozen['hashes']) == 141, 'Stage2i inventory')
    require(all(sha(row['file']) == row['sha256'] for row in frozen['hashes']), 'Stage2i source changed')
    require(len(complete['files']) == 24, 'File count')
    require(sorted(p.name for p in root.glob('trace-*.json.gz')) == [r['file'] for r in complete['files']], 'Unexpected/missing histories')
    traces, checks = [], []
    for index, (record, spec) in enumerate(zip(complete['files'], expected_specs())):
        require(record['file'] == f'trace-{index:03d}.json.gz', 'Trace filename/order')
        file = root/record['file']
        require(sha(file) == record['sha256'] and file.stat().st_size == record['bytes'], 'Output hash')
        require(read(root/f'trace-{index:03d}.receipt.json') == record, 'Receipt mismatch')
        trace = json.loads(gzip.decompress(file.read_bytes()))
        checks.append(check_trace(trace, spec)); traces.append(trace)
        print(f'audited {index+1}/24', flush=True)
    for world in range(4):
        for speed in [.5, 1]:
            pair = [next(t for t in traces if t['spec'] == dict(world=world, wind=w, speed=speed, resolution=0)) for w in [.5, 2]]
            for a, b in zip(*(t['measurements'][:6] for t in pair)):
                require(a == b, 'Blank depends on wind/source field')
    triples = resolution_check(traces)
    primary_seconds = sum(r['seconds'] for r, s in zip(complete['files'], expected_specs()) if s['resolution'] == 0)
    return dict(schemaVersion='outdoor-detectability-audit-v1', accepted=True, developmentOnly=True,
        checkedAt=datetime.now(timezone.utc).isoformat(), manifestSha256=sha(root/'manifest.json'),
        executionReceiptSha256=sha(root/'execution-complete.json'), rawHistories=24,
        primaryHistories=16, primaryOutcomes=1152, independentWorldsPerSetting=4,
        originalScientificFilesUnchanged=141, resolutionTriplets=triples, checks=checks,
        executionSeconds=complete['seconds'], primaryExecutionSeconds=primary_seconds,
        projected128WorldPrimarySeconds=primary_seconds*32,
        projectionBoundary='Serial estimate only; excludes campaign witnesses, packaging, transfer and independent audit.',
        minimumDetectableEmissionRate=None, commercialSensorValidation=False, groups=summarize(traces))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.exists(), 'Audit output already exists')
    start = time.perf_counter()
    try:
        result = audit(args.input)
    except Exception as error:
        failure = args.output.with_suffix('.failed.json')
        with failure.open('x') as f:
            json.dump(dict(accepted=False, diagnosticOnly=True, error=str(error)), f, indent=2)
        raise
    result['auditSeconds'] = time.perf_counter()-start
    with args.output.open('x') as f:
        json.dump(result, f, indent=2, allow_nan=False); f.write('\n')
    print(json.dumps({k: v for k, v in result.items() if k not in ['groups', 'checks', 'resolutionTriplets']}))


if __name__ == '__main__':
    main()
