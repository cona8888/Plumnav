"""Terminal-map helper only; does not audit a plume, controller or verifier fit."""
import math


def exact_keys(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError('Missing or undeclared terminal key')


def number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def point(value):
    exact_keys(value, ('x', 'y'))
    if not all(number(value[k]) for k in ('x', 'y')):
        raise ValueError('Non-finite point')
    return (value['x'], value['y'])


def terminal_metadata(field, config, nomination, verification, summary):
    """Extract six fields; only the binding layer supplies the audit assertion."""
    if field not in ('si-continuous', 'si-pulse', 'blank'):
        raise ValueError('Unknown field')
    blank = field == 'blank'
    exact_keys(config, ('domainMeters', 'targetStatus') if blank else ('domainMeters', 'targetStatus', 'sourcePositionOverride'))
    if not number(config['domainMeters']) or config['domainMeters'] != 10 or config['targetStatus'] != ('absent' if blank else 'present'):
        raise ValueError('Undeclared domain or target status')
    source = None if blank else point(config['sourcePositionOverride'])
    centre = None
    if nomination is not None:
        exact_keys(nomination, ('point',)); centre = point(nomination['point'])
    exact_keys(summary, ('stage', 'errors'))
    stage, reports = summary['stage'], summary['errors']
    if type(reports) is not list:
        raise ValueError('Report array required')
    status = None; reported = False; error = None
    if stage != 'inspection-complete':
        if stage not in ('no-eligible-nomination', 'mission-budget-exhausted') or verification is not None or reports:
            raise ValueError('Incomplete inspection contains terminal data')
        if (stage == 'no-eligible-nomination') != (nomination is None):
            raise ValueError('Nomination/stage mismatch')
    else:
        if centre is None:
            raise ValueError('Inspection missing nomination')
        exact_keys(verification, ('exactPoseOnly', 'arms'))
        if verification['exactPoseOnly'] is not True or type(verification['arms']) is not list or len(verification['arms']) != 1 or len(reports) != 1:
            raise ValueError('Exactly one nominal exact-pose arm/report required')
        arm, report = verification['arms'][0], reports[0]
        exact_keys(arm, ('poseRadiusMetres', 'decision')); exact_keys(report, ('poseRadiusMetres', 'reportedPoint', 'sourceErrorMetres'))
        if any(not number(row['poseRadiusMetres']) or row['poseRadiusMetres'] != 0 for row in (arm, report)):
            raise ValueError('Nonzero or invalid reporting radius')
        decision = arm['decision']; exact_keys(decision, ('status', 'candidate'))
        status = decision['status']; error = report['sourceErrorMetres']
        if status == 'abstained':
            if (decision['candidate'] is not None and type(decision['candidate']) is not dict) or report['reportedPoint'] is not None or error is not None:
                raise ValueError('Abstention contains a supported report')
        elif status == 'supported':
            exact_keys(decision['candidate'], ('geometry',)); exact_keys(decision['candidate']['geometry'], ('peak',))
            peak = decision['candidate']['geometry']['peak']
            if type(peak) is not list or len(peak) != 2 or not all(number(v) for v in peak):
                raise ValueError('Invalid relative peak')
            actual = point(report['reportedPoint']); expected = tuple(centre[i] + (.1 / config['domainMeters']) * peak[i] for i in range(2))
            if any(abs(a-b) > 1e-12 for a, b in zip(actual, expected)):
                raise ValueError('Reported point differs from fitted-peak mapping')
            reported = True
            if blank:
                if error is not None:
                    raise ValueError('Blank source error must be null')
            else:
                reconstructed = math.hypot(actual[0]-source[0], actual[1]-source[1]) * config['domainMeters']
                if not number(error) or error < 0 or abs(error-reconstructed) > 1e-10:
                    raise ValueError('Source error inconsistent with reported point')
                if (error <= .1) != (reconstructed <= .1):
                    raise ValueError('Source-error endpoint classification disagreement')
        else:
            raise ValueError('Unknown verifier status')
    return dict(field=field, stage=stage, nominationPresent=nomination is not None,
                nominalStatus=status, reportedPointPresent=reported, sourceErrorMetres=error)
