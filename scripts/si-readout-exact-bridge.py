"""Development-only exact-pose RPC; no new verifier or reporting perturbations."""
import copy
import json
import sys
from lib.si_stationary_head_contract import evaluate

VERSION = 'readout-exact-admission-v1'

def handle(request):
    if set(request) != {'id','operation','visits','motionContract','reportingReplicate'}:
        raise ValueError('Undeclared or missing verifier RPC key')
    if request['operation'] != 'verify':
        raise ValueError('Unknown operation')
    if type(request['reportingReplicate']) is not int or request['reportingReplicate'] != 603000:
        raise ValueError('Undeclared development reporting ID')
    visits=copy.deepcopy(request['visits'])
    decision=evaluate(visits, 0., motion_contract=request['motionContract'])
    return dict(version=VERSION, exactPoseOnly=True,
                arms=[dict(poseRadiusMetres=0., observation=dict(visits=visits), decision=decision)])

if __name__ == '__main__':
    for line in sys.stdin:
        request=None
        try:
            request=json.loads(line)
            result=dict(id=request['id'],ok=True,result=handle(request))
        except Exception as exc:
            result=dict(id=request.get('id') if isinstance(request,dict) else None,ok=False,error=f'{type(exc).__name__}: {exc}')
        print(json.dumps(result,allow_nan=False,separators=(',',':')),flush=True)
