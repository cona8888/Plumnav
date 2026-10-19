#!/usr/bin/env python3
"""Independently verify fresh candidate corrections using normal equations.

Does not import the candidate evaluator. Rank/conditioning are checked before
normal-equation reconstruction; saved bounds and decisions must agree.
"""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import numpy as np


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--raw',type=Path,required=True)
    p.add_argument('--analysis',type=Path,required=True)
    a=p.parse_args()
    evaluations=json.loads((a.analysis/'run-evaluations.json').read_text())
    lookup={r['spec']['index']:r for r in evaluations}
    errors=[];maximum_difference=0.;seen=set();pairs_checked=0;dwell_diagnostics=[]
    for worker in sorted(a.raw.glob('worker-*')):
        marker=json.loads((worker/'complete.json').read_text())
        for item in marker['inventory']:
            raw=(worker/item['file']).read_bytes()
            if hashlib.sha256(raw).hexdigest()!=item['sha256']:
                raise ValueError('Raw checksum mismatch')
            r=json.loads(gzip.decompress(raw));i=r['spec']['index'];seen.add(i)
            saved=lookup[i]['candidate'];visits=r['visits'];states=[]
            if r['spec']['kind']=='baseline':
                windows=[]
                for visit,actual in zip(visits,r['actualSamples']):
                    concentrations=[s['value'] for s in visit['samples']]
                    positions=[[s['position'][k] for k in ('x','y')] for s in actual]
                    windows.append({'concentrationRangeC0':max(concentrations)-min(concentrations),
                        'existingAllowanceC0':max(.003,.05*min(concentrations)),
                        'sampleSpanSeconds':actual[-1]['time']-actual[0]['time'],
                        'positionDiameterMetres':100*max(math.dist(x,y) for x in positions for y in positions)})
                dwell_diagnostics.append({'field':r['spec']['field'],'windows':windows,
                    'exceedingWindows':sum(w['concentrationRangeC0']>w['existingAllowanceC0'] for w in windows)})
            xy=np.array([[np.mean([s[k] for s in v['samples']]) for k in ('x','y')] for v in visits])
            values=np.array([np.median([s['value'] for s in v['samples']]) for v in visits])
            x,y=xy.T
            design=np.column_stack((np.ones(17),x,y,x*x/2,x*y,y*y/2))
            for j,left in enumerate(range(0,15,2)):
                right=left+2;training=[k for k in range(17) if k not in (left,right)]
                matrix=design[training];observations=values[training];pair=saved['temporal']['pairs'][j]
                singular=np.linalg.svd(matrix,compute_uv=False)
                condition=float(singular[0]/singular[-1])
                rank=np.linalg.matrix_rank(matrix)
                if rank!=6 or condition>1e6:
                    state='indeterminate'
                else:
                    inverse=np.linalg.inv(matrix.T@matrix)
                    coefficients=inverse@matrix.T@observations
                    rmse=float(np.sqrt(np.mean((matrix@coefficients-observations)**2)))
                    if rmse>.003:
                        state='indeterminate'
                    else:
                        weights=(design[left]-design[right])@inverse@matrix.T
                        correction=float(weights@observations)
                        bound=.003*float(np.sum(np.abs(weights)))
                        residual=abs(float(values[left]-values[right])-correction)
                        tolerance=max(.003,.05*min(float(values[left]),float(values[right])))
                        state='pass' if residual+bound<=tolerance else 'reject' if residual-bound>tolerance else 'indeterminate'
                        for key,value in [('spatialCorrectionC0',correction),('correctionAllowanceC0',bound),('correctedAbsoluteDifferenceC0',residual),('toleranceC0',tolerance)]:
                            difference=abs(value-pair[key]);maximum_difference=max(maximum_difference,difference)
                            if difference>1e-9:
                                errors.append({'index':i,'pair':j,'quantity':key,'difference':difference})
                if pair['trainingVisits']!=training or pair['centres']!=[left,right] or pair['state']!=state:
                    errors.append({'index':i,'pair':j,'error':'pair mismatch'})
                states.append(state);pairs_checked+=1
            temporal='reject' if 'reject' in states else 'indeterminate' if 'indeterminate' in states else 'pass'
            old=r['result'];g=old['gates'];peak=old['peak']
            reason=next((name for passed,name in [
                (g['telemetry'],'missing-channel-telemetry'),(not g['clipped'],'clipped-required-measurement'),
                (g['complete'],'insufficient-samples'),(g['core'],'insufficient-signal'),
                (temporal!='reject','temporal-inconsistency'),(temporal!='indeterminate','spatiotemporal-indeterminate'),
                (old['rmse'] is not None and old['rmse']<=.003,'spatial-model-mismatch'),
                (old['eigenMax'] is not None and old['eigenMax']<-.006,'not-negative-definite'),
                (peak is not None and math.hypot(peak['x'],peak['y'])<=1,'maximum-outside-probed-region')]
                if not passed),'local-quadratic-supported')
            if saved['temporal']['state']!=temporal or saved['reason']!=reason or (saved['status']=='supported')!=(reason=='local-quadratic-supported'):
                errors.append({'index':i,'error':'circuit mismatch'})
    if seen!=set(range(187)) or set(lookup)!=seen or pairs_checked!=1496:
        errors.append({'error':'cardinality'})
    report={'schemaVersion':'stage1j-independent-candidate-audit-v1','accepted':not errors,'records':len(seen),'pairsChecked':pairs_checked,'maximumCorrectionQuantityDifference':maximum_difference,'absoluteTolerance':1e-9,'method':'Normal-equation reconstruction; candidate implementation uses SVD pseudoinverse','scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'errors':errors,
        'exploratoryWithinDwellBaselineDiagnostics':dwell_diagnostics,
        'diagnosticCaution':'Post-hoc diagnostic, not part of the frozen candidate. Within-dwell variation can reflect field change, sensor memory or noise; it does not uniquely identify plume time variation.'}
    (a.analysis/'independent-candidate-audit.json').write_text(json.dumps(report,indent=2,sort_keys=True)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='exploratoryWithinDwellBaselineDiagnostics'},indent=2))
    raise SystemExit(0 if not errors else 1)


if __name__=='__main__':
    main()
