"""Stage 1j research-only, leave-two-centres-out temporal gate (version 1).

Inputs contain measurements and reported sample coordinates only. The bound is
a declared deterministic sensitivity allowance, not a statistical interval.
"""
import math
import numpy as np

MARGIN = .003
CONDITION_LIMIT = 1e6


def design_rows(visits):
    xy = np.array([[sum(s[k] for s in v['samples']) / len(v['samples']) for k in ('x', 'y')] for v in visits])
    x, y = xy.T
    return np.column_stack((np.ones(len(visits)), x, y, x*x/2, x*y, y*y/2))


def temporal_check(visits):
    if len(visits) != 17 or any(v['closedAt'] is None or len(v['samples']) < 2 for v in visits):
        return {'state': 'indeterminate', 'reason': 'incomplete-visits', 'pairs': []}
    if any(not math.isfinite(s[k]) for v in visits for s in v['samples'] for k in ('value', 'x', 'y')):
        return {'state': 'indeterminate', 'reason': 'nonfinite-input', 'pairs': []}
    rows = design_rows(visits)
    values = np.array([sorted(s['value'] for s in v['samples'])[len(v['samples'])//2] for v in visits])
    pairs = []
    for a in range(0, 15, 2):
        b = a + 2
        training = [i for i in range(17) if i not in (a, b)]
        x, y = rows[training], values[training]
        coefficients, _, rank, singular = np.linalg.lstsq(x, y, rcond=None)
        condition = float(singular[0] / singular[-1]) if singular[-1] > 0 else None
        rmse = float(np.sqrt(np.mean((x @ coefficients - y)**2)))
        pair = {'centres': [a, b], 'trainingVisits': training, 'rank': int(rank),
                'conditionNumber': condition, 'trainingRmseC0': rmse}
        if rank != 6 or condition is None or condition > CONDITION_LIMIT or rmse > MARGIN:
            pair.update(state='indeterminate', reason='spatial-correction-unreliable')
        else:
            weights = (rows[a]-rows[b]) @ np.linalg.pinv(x)
            correction = float(weights @ y)
            bound = MARGIN * float(np.sum(np.abs(weights)))
            raw = float(values[a]-values[b])
            residual = abs(raw-correction)
            tolerance = max(MARGIN, .05 * float(min(values[a], values[b])))
            state = 'pass' if residual+bound <= tolerance else 'reject' if residual-bound > tolerance else 'indeterminate'
            pair.update(state=state, reason='corrected-comparison', spatialCorrectionC0=correction,
                        correctionAllowanceC0=bound, rawDifferenceC0=raw,
                        correctedAbsoluteDifferenceC0=residual, toleranceC0=tolerance)
        pairs.append(pair)
    states = [p['state'] for p in pairs]
    return {'state': 'reject' if 'reject' in states else 'indeterminate' if 'indeterminate' in states else 'pass',
            'reason': 'leave-two-centres-out-v1', 'pairs': pairs}


def evaluate(visits, original):
    """Keep the frozen non-temporal gates; do not refit the final peak differently."""
    temporal = temporal_check(visits)
    gates = original['gates']
    peak = original['peak']
    checks = [
        (gates['telemetry'], 'missing-channel-telemetry'),
        (not gates['clipped'], 'clipped-required-measurement'),
        (gates['complete'], 'insufficient-samples'),
        (gates['core'], 'insufficient-signal'),
        (temporal['state'] != 'reject', 'temporal-inconsistency'),
        (temporal['state'] != 'indeterminate', 'spatiotemporal-indeterminate'),
        (original['rmse'] is not None and original['rmse'] <= MARGIN, 'spatial-model-mismatch'),
        (original['eigenMax'] is not None and original['eigenMax'] < -2*MARGIN, 'not-negative-definite'),
        (peak is not None and math.hypot(peak['x'], peak['y']) <= 1, 'maximum-outside-probed-region')]
    reason = next((reason for passed, reason in checks if not passed), 'local-quadratic-supported')
    return {'status': 'supported' if reason == 'local-quadratic-supported' else 'abstained',
            'reason': reason, 'temporal': temporal}
