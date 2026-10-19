#!/usr/bin/env python3
"""Read-only, post-hoc diagnosis of exact cloud/Mac observation equality.

This reports differences and unchanged decision checks, never grants acceptance.
It imports the frozen functions and does not change them or the saved records.
"""
import argparse
import gzip
import hashlib
import json
import math
import sys
import time
from pathlib import Path


def differences(left, right, path=''):
    if isinstance(left, dict) and isinstance(right, dict):
        if left.keys() != right.keys():
            return [dict(path=path, kind='keys', local=list(left), cloud=list(right))]
        return [d for k in left for d in differences(left[k], right[k], path+'/'+k)]
    if isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            return [dict(path=path, kind='length', local=len(left), cloud=len(right))]
        return [d for i, (a, b) in enumerate(zip(left, right)) for d in differences(a, b, path+f'/{i}')]
    if left == right:
        return []
    if (type(left) in (float, int) and type(right) in (float, int)
            and math.isfinite(left) and math.isfinite(right)):
        error = abs(left-right)
        return [dict(path=path, kind='numeric', local=left, cloud=right,
                     absoluteDifference=error,
                     localUlps=error/max(math.ulp(left), math.ulp(right)))]
    return [dict(path=path, kind='categorical', local=left, cloud=right)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.bundle.resolve()/'scripts'))
    from lib.si_reported_pose import transform
    from lib.si_v4_decision_audit import check_decision
    start = time.monotonic()
    details = []
    for receipt in sorted(args.root.glob('worker-*/case-*.receipt.json')):
        item = json.loads(receipt.read_text())
        body = (receipt.parent/item['file']).read_bytes()
        assert hashlib.sha256(body).hexdigest() == item['sha256']
        record = json.loads(gzip.decompress(body))
        arms = []
        for arm in (record['verification'] or {}).get('arms', []):
            radius = arm['poseRadiusMetres']
            wanted = transform(record['visits'], dict(model='exact' if radius == 0 else 'readout-jitter',
                               amplitudeMetres=radius), 600000+record['spec']['replicate'])
            for v, original in zip(wanted['visits'], record['visits']):
                v['target'] = original['target']
            diffs = differences(wanted, arm['observation'])
            numeric = [d for d in diffs if d['kind'] == 'numeric']
            by_group = {}
            for d in numeric:
                group = d['path'].split('/')[1]
                g = by_group.setdefault(group, dict(count=0, maximumAbsoluteDifference=0., maximumUlps=0.))
                g['count'] += 1
                g['maximumAbsoluteDifference'] = max(g['maximumAbsoluteDifference'], d['absoluteDifference'])
                g['maximumUlps'] = max(g['maximumUlps'], d['localUlps'])
            checks = {}
            for label, observation in [('saved', arm['observation']), ('reconstructed', wanted)]:
                try:
                    checks[label] = dict(passed=True, result=check_decision(observation['visits'],
                        arm['decision']['candidate'], radius, 0.))
                except Exception as e:
                    checks[label] = dict(passed=False, error=f'{type(e).__name__}: {e}')
            arms.append(dict(poseRadiusMetres=radius, exactObservationEqual=not diffs,
                admitted=arm['decision']['admitted'], numericDifferenceCount=len(numeric),
                nonNumericDifferences=[d for d in diffs if d['kind'] != 'numeric'],
                numericGroups=by_group, differences=diffs, decisionChecks=checks))
        details.append(dict(index=item['index'], arms=arms, stage=record['summary']['stage']))
        print(f"Diagnosed case {item['index']}: {len(arms)} verification arms", flush=True)
    report = dict(diagnosticOnly=True, grantsAcceptance=False, unchangedFullMacAuditPassed=False,
                  caseCount=len(details), details=details, elapsedSeconds=time.monotonic()-start)
    with args.output.open('x') as f:
        json.dump(report, f, indent=2, allow_nan=False)
        f.write('\n')


if __name__ == '__main__':
    main()
