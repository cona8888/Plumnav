"""Prespecified 32-world, fixed-hardware-response replication statistics."""
import numpy as np
from lib.si_scheduling_statistics import ARMS, BINARY, CONTINUOUS, wilson


def summarize(records, scales):
    primary = [r for r in records if r['spec']['caseRole'] == 'primary']
    keys = [(r['spec']['worldIndex'], r['spec']['field'], r['spec']['method'], r['spec']['policy'], r['spec']['responseScale']) for r in primary]
    expected = {(w, f, m, p, s) for w in range(32) for f in ['si-continuous', 'si-pulse', 'blank'] for m, p in ARMS for s in scales}
    assert len(keys) == len(set(keys)) == len(expected) and set(keys) == expected
    assert all(r['spec']['navDt'] == 1/64 and r['spec']['studyId'] == 'scheduling-response-replication-v1' for r in primary)
    draws = np.random.default_rng(282991).integers(0, 32, size=(10000, 32))
    binary = [*BINARY, 'supportedReleaseWithinPointOne']
    metrics = {}
    for r in primary:
        d = dict(r['metrics'])
        d['supportedReleaseWithinPointOne'] = any(e['poseRadiusMetres'] == 0 and e['reportedPoint'] is not None and e['sourceErrorMetres'] <= .1 for e in r['summary']['errors'])
        assert all(type(d[k]) is bool for k in binary)
        metrics[r['spec']['index']] = d
    def stat(values):
        x = np.asarray(values, dtype=float)
        assert x.shape == (32,) and np.isfinite(x).all()
        lo, hi = np.quantile(x[draws].mean(axis=1), [.025, .975])
        return dict(mean=float(x.mean()), bootstrapPercentile95=[float(lo), float(hi)], empiricalIntervalDegenerate=bool(lo == hi))
    groups = {}
    arms = []
    for scale in scales:
        for field in ['si-continuous', 'si-pulse', 'blank']:
            for method, policy in ARMS:
                rows = sorted([r for r in primary if (r['spec']['responseScale'], r['spec']['field'], r['spec']['method'], r['spec']['policy']) == (scale, field, method, policy)], key=lambda r:r['spec']['worldIndex'])
                assert [r['spec']['worldIndex'] for r in rows] == list(range(32))
                groups[scale, field, method, policy] = rows
                bs = {}
                for k in binary:
                    n = sum(metrics[r['spec']['index']][k] for r in rows)
                    bs[k] = dict(successes=n, n=32, proportion=n/32, wilson95=wilson(n, 32))
                errors = [e['sourceErrorMetres'] for r in rows for e in r['summary']['errors'] if e['poseRadiusMetres'] == 0 and e['reportedPoint'] is not None]
                arms.append(dict(responseScale=scale, field=field, method=method, policy=policy, binary=bs,
                                 continuous={k:stat([metrics[r['spec']['index']][k] for r in rows]) for k in CONTINUOUS},
                                 conditionalReleaseErrorsMetres=errors, conditionalErrorCount=len(errors)))
    def contrast(a, b):
        return {k:stat([float(metrics[y['spec']['index']][k])-float(metrics[x['spec']['index']][k]) for x,y in zip(a,b)]) for k in binary+CONTINUOUS}
    scheduling = [dict(responseScale=s, field=f, direction='gated minus periodic', metrics=contrast(groups[s,f,'quad-sniff-refine','reference'], groups[s,f,'quad-sniff-refine','encounter-gated'])) for s in scales for f in ['si-continuous','si-pulse','blank']]
    response = [dict(field=f, method=m, policy=p, direction='slower minus nominal', metrics=contrast(groups[1,f,m,p],groups[2,f,m,p])) for f in ['si-continuous','si-pulse','blank'] for m,p in ARMS] if scales == [1,2] else []
    return dict(independentWorlds=32, primaryMissions=len(primary), bootstrapSeed=282991, bootstrapReplicates=10000, arms=arms, schedulingContrasts=scheduling, responseContrasts=response,
                limitations='Paired-world numerical replication, not powered or canonical superiority, field validation or physical leak confirmation. Conditional errors exclude unresolved reports; support and release tolerance are separate endpoints.')
