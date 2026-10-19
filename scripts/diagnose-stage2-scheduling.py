#!/usr/bin/env python3
"""Post-hoc directional diagnosis; never overrides the frozen experiment gate."""
from concurrent.futures import ProcessPoolExecutor
import gzip
import hashlib
import json
import math
from pathlib import Path
import numpy as np


def sha(b):return hashlib.sha256(b).hexdigest()
def xy(p):return [p['x'],p['y']]


def run(job):
    triple,files=job;records=[]
    for path,digest in files:
        body=Path(path).read_bytes();assert sha(body)==digest;records.append(json.loads(gzip.decompress(body)))
    comparisons=[]
    for ai,bi in [(0,1),(1,2)]:
        a,b=records[ai],records[bi];n=min(len(a['controls']),len(b['controls']));ar=a['controls'][:n];br=b['controls'][:n]
        ap=np.array([xy(r['position']) for r in ar]);bp=np.array([xy(r['position']) for r in br]);ah=np.array([r['heading'] for r in ar]);bh=np.array([r['heading'] for r in br]);L=a['config']['domainMeters']
        angle=abs(np.arctan2(np.sin(ah-bh),np.cos(ah-bh)));k=int(angle.argmax())
        hardware=[i for i,r in enumerate(ar) if int(r['time'])==r['time']]
        av=np.array([[x['concentration'] for x in ar[i]['measurement']['localInletReadings']] for i in hardware]);bv=np.array([[x['concentration'] for x in br[i]['measurement']['localInletReadings']] for i in hardware]);delta=av-bv
        scalar=delta.mean(axis=1);j=int(abs(scalar).argmax());cj,channel=np.unravel_index(abs(delta).argmax(),delta.shape)
        radius=a['config']['localInletSampling']['opposingInletSpacingMetres']/(2*L)
        offsets=np.array([0,-math.pi/2,math.pi,math.pi/2]);ag=ap[:,None,:]+radius*np.stack([np.cos(ah[:,None]+offsets),np.sin(ah[:,None]+offsets)],axis=2);bg=bp[:,None,:]+radius*np.stack([np.cos(bh[:,None]+offsets),np.sin(bh[:,None]+offsets)],axis=2)
        first_tie=None
        for i,(sa,sb) in enumerate(zip(a['segments'],b['segments'])):
            if sa['angularVelocity']*sb['angularVelocity']>=0 or min(sa['turnSeconds'],sb['turnSeconds'])<1/32:continue
            def distance_to_tie(r):
                d=r['decision']['direction'];raw=math.atan2(d['y'],d['x'])-r['heading'];wrapped=math.atan2(math.sin(raw),math.cos(raw));return wrapped,math.pi-abs(wrapped)
            da,ea=distance_to_tie(ar[i]);db,eb=distance_to_tie(br[i])
            if max(abs(ea),abs(eb))<1e-10:
                first_tie=dict(time=ar[i]['time'],phase=ar[i]['decision']['phase'],wrappedCommandsRadians=[da,db],antipodalResidualRadians=[ea,eb],angularRates=[sa['angularVelocity'],sb['angularVelocity']]);break
        comparisons.append(dict(meshPair=[a['spec']['navDt'],b['spec']['navDt']],maximumBodyDifferenceMetres=float(np.linalg.norm(ap-bp,axis=1).max()*L),maximumHeadingDifferenceRadians=float(angle[k]),maximumHeadingTime=ar[k]['time'],maximumLabeledInletDifferenceMetres=float(np.linalg.norm(ag-bg,axis=2).max()*L),
            maximumScalarDifferenceC0=float(abs(scalar[j])),scalarPeakTime=ar[hardware[j]]['time'],scalarPeakStage=ar[hardware[j]]['stage'],channelDifferencesAtScalarPeakC0=delta[j].tolist(),
            maximumChannelDifferenceC0=float(abs(delta[cj,channel])),channelPeakTime=ar[hardware[cj]]['time'],channelIndex=int(channel),firstOppositeAntipodalTurn=first_tie))
    return dict(**triple,directionalComparisons=comparisons)


if __name__=='__main__':
    raw=Path('research/evidence/si_encounter_scheduling_2026-09-17');analysis=Path('research/results/si_encounter_scheduling_2026-09-17');out=Path('research/results/si_scheduling_directional_diagnosis_2026-09-17')
    ab=(analysis/'analysis.json').read_bytes();a=json.loads(ab);done=json.loads((analysis/'complete.json').read_text());assert done['complete'] and a['integrityPassed'] and done['analysisSha256']==sha(ab)
    assert a['manifestSha256']==sha((raw/'manifest.json').read_bytes());inventory={}
    for worker in range(4):
        d=raw/f'worker-{worker}'
        for item in json.loads((d/'complete.json').read_text())['inventory']:inventory[item['index']]=(str(d/item['file']),item['sha256'])
    with ProcessPoolExecutor(max_workers=4) as pool:results=list(pool.map(run,[(t,[inventory[i] for i in t['indices']]) for t in a['triples']]))
    # Analytic counterexample: labeled channels swap, their mean does not.
    angles=np.array([0,-math.pi/2,math.pi,math.pi/2]);r=.05
    channels=lambda theta:1+3*r*np.cos(angles+theta)+2*r*np.sin(angles+theta)
    forward,reverse=channels(0),channels(math.pi)
    assert abs(forward.mean()-reverse.mean())<1e-15 and max(abs(forward-reverse))>.29
    toy=dict(field='C/C0 = 1 + 3*x + 2*y, x/y in metres',inletRadiusMetres=r,headingsRadians=[0,math.pi],channelValues=[forward.tolist(),reverse.tolist()],means=[float(forward.mean()),float(reverse.mean())],maximumLabeledDifferenceC0=float(max(abs(forward-reverse))),meaning='Identical scalar means do not certify directional-sensor equivalence; analytic illustration, not a physical gas validation.')
    result=dict(postHoc=True,doesNotOverrideAcceptance=True,parentAnalysisSha256=sha(ab),comparisons=results,analyticCounterexample=toy)
    out.mkdir();body=(json.dumps(result,indent=2,allow_nan=False)+'\n').encode()
    with (out/'diagnosis.json').open('xb') as f:f.write(body)
    with (out/'complete.json').open('x') as f:json.dump(dict(complete=True,diagnosisSha256=sha(body),sourceSha256=sha(Path(__file__).read_bytes())),f,indent=2)
    print(json.dumps(dict(triplets=len(results),tripletsWithOppositeAntipodalTurn=sum(any(x['firstOppositeAntipodalTurn'] for x in t['directionalComparisons']) for t in results),maxHeadingRadians=max(x['maximumHeadingDifferenceRadians'] for t in results for x in t['directionalComparisons']),maxLabeledInletMetres=max(x['maximumLabeledInletDifferenceMetres'] for t in results for x in t['directionalComparisons']),maxChannelDifferenceC0=max(x['maximumChannelDifferenceC0'] for t in results for x in t['directionalComparisons']),diagnosisSha256=sha(body)),indent=2))
