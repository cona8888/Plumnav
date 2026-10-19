"""Research v4: QR-whitened finite coordinate-error envelopes.

Conditional robustness of scalar-quadratic refits, not a bound on unobserved
plume physics. The v3 implementation and its failed validation are immutable.
"""
import math
import numpy as np
from lib.si_bounded_pose import rows, value_error_bounds, aggregate, MARGIN


def gradient_map(point):
    x, y = point
    return np.array([[0., 1., 0., x, y, 0.], [0., 0., 1., 0., x, y]])


HESSIAN_MAP = np.array([[0., 0., 0., 1., 0., 0.],
                        [0., 0., 0., 0., math.sqrt(2), 0.],
                        [0., 0., 0., 0., 0., 1.]])


def whitened_row_bounds(xy, radius, transform):
    """Bound ||(a(p+delta)-a(p)) T|| for every ||delta|| <= radius.

    The second-order row has norm <= sqrt(3/8) ||delta||^2;
    the first-order row is delta^T gradient_map(p) T.
    """
    radii = np.broadcast_to(np.asarray(radius), (len(xy),))
    second = math.sqrt(3 / 8) * np.linalg.norm(transform[3:, :], 2)
    return np.array([r * np.linalg.norm(gradient_map(p) @ transform, 2)
                     + r * r * second for p, r in zip(xy, radii)])


def fit_envelope(xy, values, radius):
    xy = np.asarray(xy, dtype=float)
    y = np.asarray(values, dtype=float)
    r = np.broadcast_to(np.asarray(radius, dtype=float), (len(y),))
    a = rows(xy)
    beta, _, rank, singular = np.linalg.lstsq(a, y, rcond=None)
    residual = y - a @ beta
    base = {'rank': int(rank), 'sigmaMin': float(singular[-1]),
            'coefficients': beta.tolist(),
            'rmse': float(np.linalg.norm(residual) / math.sqrt(len(y)))}
    if rank != 6 or singular[0] / singular[-1] > 1e6:
        return {**base, 'admitted': False, 'reason': 'coordinate-rank-uncertain'}
    q, triangular = np.linalg.qr(a, mode='reduced')
    transform = np.linalg.solve(triangular, np.eye(6))
    errors = whitened_row_bounds(xy, r, transform)
    epsilon = float(np.linalg.norm(errors))
    lower = 1. - epsilon
    base.update(basisTransform=transform.tolist(), whitenedMatrixErrorUpper=epsilon,
                whitenedSigmaLower=lower, whitenedRowErrorBounds=errors.tolist())
    if lower <= 0:
        return {**base, 'admitted': False, 'reason': 'coordinate-rank-uncertain'}
    value_change = float(np.linalg.norm(value_error_bounds(xy, r, beta)))
    normal_residual = float(np.linalg.norm(q.T @ residual))
    gamma_radius = ((epsilon * float(np.linalg.norm(residual)) + normal_residual)
                    / lower ** 2 + value_change / lower)
    coefficient_radius = float(np.linalg.norm(transform, 2) * gamma_radius)
    hessian_radius = float(np.linalg.norm(HESSIAN_MAP @ transform, 2) * gamma_radius)
    hessian = np.array([[beta[3], beta[4]], [beta[4], beta[5]]])
    eigen = float(np.linalg.eigvalsh(hessian)[-1])
    eigen_upper = eigen + hessian_radius
    # Peak diagnostics have no evidential role outside admitted strict curvature.
    # Suppressing them also avoids divisions by near-zero curvature in audits.
    peak = radius_peak = peak_upper = None
    if eigen_upper < -.006:
        peak_array = -np.linalg.solve(hessian, beta[1:3])
        radius_peak = float(np.linalg.norm(gradient_map(peak_array) @ transform, 2)
                            * gamma_radius / (-eigen_upper))
        peak = peak_array.tolist()
        peak_upper = float(np.linalg.norm(peak_array)) + radius_peak
    return {**base, 'admitted': True, 'whitenedCoefficientRadius': gamma_radius,
            'coefficientRadius': coefficient_radius, 'hessianRadius': hessian_radius,
            'eigenMax': eigen, 'eigenMaxUpper': eigen_upper,
            'hessianNorm': float(np.linalg.norm(hessian, 2)),
            'rmseUpper': (float(np.linalg.norm(residual)) + value_change) / math.sqrt(len(y)),
            'peak': peak, 'peakRadius': radius_peak, 'peakNormUpper': peak_upper,
            'valueChangeNormUpper': value_change, 'whitenedNormalResidualNorm': normal_residual}


def bounded_crossfit(xy, values, radius):
    xy = np.asarray(xy)
    values = np.asarray(values)
    r = np.broadcast_to(np.asarray(radius), (17,))
    a = rows(xy)
    pairs = []
    for left in range(0, 15, 2):
        right = left + 2
        training = [i for i in range(17) if i not in (left, right)]
        model = fit_envelope(xy[training], values[training], r[training])
        pair = {'centres': [left, right], 'trainingVisits': training, 'envelope': model}
        if not model['admitted'] or model['rmseUpper'] > MARGIN:
            pair.update(state='indeterminate', reason='coordinate-correction-unreliable')
        else:
            matrix = a[training]
            difference = a[left] - a[right]
            weights = difference @ np.linalg.pinv(matrix)
            correction = float(weights @ values[training])
            transform = np.array(model['basisTransform'])
            epsilon = model['whitenedMatrixErrorUpper']
            lower = model['whitenedSigmaLower']
            eta = float(sum(whitened_row_bounds(xy[[left, right]], r[[left, right]], transform)))
            dnorm = float(np.linalg.norm(difference @ transform))
            changes = value_error_bounds(xy[[left, right]], r[[left, right]], np.array(model['coefficients']))
            coordinate = (dnorm + eta) * model['whitenedCoefficientRadius'] + float(sum(changes))
            inverse_change = epsilon / lower + epsilon / lower ** 2
            weight_change = eta / lower + dnorm * inverse_change
            noise = MARGIN * (float(np.sum(np.abs(weights))) + math.sqrt(15) * weight_change)
            allowance = coordinate + noise
            residual = abs(float(values[left] - values[right]) - correction)
            tolerance = max(MARGIN, .05 * float(min(values[left], values[right])))
            state = 'pass' if residual + allowance <= tolerance else 'reject' if residual - allowance > tolerance else 'indeterminate'
            pair.update(state=state, reason='bounded-coordinate-comparison', correction=correction,
                        coordinateAllowance=coordinate, trainingAllowance=noise,
                        totalAllowance=allowance, residual=residual, tolerance=tolerance,
                        whitenedDifferenceNorm=dnorm, whitenedDifferenceErrorUpper=eta,
                        weightChangeUpper=weight_change)
        pairs.append(pair)
    return {'state': aggregate(p['state'] for p in pairs), 'pairs': pairs}


def bounded_dwell(visits, model, radius):
    windows = []
    for i, visit in enumerate(visits):
        points = np.array([[s['x'], s['y']] for s in visit['samples']])
        values = np.array([s['value'] for s in visit['samples']])
        diameter = float(np.max(np.linalg.norm(points[:, None, :] - points[None, :, :], axis=2)))
        distance = diameter + 2 * radius
        spread = float(np.ptp(values))
        tolerance = max(MARGIN, .05 * float(values.min()))
        window = {'visit': i, 'reportedDiameter': diameter, 'possibleDistanceUpper': distance,
                  'range': spread, 'tolerance': tolerance}
        if distance == 0:
            gradient = change = 0.
        elif not model['admitted'] or model['rmseUpper'] > MARGIN:
            window.update(state='indeterminate', reason='spatial-variation-bound-unavailable')
            windows.append(window)
            continue
        else:
            centre = points.mean(axis=0)
            reach = float(np.max(np.linalg.norm(points - centre, axis=1))) + radius
            gradient_operator = gradient_map(centre)
            gradient = (float(np.linalg.norm(gradient_operator @ np.array(model['coefficients'])))
                        + float(np.linalg.norm(gradient_operator @ np.array(model['basisTransform']), 2)) * model['whitenedCoefficientRadius']
                        + (model['hessianNorm'] + model['hessianRadius']) * reach)
            change = gradient * distance
        state = 'pass' if spread + change <= tolerance else 'reject' if spread - change > tolerance else 'indeterminate'
        window.update(state=state, reason='bounded-model-variation', gradientUpper=gradient, spatialChangeUpper=change)
        windows.append(window)
    return {'state': aggregate(w['state'] for w in windows), 'windows': windows}


def evaluate(visits, pose_radius_metres, *, inspection_offset_metres=.1,
             frame_radius_metres=0., observation_model=None, dwell_heading_span_radians=None):
    def abstain(reason):
        return {'status': 'abstained', 'reason': reason, 'version': 'bounded-pose-v4'}
    if observation_model != 'fixed-orientation-local-quadratic':
        return abstain('unsupported-observation-contract')
    if not isinstance(dwell_heading_span_radians, (int, float)) or not math.isfinite(dwell_heading_span_radians) or not 0 <= dwell_heading_span_radians <= 1e-9:
        return abstain('unresolved-within-dwell-orientation')
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in [pose_radius_metres, inspection_offset_metres, frame_radius_metres]) or pose_radius_metres < 0 or inspection_offset_metres <= 0 or frame_radius_metres < 0:
        return abstain('invalid-coordinate-bound')
    if len(visits) != 17 or any(v.get('closedAt') is None or len(v.get('samples', [])) != 5 for v in visits):
        return abstain('insufficient-samples')
    if any(not math.isfinite(s[k]) for v in visits for s in v['samples'] for k in ('time', 'value', 'x', 'y')):
        return abstain('nonfinite-input')
    if any(abs(v['samples'][j + 1]['time'] - v['samples'][j]['time'] - 1) > 1e-9 for v in visits for j in range(4)):
        return abstain('invalid-sample-clock')
    if not all(s['telemetryComplete'] for v in visits for s in v['samples']):
        return abstain('missing-channel-telemetry')
    if any(s['clipped'] for v in visits for s in v['samples']):
        return abstain('clipped-required-measurement')
    xy = np.array([[np.mean([s[k] for s in v['samples']]) for k in ('x', 'y')] for v in visits])
    values = np.array([np.median([s['value'] for s in v['samples']]) for v in visits])
    if any(values[i] < .16 or sum(s['hit'] for s in visits[i]['samples']) < 2 for i in range(0, 17, 2)):
        return abstain('insufficient-signal')
    radius = pose_radius_metres / inspection_offset_metres
    model = fit_envelope(xy, values, radius)
    dwell = bounded_dwell(visits, model, radius)
    crossfit = bounded_crossfit(xy, values, radius)
    temporal = aggregate([dwell['state'], crossfit['state']])
    checks = [(temporal != 'reject', 'measurement-inconsistency'),
              (temporal != 'indeterminate', 'bounded-temporal-indeterminate'),
              (model['admitted'], 'coordinate-rank-uncertain'),
              (model.get('rmseUpper', math.inf) <= MARGIN, 'coordinate-fit-indeterminate'),
              (model.get('eigenMaxUpper', math.inf) < -.006, 'coordinate-curvature-indeterminate'),
              (model.get('peakNormUpper') is not None and model['peakNormUpper'] <= 1, 'coordinate-peak-indeterminate')]
    reason = next((name for ok, name in checks if not ok), 'bounded-local-quadratic-supported')
    supported = reason == 'bounded-local-quadratic-supported'
    return {'version': 'bounded-pose-v4', 'status': 'supported' if supported else 'abstained',
            'reason': reason, 'geometry': model, 'dwell': dwell, 'crossfit': crossfit,
            'poseRadiusMetres': pose_radius_metres,
            'relativePeakRadiusMetres': model['peakRadius'] * inspection_offset_metres if supported else None,
            'mapPeakRadiusMetres': model['peakRadius'] * inspection_offset_metres + frame_radius_metres if supported else None,
            'claim': 'Conditional robustness of the fitted scalar quadratic to the declared coordinate-error balls; not physical-source confirmation or calibrated probabilistic coverage.'}
