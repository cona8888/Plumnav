#!/usr/bin/env python3
"""Prospective Stage 1n audit: independent nominal verification and bound trace."""
import argparse,gzip,hashlib,json,math,random
from pathlib import Path
import numpy as np


def sha(b):return hashlib.sha256(b).hexdigest()
def aggregate(states):return 'reject' if 'reject' in states else 'indeterminate' if 'indeterminate' in states else 'pass'
def matrix(p):return np.array([[1,x,y,x*x/2,x*y,y*y/2] for x,y in p])


def row_bounds(p,r):
    return np.array([math.sqrt(r*r+(abs(x)*r+r*r/2)**2+((abs(x)+abs(y))*r+r*r/2)**2+(abs(y)*r+r*r/2)**2) for x,y in p])


def value_bounds(p,r,b):
    h=np.array([[b[3],b[4]],[b[4],b[5]]]);hn=max(abs(np.linalg.eigvalsh(h)))
    return np.array([np.linalg.norm(b[1:3]+h@q)*r+hn*r*r/2 for q in p])


NOMINAL_MAX=0.
BASIS_MAX=0.


def operator_norm(a):
    a=np.asarray(a)
    small=a@a.T if a.shape[0]<=a.shape[1] else a.T@a
    return math.sqrt(max(0.,float(np.linalg.eigvalsh(small)[-1])))


def gradient_operator(p):
    x,y=p
    return np.array([[0,1,0,x,y,0],[0,0,1,0,x,y]],dtype=float)


def transformed_row_bounds(p,r,t):
    quadratic=math.sqrt(3/8)*operator_norm(t[3:])
    return np.array([r*operator_norm(gradient_operator(q)@t)+r*r*quadratic for q in p])


def envelope(p,y,r,nominal):
    global NOMINAL_MAX,BASIS_MAX
    a=matrix(p);gram=a.T@a
    independent=np.linalg.solve(gram,a.T@y)
    singular=np.sqrt(np.maximum(np.linalg.eigvalsh(gram),0))
    difference=max(float(np.max(np.abs(independent-np.array(nominal['coefficients'])))),abs(float(singular[0])-nominal['sigmaMin']))
    NOMINAL_MAX=max(NOMINAL_MAX,difference)
    if difference>1e-10:raise ValueError('Independent nominal fit disagrees')
    # Verify the stored nominal separately; then trace the bound on that nominal.
    b=np.array(nominal['coefficients']);res=y-a@b
    out={'rank':int(np.linalg.matrix_rank(a)),'sigmaMin':float(singular[0]),
         'coefficients':b.tolist(),'rmse':float(np.linalg.norm(res)/math.sqrt(len(y)))}
    if out['rank']!=6 or singular[-1]/singular[0]>1e6:
        return {**out,'admitted':False,'reason':'coordinate-rank-uncertain'}
    # Cholesky whitening is independent of the candidate's Householder QR.
    # All bounds depend on right-orthogonal-invariant norms, not QR signs.
    t=np.linalg.inv(np.linalg.cholesky(gram).T)
    stored=np.array(nominal['basisTransform'])
    basis_error=max(float(np.max(np.abs((a@stored).T@(a@stored)-np.eye(6)))),
                    float(np.max(np.abs(t@t.T-stored@stored.T))))
    BASIS_MAX=max(BASIS_MAX,basis_error)
    if basis_error>1e-10:raise ValueError('Whitening basis failed verification')
    errors=transformed_row_bounds(p,r,t);eps=float(np.linalg.norm(errors));lower=1-eps
    out.update(basisTransform=t.tolist(),whitenedMatrixErrorUpper=eps,whitenedSigmaLower=lower,whitenedRowErrorBounds=errors.tolist())
    if lower<=0:return {**out,'admitted':False,'reason':'coordinate-rank-uncertain'}
    change=float(np.linalg.norm(value_bounds(p,r,b)))
    normal=float(np.linalg.norm((a@t).T@res))
    gamma=(eps*np.linalg.norm(res)+normal)/lower**2+change/lower
    w=np.zeros((3,6));w[0,3]=1.;w[1,4]=math.sqrt(2);w[2,5]=1.
    cr=operator_norm(t)*gamma;hr=operator_norm(w@t)*gamma
    h=np.array([[b[3],b[4]],[b[4],b[5]]])
    eig=(b[3]+b[5]+math.hypot(b[3]-b[5],2*b[4]))/2
    upper=eig+hr
    peak=pr=pu=None
    if upper<-.006:
        peak=-np.linalg.solve(h,b[1:3])
        pr=operator_norm(gradient_operator(peak)@t)*gamma/(-upper)
        pu=np.linalg.norm(peak)+pr
    return {**out,'admitted':True,'whitenedCoefficientRadius':float(gamma),'coefficientRadius':float(cr),
            'hessianRadius':float(hr),'eigenMax':float(eig),'eigenMaxUpper':float(upper),
            'hessianNorm':float(max(abs(np.linalg.eigvalsh(h)))),
            'rmseUpper':float((np.linalg.norm(res)+change)/math.sqrt(len(y))),
            'peak':None if peak is None else peak.tolist(),'peakRadius':None if pr is None else float(pr),
            'peakNormUpper':None if pu is None else float(pu),
            'valueChangeNormUpper':change,'whitenedNormalResidualNorm':normal}


def main():
    if not __debug__:raise RuntimeError('Assertions required')
    ap=argparse.ArgumentParser();ap.add_argument('--raw',type=Path,required=True);ap.add_argument('--analysis',type=Path,required=True);args=ap.parse_args()
    ab=(args.analysis/'analysis.json').read_bytes();analysis=json.loads(ab);complete=json.loads((args.analysis/'complete.json').read_text())
    assert complete['complete'] and complete['analysisSha256']==sha(ab) and complete['summarySha256']==sha((args.analysis/'run-summaries.json').read_bytes())
    assert analysis['rawManifestSha256']==sha((args.raw/'manifest.json').read_bytes())
    lookup={r['index']:r for r in analysis['rawInventory']};seen=set();maximum=0.;errors=[];windows=pairs=coordinates=0
    def close(actual,expected,where):
        nonlocal maximum
        if actual is None or expected is None:
            if actual is not expected:errors.append({'where':where,'error':'null mismatch'})
            return
        diff=float(np.max(np.abs(np.asarray(actual)-np.asarray(expected))));maximum=max(maximum,diff)
        if not math.isfinite(diff) or diff>1e-9:errors.append({'where':where,'difference':diff})
    def check_envelope(saved,wanted,where):
        assert saved['admitted']==wanted['admitted'] and saved['rank']==wanted['rank']
        for k in wanted:
            if k not in ['admitted','rank','reason','basisTransform']:
                # A nearly flat unsupported quadratic can have an ill-conditioned stationary point.
                if k=='peak' and wanted.get('peakRadius') is None:continue
                close(saved[k],wanted[k],where+'/'+k)
    for inv in analysis['variantInventory']:
        i=inv['physicalIndex'];rawitem=lookup[i];raw=(args.raw/rawitem['file']).read_bytes();assert sha(raw)==rawitem['sha256']
        physical=json.loads(gzip.decompress(raw));data=(args.analysis/inv['file']).read_bytes();assert sha(data)==inv['sha256'] and len(data)==inv['bytes']
        block=json.loads(gzip.decompress(data));assert block['physicalSpec']==physical['spec'] and len(block['variants'])==19
        rng=random.Random(1500101+physical['spec']['replicate']);angle=2*math.pi*rng.random();direction=np.array([math.cos(angle),math.sin(angle)])
        points=[]
        for _ in range(102):
            radius=math.sqrt(rng.random());angle=2*math.pi*rng.random();points.append([radius*math.cos(angle),radius*math.sin(angle)])
        visit_errors=np.array(points[:17]);sample_errors=np.array(points[17:]).reshape(17,5,2)
        models=['frame-translation','relative-bias','visit-drift','continuous-drift','visit-error','readout-jitter'];alts=[('exact',0)]+[(m,a) for m in models for a in [.0001,.001,.01]]
        first=physical['visits'][0]['samples'][0]['time'];span=physical['visits'][-1]['samples'][-1]['time']-first
        for j,v in enumerate(block['variants']):
            key=f'{i}/{j}';assert (i,j) not in seen;seen.add((i,j));model,amplitude=alts[j]
            assert (v['model'],v['amplitudeMetres'])==(model,amplitude)
            anchor=amplitude*direction if model=='frame-translation' else np.zeros(2);r=0. if model=='frame-translation' else amplitude/.1
            close(v['anchorErrorMetres'],anchor,key+'/anchor');close(v['unitErrors']['direction'],direction,key+'/direction');close(v['unitErrors']['visits'],visit_errors,key+'/visits');close(v['unitErrors']['samples'],sample_errors,key+'/samples')
            for k,(old,new) in enumerate(zip(physical['visits'],v['visits'])):
                assert old['closedAt']==new['closedAt'] and old['arrivedAt']==new['arrivedAt']
                deltas=[]
                for l,(s,t) in enumerate(zip(old['samples'],new['samples'])):
                    if model=='exact':delta=np.zeros(2)
                    elif model in ['frame-translation','relative-bias']:delta=amplitude*direction
                    elif model=='visit-drift':delta=amplitude*direction*k/16
                    elif model=='continuous-drift':delta=amplitude*direction*(s['time']-first)/span
                    elif model=='visit-error':delta=amplitude*visit_errors[k]
                    else:delta=amplitude*sample_errors[k,l]
                    deltas.append(delta);close(v['worldErrorsMetres'][k][l],delta,key+'/offset')
                    close([t['x'],t['y']],np.array([s['x'],s['y']])+(delta-anchor)/.1,key+'/coordinate')
                    assert {k:x for k,x in s.items() if k not in ('x','y')}=={k:x for k,x in t.items() if k not in ('x','y')};coordinates+=1
                close([new['target'][a] for a in ('x','y')],np.array([old['target'][a] for a in ('x','y')])+np.mean(deltas,axis=0)/100,key+'/target')
            visits=v['visits'];saved=v['v4'];values=np.array([np.median([s['value'] for s in w['samples']]) for w in visits])
            early=None
            if not all(s['telemetryComplete'] for w in visits for s in w['samples']):early='missing-channel-telemetry'
            elif any(s['clipped'] for w in visits for s in w['samples']):early='clipped-required-measurement'
            elif any(values[k]<.16 or sum(s['hit'] for s in visits[k]['samples'])<2 for k in range(0,17,2)):early='insufficient-signal'
            if early:
                assert saved['reason']==early and saved['status']=='abstained';continue
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
                close(saved['relativePeakRadiusMetres'],full['peakRadius']*.1,key+'/relative-radius');close(saved['mapPeakRadiusMetres'],full['peakRadius']*.1+(amplitude if model=='frame-translation' else 0),key+'/map-radius')
    assert seen=={(i,j) for i in range(240) for j in range(19)} and coordinates==387600
    report={'accepted':not errors,'physicalInspections':240,'reportingEvaluations':len(seen),'transformedSamplesChecked':coordinates,'evaluatedDwellWindowsChecked':windows,'evaluatedCrossfitPairsChecked':pairs,
            'maximumNumericDifference':maximum,'independentNominalFitMaxDifference':NOMINAL_MAX,'independentBasisMaxDifference':BASIS_MAX,'errors':errors,'analysisSha256':sha(ab),'rawManifestSha256':analysis['rawManifestSha256'],'auditorSha256':sha(Path(__file__).read_bytes()),
            'method':'Prospectively frozen two-part audit: verify nominal fits by normal equations and whitening by Cholesky, then independently trace bound formulas on the saved nominal coefficients; 1e-10 nominal/basis and 1e-9 derived absolute tolerances.'}
    with (args.analysis/'independent-audit.json').open('x') as handle:handle.write(json.dumps(report,sort_keys=True,indent=2)+'\n')
    print(json.dumps(report,indent=2));raise SystemExit(0 if not errors else 1)


if __name__=='__main__':main()
