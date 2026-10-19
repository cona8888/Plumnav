"""Independent v4 terminal-decision audit using frozen Stage 1n math checks."""
import importlib.util
from pathlib import Path
import math
import numpy as np

spec=importlib.util.spec_from_file_location('frozen_stage1n_math',Path(__file__).parents[1]/'audit-stage1n-candidate.py')
math_audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(math_audit)
envelope=math_audit.envelope
aggregate=math_audit.aggregate
matrix=math_audit.matrix
gradient_operator=math_audit.gradient_operator
operator_norm=math_audit.operator_norm
transformed_row_bounds=math_audit.transformed_row_bounds
value_bounds=math_audit.value_bounds


def check_decision(visits,saved,pose_metres,heading_span):
    assert saved['version']=='bounded-pose-v4'
    if heading_span>1e-9:
        assert saved['status']=='abstained' and saved['reason']=='unresolved-within-dwell-orientation'
        return {'maximumNumericDifference':0.,'windows':0,'pairs':0}
    r=pose_metres/.1;key='decision';maximum=0.;windows=pairs=0
    def close(actual,expected,where):
        nonlocal maximum
        if actual is None or expected is None:
            assert actual is expected,where
            return
        diff=float(np.max(np.abs(np.asarray(actual)-np.asarray(expected))))
        assert math.isfinite(diff) and diff<=1e-9,(where,diff)
        maximum=max(maximum,diff)
    def check_envelope(saved,wanted,where):
        assert saved['admitted']==wanted['admitted'] and saved['rank']==wanted['rank']
        for k in wanted:
            if k not in ['admitted','rank','reason','basisTransform']:
                close(saved[k],wanted[k],where+'/'+k)
    values=np.array([np.median([s['value'] for s in w['samples']]) for w in visits])
    early=None
    if not all(s['telemetryComplete'] for w in visits for s in w['samples']):early='missing-channel-telemetry'
    elif any(s['clipped'] for w in visits for s in w['samples']):early='clipped-required-measurement'
    elif any(values[k]<.16 or sum(s['hit'] for s in visits[k]['samples'])<2 for k in range(0,17,2)):early='insufficient-signal'
    if early:
        assert saved['reason']==early and saved['status']=='abstained';return {'maximumNumericDifference':maximum,'windows':0,'pairs':0}
    xy=np.array([[np.mean([s[a] for s in w['samples']]) for a in ('x','y')] for w in visits]);full=envelope(xy,values,r,saved['geometry']);check_envelope(saved['geometry'],full,key+'/geometry');dwell=[]
    for k,w in enumerate(visits):
        coords=np.array([[s['x'],s['y']] for s in w['samples']]);diameter=max(np.linalg.norm(x-y) for x in coords for y in coords);distance=diameter+2*r
        spread=max(s['value'] for s in w['samples'])-min(s['value'] for s in w['samples']);tolerance=max(.003,.05*min(s['value'] for s in w['samples']))
        sw=saved['dwell']['windows'][k];close(sw['possibleDistanceUpper'],distance,key+'/distance')
        if distance==0:change=0.;gradient=0.
        elif not full['admitted'] or full['rmseUpper']>.003:
            assert sw['state']=='indeterminate';dwell.append('indeterminate');windows+=1;continue
        else:
            b=np.array(full['coefficients']);h=np.array([[b[3],b[4]],[b[4],b[5]]]);centre=np.mean(coords,axis=0);reach=max(np.linalg.norm(p-centre) for p in coords)+r
            gradient=np.linalg.norm(gradient_operator(centre)@b)+operator_norm(gradient_operator(centre)@np.array(full['basisTransform']))*full['whitenedCoefficientRadius']+(full['hessianNorm']+full['hessianRadius'])*reach;change=gradient*distance
        state='pass' if spread+change<=tolerance else 'reject' if spread-change>tolerance else 'indeterminate'
        close(sw['spatialChangeUpper'],change,key+'/spatial-change');close(sw['gradientUpper'],gradient,key+'/gradient');assert sw['state']==state
        dwell.append(state);windows+=1
    a=matrix(xy);cross=[]
    for k,left in enumerate(range(0,15,2)):
        right=left+2;training=[n for n in range(17) if n not in (left,right)];sp=saved['crossfit']['pairs'][k];m=envelope(xy[training],values[training],r,sp['envelope']);check_envelope(sp['envelope'],m,key+f'/pair/{k}')
        if not m['admitted'] or m['rmseUpper']>.003:state='indeterminate'
        else:
            x=a[training];difference=a[left]-a[right];weights=difference@np.linalg.solve(x.T@x,x.T);correction=float(weights@values[training]);t=np.array(m['basisTransform']);eta=sum(transformed_row_bounds(xy[[left,right]],r,t));dn=np.linalg.norm(difference@t)
            coordinate=(dn+eta)*m['whitenedCoefficientRadius']+sum(value_bounds(xy[[left,right]],r,np.array(m['coefficients'])))
            ep=m['whitenedMatrixErrorUpper'];s=m['whitenedSigmaLower'];weight_bound=eta/s+dn*(ep/s+ep/s**2);noise=.003*(sum(abs(weights))+math.sqrt(15)*weight_bound)
            residual=abs(values[left]-values[right]-correction);tol=max(.003,.05*min(values[left],values[right]));total=coordinate+noise
            state='pass' if residual+total<=tol else 'reject' if residual-total>tol else 'indeterminate'
            for field,value in [('correction',correction),('coordinateAllowance',coordinate),('trainingAllowance',noise),('totalAllowance',total),('residual',residual),('tolerance',tol),('whitenedDifferenceNorm',dn),('whitenedDifferenceErrorUpper',eta),('weightChangeUpper',weight_bound)]:close(sp[field],value,key+'/'+field)
        assert sp['state']==state;cross.append(state);pairs+=1
    temporal=aggregate([aggregate(dwell),aggregate(cross)])
    checks=[(temporal!='reject','measurement-inconsistency'),(temporal!='indeterminate','bounded-temporal-indeterminate'),(full['admitted'],'coordinate-rank-uncertain'),
            (full.get('rmseUpper',math.inf)<=.003,'coordinate-fit-indeterminate'),(full.get('eigenMaxUpper',math.inf)<-.006,'coordinate-curvature-indeterminate'),
            (full.get('peakNormUpper') is not None and full['peakNormUpper']<=1,'coordinate-peak-indeterminate')]
    reason=next((name for ok,name in checks if not ok),'bounded-local-quadratic-supported')
    assert saved['reason']==reason and (saved['status']=='supported')==(reason=='bounded-local-quadratic-supported')
    assert saved['dwell']['state']==aggregate(dwell) and saved['crossfit']['state']==aggregate(cross)
    if saved['status']=='supported':
        close(saved['relativePeakRadiusMetres'],full['peakRadius']*.1,key+'/relative-radius');close(saved['mapPeakRadiusMetres'],full['peakRadius']*.1,key+'/map-radius')
    return {'maximumNumericDifference':maximum,'windows':windows,'pairs':pairs}
