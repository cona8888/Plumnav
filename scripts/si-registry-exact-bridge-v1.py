"""Separate synthetic registry RPC. The scientific verifier remains unchanged."""
import argparse
import copy
import json
import sys
from lib.si_exact_registry_v1 import ExactRegistry, finite_json, safe_integer, strict_json

VERSION = 'readout-registry-exact-v1'
ARMS = ('RW', 'GW', 'RL', 'GL', 'NS')
FIELDS = ('si-continuous', 'si-pulse', 'blank')


class Service:
    def __init__(self, path, expected_sha256):
        self.registry = ExactRegistry(path, expected_sha256)
        # Verify every local scientific dependency before importing it.
        from lib.si_stationary_head_contract import evaluate
        self.evaluate = evaluate

    def handle(self, request):
        finite_json(request)
        if type(request) is not dict or set(request) != {'id', 'operation', 'worldKey', 'arm', 'field', 'reportingReplicate', 'visits', 'motionContract'}:
            raise ValueError('Missing or undeclared RPC key')
        if not safe_integer(request['id']) or request['operation'] != 'verify':
            raise ValueError('Invalid operation or request identity')
        if request['arm'] not in ARMS or request['field'] not in FIELDS:
            raise ValueError('Undeclared arm or field')
        self.registry.check(request['worldKey'], request['reportingReplicate'])
        if type(request['visits']) is not list or any(type(v) is not dict for v in request['visits']):
            raise ValueError('Visits must be a list of objects')
        visits = copy.deepcopy(request['visits'])
        decision = self.evaluate(visits, 0., motion_contract=copy.deepcopy(request['motionContract']))
        return dict(version=VERSION, exactPoseOnly=True, registrySha256=self.registry.sha256,
                    context={key: request[key] for key in ('worldKey', 'arm', 'field', 'reportingReplicate')},
                    arms=[dict(poseRadiusMetres=0., observation=dict(visits=visits), decision=decision)])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--registry', required=True)
    parser.add_argument('--registry-sha256', required=True)
    args = parser.parse_args()
    service = Service(args.registry, args.registry_sha256)
    for line in sys.stdin:
        request = None
        try:
            request = strict_json(line)
            response = dict(id=request.get('id') if isinstance(request, dict) else None,
                            ok=True, result=service.handle(request))
        except Exception as error:
            identity = request.get('id') if isinstance(request, dict) else None
            response = dict(id=identity if safe_integer(identity) else None, ok=False,
                            error=f'{type(error).__name__}: {error}')
        print(json.dumps(response, allow_nan=False, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
