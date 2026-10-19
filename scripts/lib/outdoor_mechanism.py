"""Post-hoc counterfactuals on frozen, prescribed-route concentration histories."""
from collections import defaultdict
import math
import numpy as np

STAGES = ['midpointOpportunity', 'instantOne', 'instantThree', 'delayThree',
          'responseFixed', 'responseBackground', 'observed', 'blankObserved']
EDGES = list(zip(STAGES[:6], STAGES[1:7])) + [('blankObserved', 'observed')]
ALARM_STAGES = STAGES[1:]


def clock(dt, sample, delay, count):
    if not (math.isfinite(dt) and dt > 0 and sample > 0 and delay >= 0):
        raise ValueError('Invalid clock')
    values = [sample/dt, delay/dt]
    if any(not math.isfinite(x) or x != int(x) for x in values):
        raise ValueError('Non-integral clock')
    every, shift = map(int, values)
    if every < 1 or count % every:
        raise ValueError('Incomplete output interval')
    return every, shift


def filtered(values, dt, sensor, noise=None):
    values = np.asarray(values, dtype=float)
    every, shift = clock(dt, sensor['sampleSeconds'], sensor['delaySeconds'], len(values))
    if not np.isfinite(values).all() or (values < 0).any():
        raise ValueError('Invalid inlet')
    if min(sensor['riseSeconds'], sensor['recoverySeconds'], sensor['saturationPpm']) <= 0:
        raise ValueError('Invalid response')
    count = len(values)//every
    noise = np.zeros(count) if noise is None else np.asarray(noise, dtype=float)
    if len(noise) != count or not np.isfinite(noise).all() or sensor['noisePpm'] < 0:
        raise ValueError('Invalid noise')
    state, output = 2., []
    for i in range(len(values)):
        incoming = 2. if i < shift else values[i-shift]
        tau = sensor['riseSeconds'] if incoming >= state else sensor['recoverySeconds']
        state = incoming + (state-incoming)*math.exp(-dt/tau)
        if (i+1) % every == 0:
            output.append(min(sensor['saturationPpm'], max(0., state + sensor['noisePpm']*noise[len(output)])))
    return np.array(output)


def ideal(values, dt, sensor, delayed):
    every, shift = clock(dt, sensor['sampleSeconds'], sensor['delaySeconds'] if delayed else 0, len(values))
    indices = np.arange(every-1, len(values), every)-shift
    output = np.full(len(indices), 2.)
    valid = indices >= 0
    output[valid] = np.asarray(values)[indices[valid]]
    return np.clip(output, 0, sensor['saturationPpm'])


def alarm(values, threshold, consecutive=3, sample=1):
    if consecutive < 1 or int(consecutive) != consecutive:
        raise ValueError('Invalid consecutive count')
    values = np.asarray(values)
    if not np.isfinite(values).all():
        raise ValueError('Nonfinite reading')
    if len(values) < consecutive:
        return None
    windows = np.convolve((values > threshold).astype(int), np.ones(consecutive, dtype=int), mode='valid')
    hits = np.flatnonzero(windows == consecutive)
    return float((int(hits[0])+consecutive)*sample) if len(hits) else None


def derive(trace, trace_index):
    inlet = trace['inlet']; dt = trace['resolution']['dt']
    excess = np.array([r['referenceExcessPpm'] for r in inlet])
    background = np.array([r['backgroundPpm'] for r in inlet])
    blanks = {m['sensor']['id']: m for m in trace['measurements'] if m['rateKgPerSecond'] == 0}
    rows = []
    max_error = 0.
    for measurement in trace['measurements']:
        sensor = measurement['sensor']; rate = measurement['rateKgPerSecond']
        scaled = excess * (rate/1e-5)
        fixed, actual = 2+scaled, background+scaled
        instantaneous = ideal(fixed, dt, sensor, False)
        delayed = ideal(fixed, dt, sensor, True)
        response_fixed = filtered(fixed, dt, sensor)
        response_background = filtered(actual, dt, sensor)
        # Apply noise before clipping; clipping and adding noise do not commute.
        reconstructed = filtered(actual, dt, sensor, trace['noise'])
        max_error = max(max_error, float(np.max(np.abs(reconstructed-measurement['readings']))))
        if not np.allclose(reconstructed, measurement['readings'], atol=1e-9, rtol=1e-12):
            raise ValueError('Observed readings do not replay')
        for saved in measurement['outcomes']:
            k = saved['k']; h = k*sensor['noisePpm']; threshold = 2+h
            above = scaled > h
            decisions = dict(midpointOpportunity=bool(above.any()))
            times = dict(
                instantOne=alarm(instantaneous, threshold, 1),
                instantThree=alarm(instantaneous, threshold),
                delayThree=alarm(delayed, threshold),
                responseFixed=alarm(response_fixed, threshold),
                responseBackground=alarm(response_background, threshold),
                observed=alarm(measurement['readings'], threshold),
                blankObserved=alarm(blanks[sensor['id']]['readings'], threshold))
            if times['observed'] != saved['alarmSeconds']:
                raise ValueError('Saved alarm mismatch')
            decisions.update({s: t is not None for s, t in times.items()})
            rows.append(dict(traceIndex=trace_index, **trace['spec'], sensor=sensor['id'], rateKgPerSecond=rate,
                k=k, thresholdExcessPpm=h, maxExcessPpm=float(scaled.max()),
                exposureSeconds=float(above.sum()*dt), decisions=decisions, alarmSeconds=times))
    return rows, max_error


def key(row):
    return (row['wind'], row['speed'], row['sensor'], row['rateKgPerSecond'], row['k'])


def paired(left, right, worlds):
    out = {s: [] for s in ['both', 'leftOnly', 'rightOnly', 'neither']}
    for a, b, world in zip(left, right, worlds):
        label = 'both' if a and b else 'leftOnly' if a else 'rightOnly' if b else 'neither'
        out[label].append(world)
    return {label: dict(count=len(ids), worlds=ids) for label, ids in out.items()}


def summarise(rows):
    groups = defaultdict(list)
    for row in rows:
        if row['resolution'] == 0:
            groups[key(row)].append(row)
    if len(groups) != 288:
        raise ValueError('Setting count')
    summaries = []
    for group_key, group in sorted(groups.items()):
        group.sort(key=lambda r: r['world']); worlds = [r['world'] for r in group]
        if worlds != list(range(1000, 1128)):
            raise ValueError('World duplication/omission')
        stages = {s: dict(positive=sum(r['decisions'][s] for r in group),
            worlds=[r['world'] for r in group if r['decisions'][s]]) for s in STAGES}
        for s in ALARM_STAGES:
            stages[s]['restrictedMeanSeconds'] = sum(r['alarmSeconds'][s] if r['alarmSeconds'][s] is not None else 600 for r in group)/128
        transitions = [dict(left=a, right=b, **paired([r['decisions'][a] for r in group],
                       [r['decisions'][b] for r in group], worlds)) for a, b in EDGES]
        missed = [r for r in group if not r['decisions']['observed']]
        summaries.append(dict(zip(['wind', 'speed', 'sensor', 'rateKgPerSecond', 'k'], group_key),
            n=128, stages=stages, transitions=transitions,
            observedMisses=len(missed), missesWithoutMidpointOpportunity=sum(not r['decisions']['midpointOpportunity'] for r in missed),
            missesWithMidpointOpportunity=sum(r['decisions']['midpointOpportunity'] for r in missed),
            observedWithoutMidpointOpportunity=sum(r['decisions']['observed'] and not r['decisions']['midpointOpportunity'] for r in group)))
    return summaries


def refinement(rows):
    groups = defaultdict(dict)
    for r in rows:
        if r['world'] in [1000, 1042, 1085, 1127]:
            groups[(r['world'], *key(r))][r['resolution']] = r
    if len(groups) != 16*72 or any(set(g) != {0, 1, 2} for g in groups.values()):
        raise ValueError('Refinement inventory')
    result = []
    for lo, hi in [(0, 1), (1, 2)]:
        changes, differences = [], []
        maximum_time_difference = 0.
        for group_key, g in sorted(groups.items()):
            identity = dict(zip(['world', 'wind', 'speed', 'sensor', 'rateKgPerSecond', 'k'], group_key))
            for s in STAGES:
                if g[lo]['decisions'][s] != g[hi]['decisions'][s]:
                    changes.append(dict(**identity, stage=s, low=g[lo]['decisions'][s], high=g[hi]['decisions'][s]))
            for s in ALARM_STAGES:
                a, b = g[lo]['alarmSeconds'][s], g[hi]['alarmSeconds'][s]
                a = 600 if a is None else a; b = 600 if b is None else b
                maximum_time_difference = max(maximum_time_difference, abs(a-b))
                if a != b:
                    differences.append(dict(**identity, stage=s, lowRestrictedSeconds=a, highRestrictedSeconds=b))
        result.append(dict(lowResolution=lo, highResolution=hi, comparedSettings=len(groups),
            decisionChanges=changes, restrictedTimeChanges=differences,
            maxRestrictedTimeDifferenceSeconds=maximum_time_difference))
    return result
