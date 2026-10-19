"""Case-bound exact-pose RPC for the separately versioned mechanism worker."""
import argparse
import copy
import json
import sys
from lib.si_exact_registry_v1 import finite_json, safe_integer, strict_json
from lib.si_mechanism_registry_v1 import Registry, check


class Service:
    def __init__(self, path, expected_sha):
        self.registry = Registry(path, expected_sha)
        from lib.si_stationary_head_contract import evaluate
        self.evaluate = evaluate

    def handle(self, q):
        finite_json(q)
        check(type(q) is dict and set(q) == {'id', 'caseId', 'operation', 'reportingReplicate', 'visits', 'motionContract'}, 'RPC keys')
        check(safe_integer(q['id']) and q['operation'] == 'verify', 'RPC operation/id')
        check(type(q['caseId']) is str and q['caseId'] in self.registry.cases, 'Unknown case')
        c = self.registry.cases[q['caseId']]; w = self.registry.worlds[c['worldKey']]
        check(safe_integer(q['reportingReplicate']) and q['reportingReplicate'] == w['reportingReplicate'], 'Wrong reporting identity')
        check(type(q['visits']) is list and all(type(v) is dict for v in q['visits']), 'Visits')
        visits = copy.deepcopy(q['visits'])
        decision = self.evaluate(visits, 0., motion_contract=copy.deepcopy(q['motionContract']))
        return dict(version='mechanism-exact-v1', exactPoseOnly=True, manifestSha256=self.registry.sha256,
                    context=dict(caseId=c['id'], worldKey=c['worldKey'], arm=c['arm'], field=c['spec']['field'], reportingReplicate=w['reportingReplicate']),
                    arms=[dict(poseRadiusMetres=0., observation=dict(visits=visits), decision=decision)])


def main():
    p = argparse.ArgumentParser(); p.add_argument('--manifest', required=True); p.add_argument('--sha256', required=True); a = p.parse_args()
    service = Service(a.manifest, a.sha256)
    for line in sys.stdin:
        q = None
        try:
            q = strict_json(line)
            reply = dict(id=q.get('id') if type(q) is dict else None, ok=True, result=service.handle(q))
        except Exception as e:
            identity = q.get('id') if type(q) is dict else None
            reply = dict(id=identity if safe_integer(identity) else None, ok=False, error=type(e).__name__ + ': ' + str(e))
        print(json.dumps(reply, allow_nan=False, separators=(',', ':')), flush=True)
    service.registry.protect()


if __name__ == '__main__': main()
