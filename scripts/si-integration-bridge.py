#!/usr/bin/env python3
"""Serial research RPC. No simulator truth enters the unchanged verifier."""
import copy
import json
import sys
from lib.si_stationary_head_contract import evaluate
from lib.si_reported_pose import transform


def handle(request):
    if request['operation'] != 'verify':
        raise ValueError('Unknown RPC operation')
    visits = request['visits']
    arms = []
    for radius in [0., .001]:
        observation = transform(visits, dict(model='exact' if radius == 0 else 'readout-jitter',
                                            amplitudeMetres=radius), request['reportingReplicate'])
        # The frozen transform's target metadata assumes a 100 m domain. V4 uses
        # only sample coordinates; keep commanded target metadata unchanged here.
        for v, original in zip(observation['visits'], visits):
            v['target'] = copy.deepcopy(original['target'])
        decision = evaluate(observation['visits'], radius, motion_contract=request['motionContract'])
        arms.append(dict(poseRadiusMetres=radius, observation=observation, decision=decision))
    return dict(arms=arms)


if __name__ == '__main__':
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = dict(id=request['id'], ok=True, result=handle(request))
        except Exception as exc:
            result = dict(id=locals().get('request', {}).get('id'), ok=False,
                          error=f'{type(exc).__name__}: {exc}')
        print(json.dumps(result, allow_nan=False, separators=(',', ':')), flush=True)
