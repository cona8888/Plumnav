"""Research-only admission restriction; not a motion sensor or physical proof."""
import math
from lib.si_bounded_pose_v4 import evaluate as evaluate_v4

VERSION='stationary-head-admission-v1'


def finite_number(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)


def check_contract(visits,contract):
    if not isinstance(contract,dict):return 'continuous-motion-information-unavailable'
    if (contract.get('version')!='continuous-stationary-head-v1' or
        contract.get('basis')!='prescribed-numerical-constraint' or
        contract.get('scope')!='continuous-head-centre-and-orientation'):
        return 'unsupported-continuous-motion-contract'
    windows=contract.get('windows')
    if not isinstance(visits,list) or len(visits)!=17 or not isinstance(windows,list) or len(windows)!=17:
        return 'incomplete-continuous-motion-coverage'
    for i,(visit,window) in enumerate(zip(visits,windows)):
        if not isinstance(visit,dict) or not isinstance(window,dict) or type(window.get('visit')) is not int or window['visit']!=i:
            return 'incomplete-continuous-motion-coverage'
        start=window.get('start');end=window.get('end');arrival=visit.get('arrivedAt');closed=visit.get('closedAt')
        if not all(finite_number(v) for v in [start,end,arrival,closed]) or not 0<=start<=arrival<closed<=end:
            return 'incomplete-continuous-motion-coverage'
        diameter=window.get('translationDiameterMetres');angle=window.get('orientationSpanRadians')
        if not all(finite_number(v) and v>=0 for v in [diameter,angle]):return 'invalid-continuous-motion-bound'
        if diameter!=0 or angle!=0:return 'continuous-stationarity-not-established'
    return None


def evaluate(visits,pose_radius_metres,*,motion_contract=None,inspection_offset_metres=.1,frame_radius_metres=0.):
    reason=check_contract(visits,motion_contract)
    if reason is not None:
        return dict(version=VERSION,admitted=False,status='abstained',reason=reason,candidate=None)
    candidate=evaluate_v4(visits,pose_radius_metres,inspection_offset_metres=inspection_offset_metres,
                          frame_radius_metres=frame_radius_metres,observation_model='fixed-orientation-local-quadratic',dwell_heading_span_radians=0.)
    return dict(version=VERSION,admitted=True,status=candidate['status'],reason=candidate['reason'],candidate=candidate,
                claim='Conditional fitted-maximum result under a prescribed continuous stationary-head numerical constraint; not an empirical motion certificate or physical-source confirmation.')
