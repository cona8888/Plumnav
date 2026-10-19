#!/usr/bin/env python3
"""Independent raw-data reconstruction; does not import either candidate rule."""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import numpy as np


def combine(states):
    return 'reject' if 'reject' in states else 'indeterminate' if 'indeterminate' in states else 'pass'


def main():
    p=argparse.ArgumentParser();p.add_argument('--raw',type=Path,required=True);p.add_argument('--analysis',type=Path,required=True)
    a=p.parse_args();evaluation_bytes=(a.analysis/'run-evaluations.json').read_bytes()
    lookup={r['spec']['index']:r for r in json.loads(evaluation_bytes)}
    errors=[];seen=set();pairs_checked=windows_checked=0;maximum_difference=0.
    def compare(observed,expected,location):
        nonlocal maximum_difference
        difference=abs(observed-expected);maximum_difference=max(maximum_difference,difference)
        if not math.isfinite(difference) or difference>1e-9:
            errors.append(dict(location=location,difference=difference))
    for worker in sorted(a.raw.glob('worker-*')):
        marker=json.loads((worker/'complete.json').read_text())
        if not marker['complete']:
            raise ValueError('Incomplete worker')
        for item in marker['inventory']:
            raw=(worker/item['file']).read_bytes()
            if hashlib.sha256(raw).hexdigest()!=item['sha256']:
                raise ValueError('Raw checksum mismatch')
            r=json.loads(gzip.decompress(raw));i=r['spec']['index']
            if i in seen:
                raise ValueError('Duplicate index')
            seen.add(i);saved=lookup[i]['v2'];visits=r['visits'];window_states=[];pair_states=[]
            for j,(visit,stored) in enumerate(zip(visits,saved['dwell']['windows'])):
                rows=visit['samples']
                if visit['closedAt'] is None or len(rows)!=5 or not np.isfinite([[s[k] for k in ('time','value','x','y')] for s in rows]).all():
                    state='indeterminate';reason='invalid-window'
                elif not np.all(np.abs(np.diff([s['time'] for s in rows])-1)<=1e-9):
                    state='indeterminate';reason='invalid-clock'
                else:
                    positions=np.array([[s['x'],s['y']] for s in rows]);values=np.array([s['value'] for s in rows])
                    deltas=positions[:,None,:]-positions[None,:,:]
                    diameter=float(np.sqrt(np.sum(deltas*deltas,axis=2)).max())
                    spread=float(np.ptp(values));allowance=max(.003,.05*float(np.min(values)))
                    for key,value in [('positionDiameterOffsetUnits',diameter),('rangeC0',spread),('allowanceC0',allowance)]:
                        compare(value,stored[key],f'{i}/window/{j}/{key}')
                    if diameter>1e-9:
                        state='indeterminate';reason='nonstationary-window'
                    elif spread>allowance:
                        state='reject';reason='measurement-window-variation'
                    else:
                        state='pass';reason='window-within-allowance'
                if stored['visit']!=j or stored['state']!=state or stored['reason']!=reason:
                    errors.append(dict(index=i,window=j,error='dwell decision mismatch'))
                window_states.append(state);windows_checked+=1
            xy=np.array([[np.mean([s[k] for s in v['samples']]) for k in ('x','y')] for v in visits])
            values=np.array([np.median([s['value'] for s in v['samples']]) for v in visits])
            x,y=xy.T;design=np.column_stack((np.ones(17),x,y,x*x/2,x*y,y*y/2))
            for j,left in enumerate(range(0,15,2)):
                right=left+2;training=[k for k in range(17) if k not in (left,right)]
                matrix=design[training];observations=values[training];stored=saved['crossfit']['pairs'][j]
                singular=np.linalg.svd(matrix,compute_uv=False);rank=int(np.linalg.matrix_rank(matrix))
                condition=float(singular[0]/singular[-1]) if singular[-1]>0 else math.inf
                if rank!=6 or condition>1e6:
                    state='indeterminate'
                else:
                    inverse=np.linalg.inv(matrix.T@matrix)
                    coefficients=inverse@matrix.T@observations
                    rmse=float(np.sqrt(np.mean((matrix@coefficients-observations)**2)))
                    compare(rmse,stored['trainingRmseC0'],f'{i}/pair/{j}/rmse')
                    if rmse>.003:
                        state='indeterminate'
                    else:
                        weights=(design[left]-design[right])@inverse@matrix.T
                        correction=float(weights@observations);bound=.003*float(np.sum(np.abs(weights)))
                        residual=abs(float(values[left]-values[right])-correction)
                        tolerance=max(.003,.05*min(float(values[left]),float(values[right])))
                        state='pass' if residual+bound<=tolerance else 'reject' if residual-bound>tolerance else 'indeterminate'
                        for key,value in [('spatialCorrectionC0',correction),('correctionAllowanceC0',bound),('correctedAbsoluteDifferenceC0',residual),('toleranceC0',tolerance)]:
                            compare(value,stored[key],f'{i}/pair/{j}/{key}')
                if stored['trainingVisits']!=training or stored['centres']!=[left,right] or stored['state']!=state or stored['rank']!=rank:
                    errors.append(dict(index=i,pair=j,error='crossfit decision mismatch'))
                pair_states.append(state);pairs_checked+=1
            dwell=combine(window_states);crossfit=combine(pair_states);temporal=combine([dwell,crossfit])
            old=r['result'];g=old['gates'];peak=old['peak']
            reason=next((name for passed,name in [
                (g['telemetry'],'missing-channel-telemetry'),(not g['clipped'],'clipped-required-measurement'),
                (g['complete'],'insufficient-samples'),(g['core'],'insufficient-signal'),
                (temporal!='reject','temporal-inconsistency'),(temporal!='indeterminate','spatiotemporal-indeterminate'),
                (old['rmse'] is not None and old['rmse']<=.003,'spatial-model-mismatch'),
                (old['eigenMax'] is not None and old['eigenMax']<-.006,'not-negative-definite'),
                (peak is not None and math.hypot(peak['x'],peak['y'])<=1,'maximum-outside-probed-region')]
                if not passed),'local-quadratic-supported')
            if saved['dwell']['state']!=dwell or saved['crossfit']['state']!=crossfit or saved['temporalState']!=temporal or saved['reason']!=reason or (saved['status']=='supported')!=(reason=='local-quadratic-supported'):
                errors.append(dict(index=i,error='circuit mismatch'))
    if seen!=set(range(388)) or set(lookup)!=seen or pairs_checked!=3104 or windows_checked!=6596:
        errors.append(dict(error='cardinality'))
    report={'schemaVersion':'stage1k-independent-candidate-audit-v1','accepted':not errors,'records':len(seen),
            'pairsChecked':pairs_checked,'windowsChecked':windows_checked,'maximumNumericDifference':maximum_difference,
            'absoluteTolerance':1e-9,'errors':errors,'method':'NumPy vectorized dwell ranges and pairwise distances; normal-equation spatial-correction reconstruction versus candidate SVD pseudoinverse',
            'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'evaluationSha256':hashlib.sha256(evaluation_bytes).hexdigest(),
            'rawManifestSha256':hashlib.sha256((a.raw/'manifest.json').read_bytes()).hexdigest()}
    with (a.analysis/'independent-candidate-audit.json').open('x') as handle:
        handle.write(json.dumps(report,sort_keys=True,indent=2)+'\n')
    print(json.dumps(report,indent=2));raise SystemExit(0 if not errors else 1)


if __name__=='__main__':
    main()
