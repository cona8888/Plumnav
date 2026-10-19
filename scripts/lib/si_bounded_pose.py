"""Research v3: analytic coordinate-error envelopes for local quadratic fits.

Conditional on the declared scalar, fixed-orientation observation model. Bounds
cover refitted quadratics, not unknown nonquadratic physics or Gaussian coverage.
"""
import math
import numpy as np

MARGIN=.003


def rows(xy):
    x,y=np.asarray(xy,dtype=float).T
    return np.column_stack((np.ones(len(x)),x,y,x*x/2,x*y,y*y/2))


def row_error_bounds(xy,radius):
    x,y=np.abs(np.asarray(xy,dtype=float)).T
    r=np.broadcast_to(np.asarray(radius,dtype=float),x.shape)
    return np.sqrt(r*r+(x*r+r*r/2)**2+((x+y)*r+r*r/2)**2+(y*r+r*r/2)**2)


def value_error_bounds(xy,radius,beta):
    h=np.array([[beta[3],beta[4]],[beta[4],beta[5]]])
    gradients=np.asarray(xy)@h+beta[1:3]
    return np.linalg.norm(gradients,axis=1)*radius+.5*np.linalg.norm(h,2)*np.asarray(radius)**2


def fit_envelope(xy,values,radius):
    xy=np.asarray(xy,dtype=float);y=np.asarray(values,dtype=float);r=np.broadcast_to(np.asarray(radius,dtype=float),(len(y),))
    a=rows(xy);beta,_,rank,singular=np.linalg.lstsq(a,y,rcond=None)
    residual=y-a@beta;errors=row_error_bounds(xy,r);eps=float(np.linalg.norm(errors))
    sigma=float(singular[-1]);s=sigma-eps
    base={'rank':int(rank),'sigmaMin':sigma,'matrixErrorUpper':eps,'sigmaLower':s,
          'coefficients':beta.tolist(),'rmse':float(np.linalg.norm(residual)/math.sqrt(len(y)))}
    if rank!=6 or s<=0 or singular[0]/sigma>1e6:
        return {**base,'admitted':False,'reason':'coordinate-rank-uncertain'}
    b=float(np.linalg.norm(value_error_bounds(xy,r,beta)))
    orthogonality=float(np.linalg.norm(a.T@residual))
    coefficient_bound=(eps*float(np.linalg.norm(residual))+orthogonality)/(s*s)+b/s
    h=np.array([[beta[3],beta[4]],[beta[4],beta[5]]]);hbound=math.sqrt(2)*coefficient_bound
    eigen=float(np.linalg.eigvalsh(h)[-1]);hnorm=float(np.linalg.norm(h,2))
    peak=-np.linalg.solve(h,beta[1:3]) if abs(np.linalg.det(h))>1e-12 else None
    denominator=-eigen-hbound
    peak_radius=(coefficient_bound+hbound*float(np.linalg.norm(peak)))/denominator if peak is not None and denominator>0 else None
    return {**base,'admitted':True,'coefficientRadius':coefficient_bound,'hessianRadius':hbound,
            'eigenMax':eigen,'eigenMaxUpper':eigen+hbound,'hessianNorm':hnorm,
            'rmseUpper':(float(np.linalg.norm(residual))+b)/math.sqrt(len(y)),
            'peak':None if peak is None else peak.tolist(),'peakRadius':peak_radius,
            'peakNormUpper':None if peak_radius is None else float(np.linalg.norm(peak))+peak_radius,
            'rowErrorBounds':errors.tolist(),'valueChangeNormUpper':b,'normalResidualNorm':orthogonality}


def bounded_crossfit(xy,values,radius):
    xy=np.asarray(xy);values=np.asarray(values);r=np.broadcast_to(np.asarray(radius),(17,));a=rows(xy);pairs=[]
    for left in range(0,15,2):
        right=left+2;training=[i for i in range(17) if i not in (left,right)]
        model=fit_envelope(xy[training],values[training],r[training])
        pair={'centres':[left,right],'trainingVisits':training,'envelope':model}
        if not model['admitted'] or model['rmseUpper']>MARGIN:
            pair.update(state='indeterminate',reason='coordinate-correction-unreliable')
        else:
            matrix=a[training];difference=a[left]-a[right];weights=difference@np.linalg.pinv(matrix)
            correction=float(weights@values[training]);eps=model['matrixErrorUpper'];s=model['sigmaLower'];sigma=model['sigmaMin']
            centre_errors=row_error_bounds(xy[[left,right]],r[[left,right]])
            derror=float(sum(centre_errors));dnorm=float(np.linalg.norm(difference))
            value_changes=value_error_bounds(xy[[left,right]],r[[left,right]],np.array(model['coefficients']))
            coordinate_bound=(dnorm+derror)*model['coefficientRadius']+float(sum(value_changes))
            inverse_change=eps/(s*s)+eps/(s*sigma)
            weight_change=derror/s+dnorm*inverse_change
            noise_bound=MARGIN*(float(np.sum(np.abs(weights)))+math.sqrt(15)*weight_change)
            allowance=coordinate_bound+noise_bound
            residual=abs(float(values[left]-values[right])-correction);tolerance=max(MARGIN,.05*float(min(values[left],values[right])))
            state='pass' if residual+allowance<=tolerance else 'reject' if residual-allowance>tolerance else 'indeterminate'
            pair.update(state=state,reason='bounded-coordinate-comparison',correction=correction,
                        coordinateAllowance=coordinate_bound,trainingAllowance=noise_bound,totalAllowance=allowance,
                        residual=residual,tolerance=tolerance)
        pairs.append(pair)
    return {'state':aggregate(p['state'] for p in pairs),'pairs':pairs}


def aggregate(states):
    states=list(states)
    return 'reject' if 'reject' in states else 'indeterminate' if 'indeterminate' in states else 'pass'


def bounded_dwell(visits,model,radius):
    windows=[]
    for i,v in enumerate(visits):
        points=np.array([[s['x'],s['y']] for s in v['samples']]);values=np.array([s['value'] for s in v['samples']])
        differences=points[:,None,:]-points[None,:,:];diameter=float(np.max(np.linalg.norm(differences,axis=2)))
        distance_bound=diameter+2*radius;spread=float(np.ptp(values));tolerance=max(MARGIN,.05*float(values.min()))
        w={'visit':i,'reportedDiameter':diameter,'possibleDistanceUpper':distance_bound,'range':spread,'tolerance':tolerance}
        if distance_bound==0:
            change=0.;gradient=0.
        elif not model['admitted'] or model['rmseUpper']>MARGIN:
            w.update(state='indeterminate',reason='spatial-variation-bound-unavailable');windows.append(w);continue
        else:
            beta=np.array(model['coefficients']);h=np.array([[beta[3],beta[4]],[beta[4],beta[5]]]);centre=np.mean(points,axis=0)
            reach=float(np.max(np.linalg.norm(points-centre,axis=1)))+radius
            gradient=float(np.linalg.norm(beta[1:3]+h@centre))+model['coefficientRadius']+model['hessianRadius']*float(np.linalg.norm(centre))+(model['hessianNorm']+model['hessianRadius'])*reach
            change=gradient*distance_bound
        state='pass' if spread+change<=tolerance else 'reject' if spread-change>tolerance else 'indeterminate'
        w.update(state=state,reason='bounded-model-variation',gradientUpper=gradient,spatialChangeUpper=change)
        windows.append(w)
    return {'state':aggregate(w['state'] for w in windows),'windows':windows}


def evaluate(visits,pose_radius_metres,*,inspection_offset_metres=.1,frame_radius_metres=0.,observation_model=None,dwell_heading_span_radians=None):
    def abstain(reason):return {'status':'abstained','reason':reason,'version':'bounded-pose-v3'}
    if observation_model!='fixed-orientation-local-quadratic':return abstain('unsupported-observation-contract')
    if not isinstance(dwell_heading_span_radians,(int,float)) or not math.isfinite(dwell_heading_span_radians) or not 0<=dwell_heading_span_radians<=1e-9:return abstain('unresolved-within-dwell-orientation')
    if not all(isinstance(v,(int,float)) and math.isfinite(v) for v in [pose_radius_metres,inspection_offset_metres,frame_radius_metres]) or pose_radius_metres<0 or inspection_offset_metres<=0 or frame_radius_metres<0:return abstain('invalid-coordinate-bound')
    if len(visits)!=17 or any(v.get('closedAt') is None or len(v.get('samples',[]))!=5 for v in visits):return abstain('insufficient-samples')
    if any(not math.isfinite(s[k]) for v in visits for s in v['samples'] for k in ('time','value','x','y')):return abstain('nonfinite-input')
    if any(abs(v['samples'][j+1]['time']-v['samples'][j]['time']-1)>1e-9 for v in visits for j in range(4)):return abstain('invalid-sample-clock')
    if not all(s['telemetryComplete'] for v in visits for s in v['samples']):return abstain('missing-channel-telemetry')
    if any(s['clipped'] for v in visits for s in v['samples']):return abstain('clipped-required-measurement')
    xy=np.array([[np.mean([s[k] for s in v['samples']]) for k in ('x','y')] for v in visits]);values=np.array([np.median([s['value'] for s in v['samples']]) for v in visits])
    if any(values[i]<.16 or sum(s['hit'] for s in visits[i]['samples'])<2 for i in range(0,17,2)):return abstain('insufficient-signal')
    radius=pose_radius_metres/inspection_offset_metres;model=fit_envelope(xy,values,radius)
    dwell=bounded_dwell(visits,model,radius);crossfit=bounded_crossfit(xy,values,radius)
    temporal=aggregate([dwell['state'],crossfit['state']])
    checks=[(temporal!='reject','measurement-inconsistency'),(temporal!='indeterminate','bounded-temporal-indeterminate'),
            (model['admitted'],'coordinate-rank-uncertain'),(model.get('rmseUpper',math.inf)<=MARGIN,'coordinate-fit-indeterminate'),
            (model.get('eigenMaxUpper',math.inf)<-.006,'coordinate-curvature-indeterminate'),
            (model.get('peakNormUpper') is not None and model['peakNormUpper']<=1,'coordinate-peak-indeterminate')]
    reason=next((name for ok,name in checks if not ok),'bounded-local-quadratic-supported')
    supported=reason=='bounded-local-quadratic-supported'
    return {'version':'bounded-pose-v3','status':'supported' if supported else 'abstained','reason':reason,'geometry':model,'dwell':dwell,'crossfit':crossfit,
            'poseRadiusMetres':pose_radius_metres,'relativePeakRadiusMetres':model['peakRadius']*inspection_offset_metres if supported else None,
            'mapPeakRadiusMetres':model['peakRadius']*inspection_offset_metres+frame_radius_metres if supported else None,
            'claim':'Conditional robustness of the fitted scalar quadratic to the declared coordinate-error balls; not physical-source confirmation or calibrated probabilistic coverage.'}
