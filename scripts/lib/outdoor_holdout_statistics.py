"""Frozen, world-paired statistics; no controller/sensor fitting."""
from collections import defaultdict
import math
import numpy as np

BOOTSTRAP_SEED = 2230922
BOOTSTRAP_RESAMPLES = 10000
QUANTILES = [.0125, .9875]


def wilson(hits, n):
    if not isinstance(n, int) or not isinstance(hits, int) or not 0 <= hits <= n or n == 0:
        raise ValueError('Invalid independent-world counts')
    z = 1.959963984540054
    p, d = hits/n, 1 + z*z/n
    middle = (p + z*z/(2*n))/d
    half = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))/d
    return [max(0., middle-half), min(1., middle+half)]


def paired_summary(fast_alarm, slow_alarm, fast_time, slow_time):
    arrays = [np.asarray(a, dtype=float) for a in [fast_alarm, slow_alarm, fast_time, slow_time]]
    n = len(arrays[0])
    if n < 2 or any(a.ndim != 1 or len(a) != n or not np.isfinite(a).all() for a in arrays):
        raise ValueError('Invalid paired vectors')
    if any(not np.isin(a, [0, 1]).all() for a in arrays[:2]) or any(((a < 0) | (a > 600)).any() for a in arrays[2:]):
        raise ValueError('Invalid event/time values')
    differences = np.column_stack([arrays[0]-arrays[1], arrays[2]-arrays[3]])
    rng = np.random.Generator(np.random.PCG64(BOOTSTRAP_SEED))
    indices = rng.integers(0, n, size=(BOOTSTRAP_RESAMPLES, n))
    boot = differences[indices].mean(axis=1)
    intervals = np.quantile(boot, QUANTILES, axis=0, method='linear').T
    return dict(n=n, direction='fast-minus-slow',
        alarmFractionDifference=float(differences[:, 0].mean()), alarmFractionInterval975=intervals[0].tolist(),
        restrictedMeanTimeDifferenceSeconds=float(differences[:, 1].mean()), restrictedTimeInterval975=intervals[1].tolist(),
        fastOnly=int(((arrays[0] == 1) & (arrays[1] == 0)).sum()),
        slowOnly=int(((arrays[0] == 0) & (arrays[1] == 1)).sum()),
        both=int(((arrays[0] == 1) & (arrays[1] == 1)).sum()), neither=int(((arrays[0] == 0) & (arrays[1] == 0)).sum()),
        bootstrap=dict(seed=BOOTSTRAP_SEED, resamples=BOOTSTRAP_RESAMPLES, generator='numpy-PCG64',
                       quantiles=QUANTILES, multiplicity='nominal Bonferroni allocation across two endpoints; approximate coverage'),
        warning='Degenerate percentile intervals do not establish population equivalence.')


def summarise(traces):
    groups = defaultdict(dict)
    for trace in traces:
        s = trace['spec']
        if s['resolution'] != 0:
            continue
        for measurement in trace['measurements']:
            for outcome in measurement['outcomes']:
                key = (s['wind'], s['speed'], measurement['sensor']['id'], measurement['rateKgPerSecond'], outcome['k'])
                if s['world'] in groups[key]:
                    raise ValueError('Duplicate paired world')
                groups[key][s['world']] = (outcome['alarmSeconds'] is not None, outcome['restrictedTimeSeconds'])
    expected = set(range(1000, 1128))
    if len(groups) != 288 or any(set(rows) != expected for rows in groups.values()):
        raise ValueError('Incomplete held-out settings/worlds')
    results = []
    for key, rows in sorted(groups.items()):
        wind, speed, sensor, rate, k = key
        count = sum(a for a, _ in rows.values())
        blank = groups[(wind, speed, sensor, 0, k)]
        results.append(dict(wind=wind, speed=speed, sensor=sensor, rateKgPerSecond=rate,
            rateKgPerHour=rate*3600, k=k, n=128, alarms=count, estimate=count/128,
            wilson95=wilson(count, 128), metric='false-alarm-per-survey' if rate == 0 else 'probability-of-detection',
            restrictedMeanTimeSeconds=sum(t for _, t in rows.values())/128,
            alarmsWithMatchedBlankSilent=sum(bool(rows[w][0] and not blank[w][0]) for w in sorted(expected)),
            pairedWorlds=sorted(expected), simultaneousGuarantee=False))
    lookup = {(r['wind'], r['speed'], r['sensor'], r['rateKgPerSecond'], r['k']): r for r in results}
    envelopes = []
    for wind in [.5, 2]:
        for speed in [.5, 1]:
            for noise in [.02, .2, 2]:
                for tau in [.5, 5]:
                    sensor = f'generic-sigma{noise:g}-tau{tau:g}'
                    for k in [3, 5, 7]:
                        blank = lookup[wind, speed, sensor, 0, k]
                        rates = []
                        for q in [1e-5, 1e-4, 1e-3]:
                            positive = lookup[wind, speed, sensor, q, k]
                            rates.append(dict(rateKgPerSecond=q,
                                pointEstimateCriteriaMet=positive['estimate'] >= .9 and blank['estimate'] <= .05,
                                pointwiseIntervalCriteriaMet=positive['wilson95'][0] >= .9 and blank['wilson95'][1] <= .05))
                        envelopes.append(dict(wind=wind, speed=speed, sensor=sensor, k=k, testedRates=rates,
                            pointwiseOnly=True, simultaneousGuarantee=False, universalMinimumRate=None))
    fast = groups[.5, 1, 'generic-sigma0.2-tau0.5', 1e-4, 5]
    slow = groups[.5, 1, 'generic-sigma0.2-tau5', 1e-4, 5]
    primary = paired_summary([fast[w][0] for w in sorted(expected)], [slow[w][0] for w in sorted(expected)],
                             [fast[w][1] for w in sorted(expected)], [slow[w][1] for w in sorted(expected)])
    return dict(groups=results, envelopes=envelopes, primaryContrast=primary, independentWorldsPerSetting=128,
                primaryOutcomes=36864, physicalValidation=False, calibratedCommercialDevices=False)
