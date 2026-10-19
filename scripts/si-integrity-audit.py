"""Independent stdlib audit: provenance, event clocks, quadratic fit and sensitivity."""
import gzip, hashlib, json, math, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
STUDY = Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'research/evidence/si_integrity_round1_2026-09-14'
OUT = Path(sys.argv[2]) if len(sys.argv)>2 else ROOT/'research/evidence/si_integrity_round1_audit_2026-09-14'
def read(p): return json.loads(p.read_bytes())
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def close(a,b): assert math.isclose(a,b,rel_tol=1e-9,abs_tol=1e-10),(a,b)
def med(a): return sorted(a)[len(a)//2]
def solve(a,b):
    m=[r[:]+[v] for r,v in zip(a,b)]
    for k in range(len(b)):
        p=max(range(k,len(b)),key=lambda i:abs(m[i][k]));m[k],m[p]=m[p],m[k]
        assert abs(m[k][k])>1e-12
        d=m[k][k];m[k]=[v/d for v in m[k]]
        for i in range(len(b)):
            if i!=k:
                f=m[i][k];m[i]=[x-f*y for x,y in zip(m[i],m[k])]
    return [r[-1] for r in m]
manifest,done=read(STUDY/'manifest.json'),read(STUDY/'complete.json')
assert done['complete'] and done['cases']==44
for e in done['inventory']: assert sha(STUDY/e['file'])==e['sha256']
for e in manifest['sources']:
    assert sha(STUDY/'source-snapshot'/e['file'])==e['sha256']
    assert sha(ROOT/e['file'])==e['sha256']
runs=[];counts={'ticks':0,'valid':0,'retained':0,'clipped':0};max_fit_error=0
for i in range(44):
    r=json.loads(gzip.decompress((STUDY/f'run-{i}.json.gz').read_bytes()));runs.append(r)
    c=r['config'];dt=c['fixedDt'];L=c['domainMeters'];p=c['localInletSampling'];v=r['visits'];trace=r['trace'];row=r['row'];check=r['result'];margin=3*c['sensorNoise'];contract=p['inspection'];centre=c['robotStartPositionOverride'];h=contract['offsetNormalized']
    assert c==manifest['configurations'][i]['config'] and len(trace)==round(600/dt) and len(v)==17
    for j,t in enumerate(trace):
        close(t['time'],j*dt);assert t['decision']['estimate'] is None
        m=t['measurement'];assert m['valid']==(j%round(p['sampleIntervalSeconds']/dt)==0)
        if m['valid']:
            ch=m['localInletReadings'];assert len(ch)==4
            close(m['concentration'],sum(x['concentration'] for x in ch)/4)
            for x in ch: assert x['saturated']==(x['concentration']>=c['sensorSaturation']-1e-9)
            counts['valid']+=1
    counts['ticks']+=len(trace)
    for k,visit in enumerate(v):
        arrival,end=visit['arrivedAt'],visit['closedAt'];assert arrival is not None and end is not None
        assert contract['dwellSeconds']-1e-9<=end-arrival<contract['dwellSeconds']+dt+1e-9
        previous=v[k-1]['closedAt'] if k else -dt
        assert arrival>=previous+dt-1e-9
        expected=[];last=-math.inf
        for t in trace[round(arrival/dt):round(end/dt)+1]:
            assert math.hypot(t['position']['x']-visit['target']['x'],t['position']['y']-visit['target']['y'])<=contract['arrivalRadiusNormalized']+1e-12
            m=t['measurement']
            if t['time']>=arrival+contract['settlingSeconds'] and m['valid'] and t['time']-last>=contract['sampleSpacingSeconds']:
                expected.append(t['time']);last=t['time']
        assert expected==[s['time'] for s in visit['samples']]
        for s in visit['samples']:
            t=trace[round(s['time']/dt)];m=t['measurement'];close(s['value'],m['concentration']);assert s['hit']==m['hit']
            close(s['x'],(t['position']['x']-centre['x'])/h);close(s['y'],(t['position']['y']-centre['y'])/h)
            assert s['clipped']==any(x['saturated'] for x in m['localInletReadings']) and s['telemetryComplete']
            counts['retained']+=1;counts['clipped']+=s['clipped']
    assert all(len(a['samples'])>=2 for a in v)
    y=[med([s['value'] for s in a['samples']]) for a in v];X=[]
    for a in v:
        x=sum(s['x'] for s in a['samples'])/len(a['samples']);z=sum(s['y'] for s in a['samples'])/len(a['samples']);X.append([1,x,z,.5*x*x,x*z,.5*z*z])
    coef=solve([[sum(r[a]*r[b] for r in X) for b in range(6)] for a in range(6)],[sum(r[a]*val for r,val in zip(X,y)) for a in range(6)])
    for a,b in zip(coef,check['coefficients']): close(a,b);max_fit_error=max(max_fit_error,abs(a-b))
    rmse=math.sqrt(sum((sum(a*b for a,b in zip(x,coef))-val)**2 for x,val in zip(X,y))/17);close(rmse,check['rmse'])
    a,gx,gy,xx,xy,yy=coef;ev=(xx+yy+math.hypot(xx-yy,2*xy))/2;close(ev,check['eigenMax']);det=xx*yy-xy*xy
    peak=((xy*gy-yy*gx)/det,(xy*gx-xx*gy)/det) if abs(det)>1e-12 else None
    core=all(y[j]>=.16 and sum(s['hit'] for s in v[j]['samples'])>=2 for j in range(0,17,2))
    stable=all(abs(y[j-1]-y[j+1])<=max(margin,.05*min(y[j-1],y[j+1])) for j in range(1,16,2))
    clipped=any(s['clipped'] for a in v for s in a['samples'])
    reason='clipped-required-measurement' if clipped else 'insufficient-signal' if not core else 'temporal-inconsistency' if not stable else 'spatial-model-mismatch' if rmse>margin else 'not-negative-definite' if ev>=-2*margin else 'maximum-outside-probed-region' if peak is None or math.hypot(*peak)>1 else 'local-quadratic-supported'
    assert reason==check['reason']==row['reason'];assert check['status']==('supported' if reason=='local-quadratic-supported' else 'abstained')
    close(row['completedAt'],v[-1]['closedAt'])
    moves=[math.hypot(t['position']['x']-s['position']['x'],t['position']['y']-s['position']['y'])*L for s,t in zip(trace,trace[1:]) if t['time']<=row['completedAt']]
    path=sum(moves);moving=sum(x>1e-12 for x in moves)*dt
    close(path,row['actual']['pathMetres']);close(moving,row['actual']['movingSeconds']);close(max(moves)/dt,row['actual']['maxStepSpeed']);close(path/moving,row['actual']['meanMovingSpeed']);close(path/row['completedAt'],row['actual']['circuitAverageSpeed'])
comparisons=[]
for field in sorted(set(r['spec']['field'] for r in runs)):
    fine=next(r for r in runs if r['spec']['field']==field and r['spec']['dt']==.0625)
    for r in [r for r in runs if r['spec']['field']==field and r['spec']['seed']==98001 and r['spec']['dt']!=.0625]:
        visits=[]
        for j,(a,b) in enumerate(zip(r['visits'],fine['visits'])):
            aa={s['time'] for s in a['samples']};bb={s['time'] for s in b['samples']}
            visits.append({'visit':j,'arrivalDifference':abs(a['arrivedAt']-b['arrivedAt']),'closureDifference':abs(a['closedAt']-b['closedAt']),'countDifference':abs(len(aa)-len(bb)),'membershipSymmetricDifference':sorted(aa^bb),'medianDifference':abs(r['result']['medians'][j]-fine['result']['medians'][j])})
        circuit=abs(r['row']['completedAt']-fine['row']['completedAt']);coef=max(abs(a-b) for a,b in zip(r['result']['coefficients'],fine['result']['coefficients']))
        gates={'circuit':circuit<=2,'arrival':max(v['arrivalDifference'] for v in visits)<=2,'closure':max(v['closureDifference'] for v in visits)<=2,'count':max(v['countDifference'] for v in visits)<=1,'median':max(v['medianDifference'] for v in visits)<=.003,'coefficients':coef<=.006,'decision':r['result']['reason']==fine['result']['reason']}
        fine_m={t['time']:t['measurement']['concentration'] for t in fine['trace'] if t['measurement']['valid']};diff=[t['measurement']['concentration']-fine_m[t['time']] for t in r['trace'] if t['measurement']['valid']]
        comparisons.append({'field':field,'dt':r['spec']['dt'],'circuitDifference':circuit,'coefficientDifference':coef,'sharedClockRmse':math.sqrt(sum(x*x for x in diff)/len(diff)),'sharedClockMaxDifference':max(map(abs,diff)),'visits':visits,'gates':gates,'pass':all(gates.values())})
OUT.mkdir()
body={'counts':counts,'maxIndependentFitError':max_fit_error,'comparisons':comparisons,'passedComparisons':sum(c['pass'] for c in comparisons),'totalComparisons':len(comparisons)}
(OUT/'audit.json').write_text(json.dumps(body,indent=2)+'\n');(OUT/'si-integrity-audit.py').write_bytes(Path(__file__).read_bytes());(OUT/'complete.json').write_text(json.dumps({'complete':True,'auditSha256':sha(OUT/'audit.json'),'sourceSha256':sha(OUT/'si-integrity-audit.py')})+'\n')
print(json.dumps({k:v for k,v in body.items() if k!='comparisons'}))
