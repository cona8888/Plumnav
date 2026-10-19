"""Stage 2d: independent event motion plus the unchanged Stage 2c measurement/decision checks."""
from lib.si_event_motion_audit import reconstruct
import math
import numpy as np
from lib.si_head_motion_audit import EngineRandom, filtered_history, physical_values
from lib.si_v4_decision_audit import check_decision
from lib.si_reported_pose import transform


def point(p):return np.array([p['x'],p['y']],dtype=float)


def audit(record):
    c=record['config'];s=record['spec'];p=c['localInletSampling'];dt=c['fixedDt'];sensor_dt=dt/4
    tr=np.array(record['trace'],dtype=float);nav=record['navigation'];controls=record['controls'];summary=record['summary'];L=c['domainMeters']
    errors={}
    def close(name,a,b,tol):
        error=float(np.max(np.abs(np.asarray(a)-np.asarray(b))))
        errors[name]=max(errors.get(name,0.),error)
        assert math.isfinite(error) and error<=tol,(name,error,tol)
    assert tr.ndim==2 and tr.shape[1]==24 and np.isfinite(tr).all()
    assert tr.shape[0]==round(summary['completedAt']/sensor_dt)+1
    close('clock',tr[:,0],np.arange(len(tr))*sensor_dt,1e-12)
    assert len(nav)==round(summary['completedAt']/dt)+1
    nt=np.array([n['time'] for n in nav]);npos=np.array([point(n['position']) for n in nav]);nh=np.array([n['heading'] for n in nav])
    close('navigationClock',nt,np.arange(len(nav))*dt,1e-12)
    close('start',npos[0],point(c['robotStartPositionOverride']),1e-12)
    close('startHeading',nh[0],math.radians(c['robotStartHeadingDegrees']),1e-12)
    if not record['development']:
        start=EngineRandom(s['startSeed']);source=EngineRandom(s['sourceSeed'])
        close('startSeed',npos[0],[.1+.8*start.next(),.1+.8*start.next()],1e-12)
        close('headingSeed',nh[0],2*math.pi*start.next(),1e-12)
        if s['field']!='blank':close('sourceSeed',point(c['sourcePositionOverride']),[.35+.3*source.next(),.35+.3*source.next()],1e-12)
        else:assert c['targetStatus']=='absent' and 'sourcePositionOverride' not in c
    assert set(record['publicScenario'])=={'robotStart','baseWind','obstacles'}
    assert not record['publicScenario']['obstacles']
    assert 'source' not in record['publicEnvironment'] and 'targetStatus' not in record['publicEnvironment']
    assert record['publicEnvironment']['observationModelVersion']=='integration-no-likelihood-v1'
    assert record['publicEnvironment']['durationSeconds']==1200
    points,modes,valids,scan_count,clearance=reconstruct(record,close)
    # Full independent response and hardware-clock noise, without a reset.
    filtered=filtered_history(tr[:,0],tr[:,12:16],p)
    close('sensorHistory',tr[:,16:20],filtered,1e-9)
    hardware_rows=np.arange(0,len(tr),round(1/sensor_dt));rng=EngineRandom(s['worldSeed']+3000000)
    noise=np.array([[rng.normal() for _ in range(4)] for _ in hardware_rows])*c['sensorNoise']
    readouts=np.clip(filtered[hardware_rows]+noise,0,c['sensorSaturation'])
    close('readoutHistory',tr[:,20:24],readouts[np.minimum((tr[:,0]).astype(int),len(readouts)-1)],1e-9)
    required={round(x['time']/sensor_dt) for v in record['visits'] for x in v['samples']}
    checks=sorted(required|set(range(0,len(tr),round(8/sensor_dt)))|{len(tr)-1})
    if record['development'] and record['development'].get('analyticPeak'):
        delta=(points-point(c['sourcePositionOverride']))*L
        close('fieldInput',tr[:,12:16],.01+np.exp(-np.sum(delta*delta,axis=2)/.18),1e-10);field_checks=4*len(tr)
    elif s['field']=='blank':
        close('fieldInput',tr[:,12:16],0.,1e-12);field_checks=4*len(tr)
    else:
        for i in checks:close('fieldInput',tr[i,12:16],physical_values(points[i],tr[i,0],c,s),1e-10)
        field_checks=4*len(checks)
    # Verify every public measurement/history; no private engine noise can leak.
    observations=[];threshold=.115
    assert len(controls)==round(summary['completedAt']*16)+1
    for i,row in enumerate(controls):
        assert row['time']==i/16
        k=round(row['time']/dt);fine=round(row['time']/sensor_dt);m=row['measurement']
        assert row['decision']==nav[k]['decision']
        close('controlPose',point(row['position']),npos[k],1e-12);close('controlHeading',row['heading'],nh[k],1e-12)
        assert m['valid']==valids[k] and m['sampleMode']==modes[k] and m['time']==row['time']
        values=tr[fine,20:24]
        close('publicScalar',m['concentration'],np.mean(values),1e-12)
        close('publicWind',point(m['wind']),[.02/L,-.02/L*math.cos(math.pi/2)],1e-12)
        close('publicChannels',[r['concentration'] for r in m['localInletReadings']],values,1e-12)
        close('publicInletOffsets',[point(r['effectiveOffset']) for r in m['localInletReadings']],points[fine]-npos[k],1e-12)
        assert [r['channel'] for r in m['localInletReadings']]==['front','left','aft','right']
        assert [r['saturated'] for r in m['localInletReadings']]==[v>=c['sensorSaturation']-1e-9 for v in values]
        hit=valids[k] and (any(values>=threshold) if modes[k]=='quad-passive-return' else np.mean(values)>=threshold)
        assert m['hit']==hit
        if m.get('quadSniff',{}).get('readings'):
            rr=m['quadSniff']['readings'];close('quadReturn',[r['concentration'] for r in rr],values,1e-12)
            assert [r['hit'] for r in rr]==[v>=threshold for v in values]
        if m['valid']:observations.append(dict(**m,position=row['position']))
    assert observations==record['observations']
    # Independent common nominee selection: observed positions only, no truth.
    hits=[o for o in observations if o['time']<=summary['acquisitionBudgetSeconds'] and o['hit'] and o['concentration']>=.16 and not any(r['saturated'] for r in o['localInletReadings'])]
    candidate=None
    for o in sorted(hits,key=lambda h:(-h['concentration'],h['time'])):
        neighbours=[h for h in hits if np.linalg.norm(point(h['position'])-point(o['position']))*L<=.15]
        targets=np.array([point(o['position'])]+[point(o['position'])+.1/L*np.array([math.cos(i*math.pi/4),math.sin(i*math.pi/4)]) for i in range(8)])
        if len(set(h['time'] for h in neighbours))>=3 and np.min(targets)>=clearance and np.max(targets)<=1-clearance:
            candidate=dict(point=o['position'],observationTime=o['time'],concentration=o['concentration'],supportTimes=[h['time'] for h in neighbours]);break
    assert candidate==record['nomination']
    assert not summary['assertedNoLeak'] and not summary['physicalSourceConfirmed']
    encounter=next((o for o in observations if o['hit']),None)
    if encounter:
        assert summary['firstEncounter']['time']==encounter['time']
        close('encounterDistance',summary['firstEncounter']['distanceMetres'],nav[round(encounter['time']/dt)]['distance']*L,1e-10)
    else:assert summary['firstEncounter'] is None
    close('totalDistance',summary['pathLengthMetres'],nav[-1]['distance']*L,1e-10)
    close('airCost',summary['airLitres'],4*p['flowLitresPerMinutePerChannel']*summary['completedAt']/60,1e-12)
    if candidate and s['field']!='blank':close('nominationSourceError',summary['nominationSourceErrorMetres'],np.linalg.norm(point(candidate['point'])-point(c['sourcePositionOverride']))*L,1e-10)
    decision_checks=[]
    if summary['stage']=='inspection-complete':
        assert record['motionContract'] and record['verification'] and summary['retainedSamples']==85
        assert len(record['visits'])==17 and summary['completedAt']==record['visits'][-1]['closedAt']
        for i,v in enumerate(record['visits']):
            assert v['arrivedAt'] is not None and v['closedAt']-v['arrivedAt']==12 and len(v['samples'])==5
            interval=tr[round(v['arrivedAt']/sensor_dt):round(v['closedAt']/sensor_dt)+1]
            assert np.max(np.ptp(interval[:,1:4],axis=0))==0.,('nonstationary',i)
            w=record['motionContract']['windows'][i]
            assert w==dict(visit=i,start=v['arrivedAt'],end=v['closedAt'],translationDiameterMetres=0,orientationSpanRadians=0)
            for j,x in enumerate(v['samples']):
                assert x['time']==v['arrivedAt']+8+j
                r=tr[round(x['time']/sensor_dt)];close('retainedValue',x['value'],np.mean(r[20:24]),1e-12)
                close('retainedPosition',[x['x'],x['y']],(r[1:3]-point(candidate['point']))/(.1/L),1e-12)
                assert x['hit']==(x['value']>=threshold) and x['telemetryComplete'] and x['clipped']==any(r[20:24]>=c['sensorSaturation']-1e-9)
        for arm in record['verification']['arms']:
            radius=arm['poseRadiusMetres'];wanted=transform(record['visits'],dict(model='exact' if radius==0 else 'readout-jitter',amplitudeMetres=radius),600000+s['replicate'])
            for v,original in zip(wanted['visits'],record['visits']):v['target']=original['target']
            assert wanted==arm['observation'] and arm['decision']['admitted']
            decision_checks.append(check_decision(wanted['visits'],arm['decision']['candidate'],radius,0.))
        assert len(summary['errors'])==2
        for arm,reported in zip(record['verification']['arms'],summary['errors']):
            assert reported['poseRadiusMetres']==arm['poseRadiusMetres']
            if arm['decision']['status']=='supported':
                peak=np.array(arm['decision']['candidate']['geometry']['peak'])
                wanted=point(candidate['point'])+.1/L*peak
                close('reportedLocation',point(reported['reportedPoint']),wanted,1e-12)
                close('reportedSourceError',reported['sourceErrorMetres'],np.linalg.norm(wanted-point(c['sourcePositionOverride']))*L,1e-10)
            else:assert reported['reportedPoint'] is None and reported['sourceErrorMetres'] is None
    else:
        assert record['verification'] is None and record['motionContract'] is None
        assert summary['completedAt']==(summary['acquisitionBudgetSeconds'] if candidate is None else 1200)
    if s['field']=='blank':assert candidate is None and record['verification'] is None
    return dict(passed=True,errors=errors,traceRows=len(tr),fieldValuesChecked=field_checks,inletGeometriesChecked=4*len(tr),filteredValuesChecked=4*len(tr),publicMeasurementsChecked=len(controls),navigationStepsChecked=len(nav)-1,scanCount=scan_count,decisionChecks=decision_checks)


def compact(record):
    return dict(spec=record['spec'],summary=record['summary'],nomination=record['nomination'],decisions=[dict(radius=a['poseRadiusMetres'],status=a['decision']['status'],reason=a['decision']['reason']) for a in (record['verification'] or {}).get('arms',[])],
                positions=np.array([point(r['position']) for r in record['controls']]),scalar=np.array([o['measurement']['concentration'] for o in record['controls'] if o['time']==round(o['time'])]))


def compare(triple):
    a,b,c=triple
    n=min(len(b['positions']),len(c['positions']))
    position=float(np.max(np.linalg.norm(b['positions'][:n]-c['positions'][:n],axis=1)))*10
    def scalar_difference(x,y):
        count=min(len(x['scalar']),len(y['scalar']))
        return float(np.max(abs(x['scalar'][:count]-y['scalar'][:count])))
    coarse=scalar_difference(a,b);fine=scalar_difference(b,c)
    stage=len({r['summary']['stage'] for r in triple})==1
    presence=len({r['nomination'] is not None for r in triple})==1
    status=len({tuple(d['status'] for d in r['decisions']) for r in triple})==1
    nomination=float(np.linalg.norm(point(b['nomination']['point'])-point(c['nomination']['point'])))*10 if b['nomination'] and c['nomination'] else 0. if presence else math.inf
    duration=abs(b['summary']['completedAt']-c['summary']['completedAt'])
    gates=dict(stageStable=stage,nominationPresenceStable=presence,supportStatusStable=status,bodyPosition=position<=.01,nominationPosition=nomination<=.01,completionTime=duration<=1,scalarDifference=fine<=.003,scalarContraction=fine<=1e-5 or fine<=.8*coarse)
    return dict(field=a['spec']['field'],method=a['spec']['method'],indices=[r['spec']['index'] for r in triple],gates=gates,passed=all(gates.values()),maximumBodyDifferenceMetres=position,nominationDifferenceMetres=nomination if math.isfinite(nomination) else None,completionDifferenceSeconds=duration,scalarCoarseDifference=coarse,scalarFineDifference=fine)
