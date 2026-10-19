#!/usr/bin/env python3
"""Locate failed descriptor checks without accepting any mission or changing a gate."""
import gzip
import hashlib
import inspect
import json
import math
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor
import numpy as np
from lib.si_event_motion_audit import reconstruct


def run(job):
    index,path,digest=job;body=Path(path).read_bytes();assert hashlib.sha256(body).hexdigest()==digest
    record=json.loads(gzip.decompress(body));mismatches=[];maxima={}
    def close(name,a,b,tol):
        error=float(np.max(abs(np.asarray(a)-np.asarray(b))));assert math.isfinite(error)
        maxima[name]=max(maxima.get(name,0.),error)
        if error>tol:
            frame=inspect.currentframe().f_back;local=frame.f_locals
            mismatches.append(dict(name=name,error=error,tolerance=tol,time=local.get('time'),stored=np.asarray(a).tolist(),reconstructed=np.asarray(b).tolist(),
                storedAngularDisplacement=local['stored']['angularVelocity']*local['stored']['turnSeconds'] if name=='segmentParameters' else None,
                reconstructedAngularDisplacement=local.get('angular',0)*local.get('turn',0) if name=='segmentParameters' else None))
    points,modes,valids,scans,clearance=reconstruct(record,close)
    return dict(index=index,mismatches=mismatches,maximumErrors=maxima)


if __name__=='__main__':
    root=Path('research/evidence/si_event_old_worlds_2026-09-16');out=Path('research/results/si_event_roundoff_diagnosis_2026-09-16');jobs=[]
    for worker in range(4):
        d=root/f'worker-{worker}'
        for item in json.loads((d/'complete.json').read_text())['inventory']:jobs.append((item['index'],str(d/item['file']),item['sha256']))
    with ProcessPoolExecutor(max_workers=4) as pool:results=list(pool.map(run,jobs))
    errors=[e for r in results for e in r['mismatches']]
    summary=dict(descriptiveOnly=True,doesNotAcceptIntegrity=True,runCount=len(results),mismatchCount=len(errors),mismatchNames=sorted(set(e['name'] for e in errors)),
                 maximumOtherParameterDifference=max((max(abs(np.array(e['stored'][1:])-np.array(e['reconstructed'][1:]))) for e in errors if e['name']=='segmentParameters'),default=0),
                 maximumAngularDisplacementDifference=max((abs(e['storedAngularDisplacement']-e['reconstructedAngularDisplacement']) for e in errors if e['name']=='segmentParameters'),default=0),
                 maximumTurnSeconds=max((max(e['stored'][1],e['reconstructed'][1]) for e in errors if e['name']=='segmentParameters'),default=0))
    out.mkdir();body=(json.dumps(dict(summary=summary,runs=results),indent=2,allow_nan=False)+'\n').encode()
    with (out/'diagnosis.json').open('xb') as f:f.write(body)
    with (out/'complete.json').open('x') as f:json.dump(dict(complete=True,diagnosisSha256=hashlib.sha256(body).hexdigest(),sourceSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()),f,indent=2)
    print(json.dumps(summary,indent=2))
