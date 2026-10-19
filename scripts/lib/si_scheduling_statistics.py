"""Predeclared exploratory paired-world summaries; no mesh pseudo-replication."""
import math
import numpy as np

ARMS=[('coverage','reference'),('surge-cast','reference'),('quad-sniff-refine','reference'),('quad-sniff-refine','encounter-gated')]
BINARY=['encounter','nomination','inspectionCompleted','supportedExact','supportedJitter']
CONTINUOUS=['restrictedEncounterSeconds','distanceAtEncounterOrSearchEnd','acquisitionDistanceMetres','scanHeldSeconds','turningSeconds','validReadouts','completedAt','airLitres']


def wilson(successes,n):
    assert n>0 and 0<=successes<=n
    z=1.959963984540054;p=successes/n;den=1+z*z/n
    centre=(p+z*z/(2*n))/den;half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return [max(0.,centre-half),min(1.,centre+half)]


def summarize(records):
    primary=[r for r in records if r['spec']['navDt']==1/16];assert len(primary)==192
    draws=np.random.default_rng(172991).integers(0,16,size=(10000,16));arms=[];contrasts=[]
    def stats(values):
        x=np.array(values,dtype=float);assert len(x)==16 and np.isfinite(x).all()
        low,high=np.quantile(x[draws].mean(axis=1),[.025,.975])
        return dict(mean=float(x.mean()),bootstrapPercentile95=[float(low),float(high)],empiricalIntervalDegenerate=bool(low==high))
    for field in ['si-continuous','si-pulse','blank']:
        groups={}
        for method,policy in ARMS:
            rows=sorted([r for r in primary if r['spec']['field']==field and r['spec']['method']==method and r['spec']['policy']==policy],key=lambda r:r['spec']['worldIndex'])
            assert [r['spec']['worldIndex'] for r in rows]==list(range(16));groups[method,policy]=rows
            binary={key:dict(successes=sum(r['metrics'][key] for r in rows),n=16,proportion=sum(r['metrics'][key] for r in rows)/16,wilson95=wilson(sum(r['metrics'][key] for r in rows),16)) for key in BINARY}
            continuous={key:stats([r['metrics'][key] for r in rows]) for key in CONTINUOUS}
            arms.append(dict(field=field,method=method,policy=policy,independentWorlds=16,binary=binary,continuous=continuous))
        ref=groups['quad-sniff-refine','reference'];gated=groups['quad-sniff-refine','encounter-gated'];paired={}
        for key in BINARY+CONTINUOUS:
            differences=[float(g['metrics'][key])-float(r['metrics'][key]) for r,g in zip(ref,gated)]
            paired[key]=dict(**stats(differences),positiveWorlds=sum(d>0 for d in differences),negativeWorlds=sum(d<0 for d in differences),tiedWorlds=sum(d==0 for d in differences),worldDifferences=differences)
        contrasts.append(dict(field=field,direction='encounter-gated minus original four-channel policy',pairedWorlds=16,metrics=paired))
    return dict(exploratoryOnly=True,independentWorlds=16,primaryMissions=192,bootstrapReplicates=10000,bootstrapSeed=172991,arms=arms,pairedContrasts=contrasts,
                limitations='No formal power/superiority claim. Fields/methods/reporting arms are paired within world. Percentile intervals describe empirical world resampling; degenerate intervals do not exclude unobserved rare effects. Wilson intervals accompany binary rates. Time-to-encounter is min(T,600), with failures censored at 600 s; distance is capped at each route search endpoint, not a common distance censoring threshold.')
