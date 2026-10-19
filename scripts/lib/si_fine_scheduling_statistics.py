"""Exploratory paired-world estimates at the accepted fine reference only."""
import numpy as np
from lib.si_scheduling_statistics import ARMS, BINARY, CONTINUOUS, wilson

BOOTSTRAP_SEED=182991


def select_primary(records):
    primary=[r for r in records if r['spec']['caseRole']=='primary']
    assert len(primary)==192
    for r in primary:
        assert r['spec']['studyId']=='fine-scheduling-v1' and r['spec']['navDt']==1/64
    wanted={(w,f,m,p) for w in range(16) for f in ['si-continuous','si-pulse','blank'] for m,p in ARMS}
    keys=[(r['spec']['worldIndex'],r['spec']['field'],r['spec']['method'],r['spec']['policy']) for r in primary]
    assert len(set(keys))==192 and set(keys)==wanted
    return primary


def summarize(records):
    primary=select_primary(records)
    draws=np.random.default_rng(BOOTSTRAP_SEED).integers(0,16,size=(10000,16))
    arms=[];contrasts=[]
    def stats(values):
        x=np.asarray(values,dtype=float);assert x.shape==(16,) and np.isfinite(x).all()
        low,high=np.quantile(x[draws].mean(axis=1),[.025,.975])
        return dict(mean=float(x.mean()),bootstrapPercentile95=[float(low),float(high)],empiricalIntervalDegenerate=bool(low==high))
    for field in ['si-continuous','si-pulse','blank']:
        groups={}
        for method,policy in ARMS:
            rows=sorted([r for r in primary if r['spec']['field']==field and r['spec']['method']==method and r['spec']['policy']==policy],key=lambda r:r['spec']['worldIndex'])
            assert [r['spec']['worldIndex'] for r in rows]==list(range(16));groups[method,policy]=rows
            binary={}
            for key in BINARY:
                assert all(type(r['metrics'][key]) is bool for r in rows)
                successes=sum(r['metrics'][key] for r in rows)
                binary[key]=dict(successes=successes,n=16,proportion=successes/16,wilson95=wilson(successes,16))
            arms.append(dict(field=field,method=method,policy=policy,independentWorlds=16,binary=binary,continuous={key:stats([r['metrics'][key] for r in rows]) for key in CONTINUOUS}))
        ref=groups['quad-sniff-refine','reference'];gated=groups['quad-sniff-refine','encounter-gated'];paired={}
        for key in BINARY+CONTINUOUS:
            d=[float(g['metrics'][key])-float(r['metrics'][key]) for r,g in zip(ref,gated)]
            paired[key]=dict(**stats(d),positiveWorlds=sum(x>0 for x in d),negativeWorlds=sum(x<0 for x in d),tiedWorlds=sum(x==0 for x in d),worldDifferences=d)
        contrasts.append(dict(field=field,direction='encounter-gated minus original four-channel policy',pairedWorlds=16,metrics=paired))
    return dict(exploratoryOnly=True,independentWorlds=16,primaryMissions=192,primaryNavigationDt=1/64,primarySensorDt=1/256,bootstrapReplicates=10000,bootstrapSeed=BOOTSTRAP_SEED,arms=arms,pairedContrasts=contrasts,
                limitations='Exploratory, not powered superiority evidence. World is the independent grouping unit; fields, arms, meshes and reporting variants are paired. Time-to-encounter is min(T,600 s), never successful-only. Distance ends at encounter or the route search endpoint, not a common distance threshold. Degenerate empirical bootstrap intervals cannot exclude unobserved effects; binary rates also have Wilson intervals. Integration comparators share a common nomination/verifier and are not complete native literature methods.')
