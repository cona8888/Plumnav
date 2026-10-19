#!/usr/bin/env python3
"""Independent reconstruction of reporting perturbations, fits and v1/v2 decisions.

No imports from the perturbation generator or candidate implementations.
"""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import random
import numpy as np


def sha(data):return hashlib.sha256(data).hexdigest()


def aggregate(states):
    return 'reject' if 'reject' in states else 'indeterminate' if 'indeterminate' in states else 'pass'


def decision(g,rmse,eigen,peak,state):
    reason=next((name for ok,name in [(g['telemetry'],'missing-channel-telemetry'),(not g['clipped'],'clipped-required-measurement'),
        (g['complete'],'insufficient-samples'),(g['core'],'insufficient-signal'),(state!='reject','temporal-inconsistency'),
        (state!='indeterminate','spatiotemporal-indeterminate'),(rmse<=.003,'spatial-model-mismatch'),
        (eigen<-.006,'not-negative-definite'),(peak is not None and np.linalg.norm(peak)<=1,'maximum-outside-probed-region')] if not ok),'local-quadratic-supported')
    return {'reason':reason,'status':'supported' if reason=='local-quadratic-supported' else 'abstained'}


def main():
    p=argparse.ArgumentParser();p.add_argument('--raw',type=Path,required=True);p.add_argument('--analysis',type=Path,required=True);a=p.parse_args()
    if not __debug__:raise RuntimeError('Assertions required')
    ab=(a.analysis/'analysis.json').read_bytes();analysis=json.loads(ab);complete=json.loads((a.analysis/'complete.json').read_text())
    assert complete['complete'] and complete['analysisSha256']==sha(ab)
    assert complete['summarySha256']==sha((a.analysis/'run-summaries.json').read_bytes())
    assert analysis['rawManifestSha256']==sha((a.raw/'manifest.json').read_bytes())
    raw_index={i['index']:i for i in analysis['rawInventory']}
    errors=[];seen=set();windows=pairs=coordinates=0;max_numeric=max_peak=0.
    def close(value,expected,where,tolerance=1e-9):
        nonlocal max_numeric
        difference=float(np.max(np.abs(np.asarray(value)-np.asarray(expected))))
        max_numeric=max(max_numeric,difference)
        if not math.isfinite(difference) or difference>tolerance:
            errors.append({'where':where,'difference':difference})
    models=['frame-translation','relative-bias','visit-drift','continuous-drift','visit-error','readout-jitter'];amplitudes=[.0001,.001,.005,.01,.02]
    expected_alternatives=[('exact',0)]+[(model,amp) for model in models for amp in amplitudes]
    for item in analysis['variantInventory']:
        vi=item['physicalIndex'];raw_item=raw_index[vi];rb=(a.raw/raw_item['file']).read_bytes()
        assert sha(rb)==raw_item['sha256'];physical=json.loads(gzip.decompress(rb))
        vb=(a.analysis/item['file']).read_bytes();assert sha(vb)==item['sha256'] and len(vb)==item['bytes']
        block=json.loads(gzip.decompress(vb));assert block['physicalSpec']==physical['spec'] and len(block['variants'])==31
        rng=random.Random(1300101+physical['spec']['replicate']);theta=rng.random()*2*math.pi
        direction=np.array([math.cos(theta),math.sin(theta)])
        visit_units=[];sample_units=[]
        for _ in range(17+85):
            u=rng.random();v=rng.random();point=[math.sqrt(u)*math.cos(2*math.pi*v),math.sqrt(u)*math.sin(2*math.pi*v)]
            (visit_units if len(visit_units)<17 else sample_units).append(point)
        visit_units=np.array(visit_units);sample_units=np.array(sample_units).reshape(17,5,2)
        first=physical['visits'][0]['samples'][0]['time'];last=physical['visits'][-1]['samples'][-1]['time']
        exact_peak=block['variants'][0]['originalRefit']['peak']
        for alt_index,variant in enumerate(block['variants']):
            key=(vi,alt_index);assert key not in seen;seen.add(key)
            model,amplitude=expected_alternatives[alt_index]
            assert variant['alternativeIndex']==alt_index and (variant['model'],variant['amplitudeMetres'])==(model,amplitude)
            close(variant['unitErrors']['direction'],direction,f'{key}/unit-direction')
            close(variant['unitErrors']['visits'],visit_units,f'{key}/unit-visits')
            close(variant['unitErrors']['samples'],sample_units,f'{key}/unit-samples')
            anchor=amplitude*direction if model=='frame-translation' else np.zeros(2)
            close(variant['anchorErrorMetres'],anchor,f'{key}/anchor')
            visits=variant['visits'];dwell_states=[]
            assert len(visits)==17
            for i,(old,new) in enumerate(zip(physical['visits'],visits)):
                assert old['arrivedAt']==new['arrivedAt'] and old['closedAt']==new['closedAt'] and len(new['samples'])==5
                expected_errors=[]
                for j,(s,t) in enumerate(zip(old['samples'],new['samples'])):
                    if model=='exact':delta=np.zeros(2)
                    elif model in ('frame-translation','relative-bias'):delta=amplitude*direction
                    elif model=='visit-drift':delta=amplitude*direction*(i/16)
                    elif model=='continuous-drift':delta=amplitude*direction*((s['time']-first)/(last-first))
                    elif model=='visit-error':delta=amplitude*visit_units[i]
                    else:delta=amplitude*sample_units[i,j]
                    expected_errors.append(delta)
                    assert np.linalg.norm(delta)<=amplitude+1e-14
                    close(variant['worldErrorsMetres'][i][j],delta,f'{key}/{i}/{j}/error',1e-12)
                    close([t['x'],t['y']],np.array([s['x'],s['y']])+(delta-anchor)/.1,f'{key}/{i}/{j}/coordinates',1e-12)
                    assert {k:v for k,v in s.items() if k not in ('x','y')}=={k:v for k,v in t.items() if k not in ('x','y')}
                    coordinates+=1
                close([new['target'][k] for k in ('x','y')],np.array([old['target'][k] for k in ('x','y')])+np.mean(expected_errors,axis=0)/100,f'{key}/{i}/target',1e-12)
                readings=np.array([s['value'] for s in new['samples']]);positions=np.array([[s['x'],s['y']] for s in new['samples']])
                d=positions[:,None,:]-positions[None,:,:];diameter=float(np.sqrt(np.sum(d*d,axis=2)).max())
                spread=float(np.ptp(readings));allowance=max(.003,.05*float(readings.min()))
                assert np.isfinite(readings).all() and np.all(np.abs(np.diff([s['time'] for s in new['samples']])-1)<=1e-9)
                state='indeterminate' if diameter>1e-9 else 'reject' if spread>allowance else 'pass'
                reason='nonstationary-window' if diameter>1e-9 else 'measurement-window-variation' if spread>allowance else 'window-within-allowance'
                saved=variant['v2']['dwell']['windows'][i]
                for name,value in [('positionDiameterOffsetUnits',diameter),('rangeC0',spread),('allowanceC0',allowance)]:close(saved[name],value,f'{key}/{i}/{name}')
                if saved['state']!=state or saved['reason']!=reason:errors.append({'where':str(key),'error':'dwell decision'})
                dwell_states.append(state);windows+=1
            xy=np.array([[np.mean([s[k] for s in v['samples']]) for k in ('x','y')] for v in visits]);x,y=xy.T
            design=np.column_stack((np.ones(17),x,y,x*x/2,x*y,y*y/2));values=np.array([np.median([s['value'] for s in v['samples']]) for v in visits])
            coeff=np.linalg.solve(design.T@design,design.T@values);rmse=float(np.sqrt(np.mean((design@coeff-values)**2)))
            eigen=float((coeff[3]+coeff[5]+math.hypot(coeff[3]-coeff[5],2*coeff[4]))/2)
            hessian=np.array([[coeff[3],coeff[4]],[coeff[4],coeff[5]]]);peak=-np.linalg.solve(hessian,coeff[1:3]) if abs(np.linalg.det(hessian))>1e-12 else None
            g={'telemetry':all(s['telemetryComplete'] for v in visits for s in v['samples']),
               'clipped':any(s['clipped'] for v in visits for s in v['samples']),
               'complete':all(v['closedAt'] is not None and len(v['samples'])>=2 for v in visits),
               'core':bool(all(values[i]>=.16 and sum(s['hit'] for s in visits[i]['samples'])>=2 for i in range(0,17,2))),
               'stable':bool(all(abs(values[i]-values[i+2])<=max(.003,.05*min(values[i],values[i+2])) for i in range(0,15,2)))}
            saved=variant['originalRefit'];close(saved['coefficients'],coeff,f'{key}/full-fit');close(saved['rmse'],rmse,f'{key}/rmse');close(saved['eigenMax'],eigen,f'{key}/eigen')
            baseline=decision(g,rmse,eigen,peak,'pass' if g['stable'] else 'reject')
            if g!=saved['gates'] or any(saved[k]!=v for k,v in baseline.items()):errors.append({'where':str(key),'error':'original fit decision'})
            pair_states=[]
            for j,left in enumerate(range(0,15,2)):
                right=left+2;training=[k for k in range(17) if k not in (left,right)]
                matrix=design[training];observations=values[training];stored=variant['v2']['crossfit']['pairs'][j]
                singular=np.linalg.svd(matrix,compute_uv=False);rank=int(np.linalg.matrix_rank(matrix));condition=singular[0]/singular[-1]
                if rank!=6 or condition>1e6:state='indeterminate'
                else:
                    inverse=np.linalg.inv(matrix.T@matrix);co=inverse@matrix.T@observations
                    training_rmse=float(np.sqrt(np.mean((matrix@co-observations)**2)))
                    close(stored['trainingRmseC0'],training_rmse,f'{key}/pair/{j}/rmse')
                    if training_rmse>.003:state='indeterminate'
                    else:
                        weights=(design[left]-design[right])@inverse@matrix.T
                        correction=float(weights@observations);bound=.003*float(np.sum(np.abs(weights)))
                        residual=abs(float(values[left]-values[right])-correction);tolerance=max(.003,.05*float(min(values[left],values[right])))
                        state='pass' if residual+bound<=tolerance else 'reject' if residual-bound>tolerance else 'indeterminate'
                        for name,value in [('spatialCorrectionC0',correction),('correctionAllowanceC0',bound),('correctedAbsoluteDifferenceC0',residual),('toleranceC0',tolerance)]:close(stored[name],value,f'{key}/pair/{j}/{name}')
                if stored['state']!=state or stored['rank']!=rank or stored['trainingVisits']!=training or stored['centres']!=[left,right]:errors.append({'where':str(key),'pair':j,'error':'crossfit decision'})
                pair_states.append(state);pairs+=1
            cross=aggregate(pair_states);dwell=aggregate(dwell_states);temporal=aggregate([cross,dwell])
            for version,state in [('v1',cross),('v2',temporal)]:
                d=decision(g,rmse,eigen,peak,state)
                if any(variant[version][k]!=v for k,v in d.items()):errors.append({'where':str(key),'error':version+' decision'})
            if variant['v2']['dwell']['state']!=dwell or variant['v2']['crossfit']['state']!=cross or variant['v2']['temporalState']!=temporal:errors.append({'where':str(key),'error':'aggregate state'})
            assert variant['v1']['temporal']==variant['v2']['crossfit']
            diagnostic=variant['peakDiagnostic']
            if variant['v2']['status']=='supported' and peak is not None:
                diff=float(np.linalg.norm(peak-[saved['peak']['x'],saved['peak']['y']])*.1);max_peak=max(max_peak,diff)
                if diff>1e-8:errors.append({'where':str(key),'error':'supported peak fit','differenceMetres':diff})
            if diagnostic is not None:
                relative=np.array([saved['peak'][k]-exact_peak[k] for k in ('x','y')])*.1;world=relative+anchor
                close(diagnostic['worldPeakDeltaMetres'],world,f'{key}/world-peak')
                close(diagnostic['worldPeakDisplacementMetres'],np.linalg.norm(world),f'{key}/world-displacement')
                close(diagnostic['frameCorrectedPeakDisplacementMetres'],np.linalg.norm(relative),f'{key}/frame-corrected')
    assert seen=={(i,j) for i in range(96) for j in range(31)} and windows==50592 and pairs==23808 and coordinates==252960
    report={'schemaVersion':'stage1l-independent-audit-v1','accepted':not errors,'physicalInspections':96,'reportingEvaluations':len(seen),
        'windowsChecked':windows,'crossfitPairsChecked':pairs,'transformedSamplesChecked':coordinates,'maximumNumericDifference':max_numeric,
        'maximumSupportedPeakDifferenceMetres':max_peak,'errors':errors,'rawManifestSha256':analysis['rawManifestSha256'],'analysisSha256':sha(ab),
        'auditorSha256':sha(Path(__file__).read_bytes()),'method':'Independent seed/coordinate reconstruction, normal-equation fits, direct dwell ranges and normal-equation held-out correction; no candidate/generator imports'}
    with (a.analysis/'independent-audit.json').open('x') as handle:handle.write(json.dumps(report,sort_keys=True,indent=2)+'\n')
    print(json.dumps(report,indent=2));raise SystemExit(0 if not errors else 1)


if __name__=='__main__':main()
