"""Research v2: measurement steadiness, not physical-cause classification."""
import math
from .si_pose_temporal import temporal_check


def dwell_check(visits):
    if len(visits) != 17:
        return {'state':'indeterminate','windows':[],'reason':'invalid-visit-count'}
    windows=[]
    for i,v in enumerate(visits):
        samples=v['samples']
        window={'visit':i}
        if v['closedAt'] is None or len(samples)!=5 or any(not math.isfinite(s[k]) for s in samples for k in ('time','value','x','y')):
            window.update(state='indeterminate',reason='invalid-window')
        elif any(abs(samples[j+1]['time']-samples[j]['time']-1)>1e-9 for j in range(4)):
            window.update(state='indeterminate',reason='invalid-clock')
        else:
            diameter=max(math.hypot(a['x']-b['x'],a['y']-b['y']) for a in samples for b in samples)
            values=[s['value'] for s in samples]
            spread=max(values)-min(values);allowance=max(.003,.05*min(values))
            window.update(positionDiameterOffsetUnits=diameter,rangeC0=spread,allowanceC0=allowance)
            if diameter>1e-9:
                window.update(state='indeterminate',reason='nonstationary-window')
            else:
                window.update(state='reject' if spread>allowance else 'pass',reason='measurement-window-variation' if spread>allowance else 'window-within-allowance')
        windows.append(window)
    states=[w['state'] for w in windows]
    return {'state':'reject' if 'reject' in states else 'indeterminate' if 'indeterminate' in states else 'pass',
            'windows':windows,'reason':'stationary-dwell-v2'}


def evaluate(visits,original):
    dwell=dwell_check(visits);crossfit=temporal_check(visits)
    states=[dwell['state'],crossfit['state']]
    temporal='reject' if 'reject' in states else 'indeterminate' if 'indeterminate' in states else 'pass'
    g=original['gates'];peak=original['peak']
    checks=[(g['telemetry'],'missing-channel-telemetry'),(not g['clipped'],'clipped-required-measurement'),
            (g['complete'],'insufficient-samples'),(g['core'],'insufficient-signal'),
            (temporal!='reject','temporal-inconsistency'),(temporal!='indeterminate','spatiotemporal-indeterminate'),
            (original['rmse'] is not None and original['rmse']<=.003,'spatial-model-mismatch'),
            (original['eigenMax'] is not None and original['eigenMax']<-.006,'not-negative-definite'),
            (peak is not None and math.hypot(peak['x'],peak['y'])<=1,'maximum-outside-probed-region')]
    reason=next((reason for passed,reason in checks if not passed),'local-quadratic-supported')
    return {'status':'supported' if reason=='local-quadratic-supported' else 'abstained','reason':reason,
            'temporalState':temporal,'dwell':dwell,'crossfit':crossfit,
            'interpretation':'Measurement variation may be field change, sensor relaxation or noise; no physical cause is inferred.'}
