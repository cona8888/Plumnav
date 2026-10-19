"""Whole-world paired contrasts on strictly complete compact metadata.

No raw-history verification or automatic scientific claim is performed here.
"""
import hashlib
import math
import numpy as np
from lib.si_release_endpoint_v2 import endpoint

VERSION='paired-availability-statistics-v2'
FIELDS=('si-continuous','si-pulse','blank')
ARMS=('RW','GW','RL','GL','NS')
CONTRASTS=('continuous:I','continuous:D','pulsed:I','pulsed:D')

def paired_statistics(records,world_keys,*,bootstrap_seed,draws=None):
    if not isinstance(world_keys,list) or len(world_keys)<2 or any(type(x) is not str or not x for x in world_keys) or len(set(world_keys))!=len(world_keys):raise ValueError('Explicit unique ordered world keys required')
    if type(bootstrap_seed) is not int or not 0<=bootstrap_seed<2**32:raise ValueError('Unsigned integer bootstrap seed required')
    if not isinstance(records,list):raise ValueError('Endpoint records must be a list')
    wanted={(w,f,a) for w in world_keys for f in FIELDS for a in ARMS};index={}
    for row in records:
        if type(row) is not dict or set(row)!={'worldKey','field','arm','endpoint'}:raise ValueError('Exact record keys required')
        if any(type(row[k]) is not str for k in ('worldKey','field','arm')):raise ValueError('String row identity required')
        key=(row['worldKey'],row['field'],row['arm'])
        if key not in wanted or key in index:raise ValueError('Unexpected or duplicate paired row')
        state=endpoint(row['endpoint'])
        if row['endpoint']['field']!=row['field']:raise ValueError('Mismatched endpoint field')
        index[key]=state
    if set(index)!=wanted:raise ValueError('Incomplete paired world block')
    n=len(world_keys);vectors=[]
    for world in world_keys:
        values=[]
        for field in FIELDS[:2]:
            y={a:int(index[world,field,a]['success']) for a in ARMS}
            values.extend(((y['GL']-y['RL'])-(y['GW']-y['RW']),y['GL']-y['NS']))
        vectors.append(values)
    x=np.asarray(vectors,dtype=np.int64)
    if draws is None:
        indices=np.random.Generator(np.random.PCG64(bootstrap_seed)).integers(0,n,size=(10000,n),dtype=np.int64)
        sampling='PCG64-whole-world';used_seed=bootstrap_seed
    else:
        indices=np.asarray(draws)
        if indices.ndim!=2 or indices.shape[0]<2 or indices.shape[1]!=n or indices.dtype.kind not in 'iu':raise ValueError('Invalid resampling matrix')
        if np.any(indices<0) or np.any(indices>=n):raise ValueError('Resampling index outside world registry')
        indices=indices.astype(np.int64);sampling='explicit-fixture-draws';used_seed=None
    sample_means=x[indices].mean(axis=1)
    quantiles=np.quantile(sample_means,[.025,.975],axis=0,method='linear')
    primary=[]
    for j,name in enumerate(CONTRASTS):
        half_range=2 if j%2==0 else 1
        mean=float(x[:,j].mean());h=2*half_range*math.sqrt(math.log(8/.05)/(2*n))
        interval=[float(quantiles[0,j]),float(quantiles[1,j])]
        primary.append(dict(contrast=name,mean=mean,worldContrasts=x[:,j].tolist(),bootstrapPercentile95=interval,observedWorldContrastsConstant=bool(np.all(x[:,j]==x[0,j])),empiricalIntervalDegenerate=interval[0]==interval[1],conservativeFamily95=[max(-half_range,mean-h),min(half_range,mean+h)],unclippedConservativeHalfWidth=h))
    arms=[]
    for field in FIELDS:
        for arm in ARMS:
            states=[index[w,field,arm] for w in world_keys];categories={}
            for state in states:categories[state['category']]=categories.get(state['category'],0)+1
            successes=sum(s['success'] for s in states) if field!='blank' else None
            arms.append(dict(field=field,arm=arm,n=n,localisationApplicable=field!='blank',successes=successes,proportion=successes/n if successes is not None else None,categories=categories))
    for summary in arms:
        if summary['field']=='blank':
            states=[index[w,'blank',summary['arm']] for w in world_keys]
            for category in ('blank-no-nomination','blank-inspection-incomplete','blank-verifier-abstained','blank-supported-report'):
                summary['categories'].setdefault(category,0)
            summary['blankControls']={name:dict(count=sum(state['blankControls'][name] for state in states),denominator=n,proportion=sum(state['blankControls'][name] for state in states)/n) for name in ('falseNomination','inspectionCompleted','falseReport')}
    raw=indices.astype('<u4').tobytes(order='C')
    return dict(version=VERSION,independentWorlds=n,worldOrder=list(world_keys),primary=primary,arms=arms,bootstrap=dict(method=sampling,seed=used_seed,drawCount=len(indices),quantileMethod='linear',indexEncoding='row-major little-endian uint32',indexSha256=hashlib.sha256(raw).hexdigest(),numpyVersion=np.__version__,drawIndices=indices.tolist(),contrastSampleMeans=sample_means.tolist()),
      scope=dict(metadataBindingVerified=False,realCampaignAdmitted=False,automaticWinnerSelection=False,bootstrapCoverage='approximate marginal; no equivalence from degeneracy',conservativeCoverage='four-contrast family bound conditional on independent bounded numerical world draws',physicalValidation=False))
