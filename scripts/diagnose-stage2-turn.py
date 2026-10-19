#!/usr/bin/env python3
"""Read-only post-hoc divergence tracing; never changes the frozen acceptance."""
import gzip
import hashlib
import json
import math
from pathlib import Path
import numpy as np


def sha(b):return hashlib.sha256(b).hexdigest()
def angle(a,b):return math.atan2(math.sin(a-b),math.cos(a-b))
def direction(row):
    d=row['decision']['direction'];return math.atan2(d['y'],d['x'])
def snapshot(r,i):
    row=r['controls'][i];m=row['measurement']
    return dict(navDt=r['spec']['navDt'],time=row['time'],position=row['position'],heading=row['heading'],stage=row['stage'],decision=row['decision'],scalar=m['concentration'],valid=m['valid'],hit=m['hit'],sampleMode=m['sampleMode'],channels=m['localInletReadings'],segment=r['segments'][i] if i<len(r['segments']) else None)


def main():
    root=Path('research/evidence/si_turn_fresh_2026-09-17');analysis=Path('research/results/si_turn_fresh_2026-09-17');out=Path('research/results/si_turn_divergence_diagnosis_2026-09-17')
    ab=(analysis/'analysis.json').read_bytes();a=json.loads(ab);done=json.loads((analysis/'complete.json').read_text());assert done['complete'] and a['integrityPassed'] and sha(ab)==done['analysisSha256']
    assert a['manifestSha256']==sha((root/'manifest.json').read_bytes());inventory={}
    for w in range(4):
        d=root/f'worker-{w}'
        for item in json.loads((d/'complete.json').read_text())['inventory']:inventory[item['index']]=(d/item['file'],item['sha256'])
    results=[]
    for triple in a['triples']:
        if triple['passed']:continue
        records=[]
        for i in triple['indices']:
            path,digest=inventory[i];b=path.read_bytes();assert sha(b)==digest;records.append(json.loads(gzip.decompress(b)))
        pairs=[]
        for first,second in [(0,1),(1,2)]:
            x,y=records[first],records[second];n=min(len(x['controls']),len(y['controls']));xx=x['controls'][:n];yy=y['controls'][:n]
            dh=np.array([abs(angle(r['heading'],s['heading'])) for r,s in zip(xx,yy)])
            dd=np.array([abs(angle(direction(r),direction(s))) for r,s in zip(xx,yy)])
            scalar=np.array([abs(r['measurement']['concentration']-s['measurement']['concentration']) for r,s in zip(xx,yy)])
            channels=np.array([[u['concentration']-v['concentration'] for u,v in zip(r['measurement']['localInletReadings'],s['measurement']['localInletReadings'])] for r,s in zip(xx,yy)])
            phase=next((i for i,(r,s) in enumerate(zip(xx,yy)) if r['decision']['phase']!=s['decision']['phase']),None)
            scan=lambda r:[dict(time=t['time'],scanId=t['requestedScanId']) for t in r['schedulingTrace'] if t['requestedScanId'] is not None]
            scans=[scan(x),scan(y)];returns=lambda r:[c['time'] for c in r['controls'] if c['measurement']['sampleMode']=='quad-passive-return']
            events={}
            for name,arr in [('heading',dh),('commandDirection',dd),('scalar',scalar)]:
                for threshold in [1e-8,1e-5,.001,.02]:
                    found=np.flatnonzero(arr>threshold)
                    if len(found):
                        i=int(found[0]);events[f'{name}>{threshold}']=dict(difference=float(arr[i]),snapshots=[snapshot(x,i),snapshot(y,i)])
            maximum=int(dh.argmax());opposite_ties=[]
            for i,(p,q) in enumerate(zip(x['segments'],y['segments'])):
                if p['angularVelocity']*q['angularVelocity']<0 and min(p['turnSeconds'],q['turnSeconds'])>1/32 and (p['antipodalTie'] or q['antipodalTie']):opposite_ties.append(xx[i]['time'])
            pairs.append(dict(indices=[x['spec']['index'],y['spec']['index']],scanSchedulesEqual=scans[0]==scans[1],scans=scans,returnClocksEqual=returns(x)==returns(y),firstPhaseDifference=None if phase is None else dict(time=xx[phase]['time'],snapshots=[snapshot(x,phase),snapshot(y,phase)]),firstThresholdCrossings=events,maximumHeading=dict(radians=float(dh[maximum]),snapshots=[snapshot(x,maximum),snapshot(y,maximum)]),maximumChannelC0=float(abs(channels).max()),oppositeResolvedAntipodalTurns=opposite_ties))
        results.append(dict(indices=triple['indices'],worldIndex=triple['worldIndex'],field=triple['field'],method=triple['method'],policy=triple['policy'],comparisons=pairs))
    result=dict(postHoc=True,doesNotOverrideAcceptance=True,parentAnalysisSha256=sha(ab),results=results)
    out.mkdir();body=(json.dumps(result,indent=2,allow_nan=False)+'\n').encode()
    with (out/'diagnosis.json').open('xb') as f:f.write(body)
    with (out/'complete.json').open('x') as f:json.dump(dict(complete=True,diagnosisSha256=sha(body),sourceSha256=sha(Path(__file__).read_bytes())),f,indent=2)
    for result in results:
        for p in result['comparisons']:
            print(json.dumps(dict(indices=p['indices'],scanSchedulesEqual=p['scanSchedulesEqual'],scans=p['scans'],returnClocksEqual=p['returnClocksEqual'],firstPhaseDifference=p['firstPhaseDifference'],firstThresholdTimes={k:dict(time=v['snapshots'][0]['time'],difference=v['difference']) for k,v in p['firstThresholdCrossings'].items()},maxHeadingRadians=p['maximumHeading']['radians'],oppositeResolvedAntipodalTurns=p['oppositeResolvedAntipodalTurns']),indent=2))


if __name__=='__main__':main()
