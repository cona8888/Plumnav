#!/usr/bin/env python3
"""Versioned reporting RPC; the stationary-head and v4 verifier are unchanged."""
import json
import os
import sys
from lib.si_response_reporting_fixture import ReportingFixture, transform
from lib.si_stationary_head_contract import evaluate


def handle(request, fixture):
    if set(request) - {'id', 'operation', 'visits', 'motionContract', 'reportingReplicate'}:
        raise ValueError('Undeclared verifier RPC input')
    if request['operation'] != 'verify': raise ValueError('Unknown RPC operation')
    arms = []
    for radius in [0., .001]:
        observation = transform(request['visits'], dict(model='exact' if radius == 0 else 'readout-jitter',
            amplitudeMetres=radius), request['reportingReplicate'], fixture)
        decision = evaluate(observation['visits'], radius, motion_contract=request['motionContract'])
        arms.append(dict(poseRadiusMetres=radius, observation=observation, decision=decision))
    return dict(arms=arms)


if __name__ == '__main__':
    fixture = ReportingFixture(os.environ['REPORTING_FIXTURE_FILE'], os.environ['REPORTING_FIXTURE_SHA256'])
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            result = dict(id=request['id'], ok=True, result=handle(request, fixture))
        except Exception as exc:
            result = dict(id=request.get('id') if isinstance(request, dict) else None,
                          ok=False, error=f'{type(exc).__name__}: {exc}')
        print(json.dumps(result, allow_nan=False, separators=(',', ':')), flush=True)
