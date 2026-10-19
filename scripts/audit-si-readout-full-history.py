"""Separate full-history audit for readout development missions, exact-pose only.

The immutable saved record is never rewritten. A shallow raw-clock view is used
only by the existing independent actuator auditor; effective measurements and
eligible observations are audited separately against the reconstructed events.
"""
import argparse
import copy
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import time
import numpy as np
from lib.si_turn_motion_audit import reconstruct, point
from lib.si_head_motion_audit import EngineRandom, physical_values
from lib.si_linear_response_audit import filtered_history
from lib.si_stationary_head_contract import evaluate
from lib.si_v4_decision_audit import check_decision


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p): return json.loads(p.read_text())


def same_numbers(a, b):
    if isinstance(a, dict):
        assert a.keys() == b.keys()
        for k in a: same_numbers(a[k], b[k])
    elif isinstance(a, list):
        assert len(a) == len(b)
        for x, y in zip(a, b): same_numbers(x, y)
    elif type(a) in (int, float) and type(b) in (int, float):
        assert math.isfinite(a) and math.isfinite(b)
        assert math.isclose(a, b, rel_tol=1e-11, abs_tol=1e-12), (a, b)
    else:
        assert a == b, (a, b)


def availability_audit(r):
    c=r['config']; summary=r['summary']; controls=r['controls']; ledger=r['availabilityTrace']
    assert r['availabilityVersion']=='stationary-scan-readout-v1'
    assert r['availability'] in ('original-withheld','live-passive')
    assert len(controls)==len(ledger)==len(r['segments'])+1
    assert summary['acquisitionBudgetSeconds']==600 and summary['nominationAt']==600
    assert r['development'] is None and not summary['assertedNoLeak'] and not summary['physicalSourceConfirmed']
    active=None; last_scan=None; observations=[]; raw_controls=[]; first_inspection=None
    first_eligible=None; schedule_index=0; promoted_count=0; drain=0; scan_count=0
    for i,(row,entry) in enumerate(zip(controls,ledger)):
        t=i/16; m=row['measurement']; due=t.is_integer()
        assert row['time']==entry['time']==m['time']==t
        returned=active is not None and t>=active['start']+12 and due
        raw_mode=('quad-passive-return' if returned else 'blanked') if active else 'passive'
        raw_valid=returned if active else due
        assert entry['scanId']==(active['id'] if active else None)
        assert entry['rawMode']==raw_mode and entry['rawValid']==raw_valid
        promoted=r['availability']=='live-passive' and raw_mode=='blanked' and due
        promoted_count+=int(promoted)
        assert m['valid']==entry['effectiveValid']==(raw_valid or promoted)
        assert m['sampleMode']==entry['effectiveMode']==('passive' if promoted else raw_mode)
        if active:
            q=m['quadSniff']; assert q['scanId']==active['id'] and q['samplingMode']=='passive-array'
            assert q['phase']==('return' if returned else 'aspirate')
        else: assert 'quadSniff' not in m
        if m['valid']: observations.append(dict(**m,position=row['position']))
        if row['stage']=='acquisition':
            assert t<600
            g=r['schedulingTrace'][schedule_index]; schedule_index+=1
            eligible=m['valid'] and m['hit'] and m['concentration']>=.115 and m['sampleMode'] in ('passive','quad-passive-return') and len(m['localInletReadings'])==4 and all(not x['saturated'] for x in m['localInletReadings'])
            if eligible and first_eligible is None: first_eligible=t
            assert g['eligible']==eligible and g['firstEligibleTime']==first_eligible and g['latched']==(first_eligible is not None)
            if r['spec']['policy']=='encounter-gated' and first_eligible is None: assert not row['decision'].get('quadSniff')
        if row['stage']=='drain':
            assert t>=600 and raw_mode=='blanked'; drain+=1
        if row['stage']=='inspection' and first_inspection is None:
            first_inspection=t; assert t>=600 and raw_mode!='blanked'
        raw_controls.append(dict(row,measurement=dict(m,sampleMode=raw_mode,valid=raw_valid)))
        if returned: active=None
        accepted=False; command=row['decision'].get('quadSniff')
        if i<len(r['segments']) and command and active is None and command['scanId']!=last_scan:
            last_scan=command['scanId']; active=dict(id=last_scan,start=t); accepted=True; scan_count+=1
        if i<len(r['segments']):
            seg=r['segments'][i]
            assert seg['held']==(raw_mode=='blanked' or accepted)
            if seg['held']:
                assert seg['turnSeconds']==seg['moveSeconds']==seg['speed']==0
                for k in ('position','heading','distance'): assert controls[i+1][k]==row[k]
    assert observations==r['observations'] and len({o['time'] for o in observations})==len(observations)
    assert schedule_index==len(r['schedulingTrace']) and first_inspection==summary['inspectionAt']
    if r['nomination'] is None:
        assert summary['stage']=='no-eligible-nomination' and summary['completedAt']==600
    else: assert summary['stage'] in ('inspection-complete','mission-budget-exhausted')
    return dict(r,controls=raw_controls),dict(promotedReadouts=promoted_count,drainRows=drain,scanCount=scan_count,inspectionAt=first_inspection)


def audit(r):
    assert r['responseVersion']=='linear-inlet-v1'
    raw,availability=availability_audit(r)
    c=r['config']; s=r['spec']; p=c['localInletSampling']; dt=c['fixedDt']; fine=dt/4; L=c['domainMeters']
    tr=np.asarray(r['trace']); nav=r['navigation']; controls=r['controls']; summary=r['summary']; errors={}
    def close(name,a,b,tolerance):
        error=float(np.max(np.abs(np.asarray(a)-np.asarray(b))))
        assert math.isfinite(error) and error<=tolerance,(name,error,tolerance)
        errors[name]=max(error,errors.get(name,0.))
    assert tr.shape==(round(summary['completedAt']/fine)+1,24) and np.isfinite(tr).all()
    assert len(nav)==round(summary['completedAt']/dt)+1 and len(controls)==round(summary['completedAt']*16)+1
    close('responseClock',tr[:,0],np.arange(len(tr))*fine,1e-12)
    close('navigationClock',[x['time'] for x in nav],np.arange(len(nav))*dt,1e-12)
    start=EngineRandom(s['startSeed']); source=EngineRandom(s['sourceSeed'])
    close('startSeed',point(controls[0]['position']),[.1+.8*start.next(),.1+.8*start.next()],1e-12)
    close('headingSeed',controls[0]['heading'],2*math.pi*start.next(),1e-12)
    if s['field']!='blank': close('sourceSeed',point(c['sourcePositionOverride']),[.35+.3*source.next(),.35+.3*source.next()],1e-12)
    else: assert c['targetStatus']=='absent' and 'sourcePositionOverride' not in c
    assert set(r['publicScenario'])=={'robotStart','baseWind','obstacles'} and not r['publicScenario']['obstacles']
    assert 'source' not in r['publicEnvironment'] and 'targetStatus' not in r['publicEnvironment']
    assert r['publicEnvironment']['observationModelVersion']=='integration-no-likelihood-v1'
    assert r['publicEnvironment']['durationSeconds']==1200
    points,raw_modes,raw_valids,scan_count,clearance=reconstruct(raw,close)
    assert scan_count==availability['scanCount']
    filtered=filtered_history(tr[:,0],tr[:,12:16],p)
    close('fullContinuousResponse',tr[:,16:20],filtered,1e-9)
    hardware=np.arange(0,len(tr),round(1/fine)); rng=EngineRandom(s['worldSeed']+3000000)
    noise=np.array([[rng.normal() for _ in range(4)] for _ in hardware])*c['sensorNoise']
    readout=np.clip(filtered[hardware]+noise,0,c['sensorSaturation'])
    close('fullHardwareReadout',tr[:,20:24],readout[np.minimum(tr[:,0].astype(int),len(readout)-1)],1e-9)
    required={round(x['time']/fine) for v in r['visits'] for x in v['samples']}
    checks=sorted(required|set(range(0,len(tr),round(8/fine)))|{len(tr)-1})
    if s['field']=='blank': close('fieldInput',tr[:,12:16],0.,1e-12); field_count=4*len(tr)
    else:
        for i in checks: close('fieldInput',tr[i,12:16],physical_values(points[i],tr[i,0],c,s),1e-10)
        field_count=4*len(checks)
    for row in controls:
        t=row['time']; k=round(t/dt); j=round(t/fine); m=row['measurement']; values=tr[j,20:24]
        assert row['decision']==nav[k]['decision']
        close('controlPose',point(row['position']),point(nav[k]['position']),1e-12)
        close('publicScalar',m['concentration'],np.mean(values),1e-12)
        close('publicWind',point(m['wind']),[.02/L,-.02/L*math.cos(math.pi/2)],1e-12)
        close('publicChannels',[x['concentration'] for x in m['localInletReadings']],values,1e-12)
        close('publicOffsets',[point(x['effectiveOffset']) for x in m['localInletReadings']],points[j]-point(row['position']),1e-12)
        assert [x['channel'] for x in m['localInletReadings']]==['front','left','aft','right']
        assert [x['saturated'] for x in m['localInletReadings']]==[v>=c['sensorSaturation']-1e-9 for v in values]
        assert m['hit']==(m['valid'] and (any(values>=.115) if m['sampleMode']=='quad-passive-return' else np.mean(values)>=.115))
        if m.get('quadSniff',{}).get('readings'):
            rr=m['quadSniff']['readings']; close('returnValues',[x['concentration'] for x in rr],values,1e-12)
            assert [x['hit'] for x in rr]==[v>=.115 for v in values]
    hits=[o for o in r['observations'] if o['time']<=600 and o['hit'] and o['concentration']>=.16 and not any(x['saturated'] for x in o['localInletReadings'])]
    nominee=None
    for o in sorted(hits,key=lambda x:(-x['concentration'],x['time'])):
        nearby=[h for h in hits if np.linalg.norm(point(h['position'])-point(o['position']))*L<=.15]
        targets=np.array([point(o['position'])]+[point(o['position'])+.1/L*np.array([math.cos(i*math.pi/4),math.sin(i*math.pi/4)]) for i in range(8)])
        if len({h['time'] for h in nearby})>=3 and np.min(targets)>=clearance and np.max(targets)<=1-clearance:
            nominee=dict(point=o['position'],observationTime=o['time'],concentration=o['concentration'],supportTimes=[h['time'] for h in nearby]); break
    assert nominee==r['nomination']
    encounter=next((o for o in r['observations'] if o['hit']),None)
    if encounter:
        assert summary['firstEncounter']['time']==encounter['time']
        close('encounterDistance',summary['firstEncounter']['distanceMetres'],nav[round(encounter['time']/dt)]['distance']*L,1e-10)
    else: assert summary['firstEncounter'] is None
    close('totalDistance',summary['pathLengthMetres'],nav[-1]['distance']*L,1e-10)
    close('airCost',summary['airLitres'],4*p['flowLitresPerMinutePerChannel']*summary['completedAt']/60,1e-12)
    if nominee and s['field']!='blank': close('nominationSourceError',summary['nominationSourceErrorMetres'],np.linalg.norm(point(nominee['point'])-point(c['sourcePositionOverride']))*L,1e-10)
    decision_check=None
    if summary['stage']=='inspection-complete':
        assert len(r['visits'])==17 and summary['retainedSamples']==85 and summary['completedAt']==r['visits'][-1]['closedAt']
        assert len(r['motionContract']['windows'])==17
        for i,v in enumerate(r['visits']):
            begin,end=v['arrivedAt'],v['closedAt']; assert end-begin==12 and len(v['samples'])==5
            for seg in r['segments'][round(begin*16):round(end*16)]:
                assert seg['turnSeconds']*abs(seg['angularVelocity'])==0 and seg['moveSeconds']*seg['speed']==0
            assert r['motionContract']['windows'][i]==dict(visit=i,start=begin,end=end,translationDiameterMetres=0,orientationSpanRadians=0)
            for j,x in enumerate(v['samples']):
                assert x['time']==begin+8+j; row=tr[round(x['time']/fine)]
                close('retainedValue',x['value'],np.mean(row[20:24]),1e-12)
                close('retainedPosition',[x['x'],x['y']],(row[1:3]-point(nominee['point']))/(.1/L),1e-12)
                assert x['hit']==(x['value']>=.115) and x['telemetryComplete'] and x['clipped']==any(row[20:24]>=c['sensorSaturation']-1e-9)
        assert r['verification']['exactPoseOnly'] and len(r['verification']['arms'])==len(summary['errors'])==1
        arm=r['verification']['arms'][0]; assert arm['poseRadiusMetres']==0 and arm['observation']['visits']==r['visits']
        same_numbers(evaluate(r['visits'],0.,motion_contract=r['motionContract']),arm['decision'])
        decision_check=check_decision(r['visits'],arm['decision']['candidate'],0.,0.)
        report=summary['errors'][0]; assert report['poseRadiusMetres']==0
        if arm['decision']['status']=='supported':
            expected=point(nominee['point'])+.1/L*np.array(arm['decision']['candidate']['geometry']['peak'])
            close('reportedPoint',point(report['reportedPoint']),expected,1e-12)
            close('reportedSourceError',report['sourceErrorMetres'],np.linalg.norm(expected-point(c['sourcePositionOverride']))*L,1e-10)
        else: assert report['reportedPoint'] is None and report['sourceErrorMetres'] is None
    else:
        assert r['verification'] is None and r['motionContract'] is None and not summary['errors']
        assert summary['completedAt']==(600 if nominee is None else 1200)
    return dict(passed=True,availability=availability,errors=errors,traceRows=len(tr),publicMeasurements=len(controls),fieldValuesChecked=field_count,filteredValuesChecked=4*len(tr),decisionCheck=decision_check)


def main():
    p=argparse.ArgumentParser(); p.add_argument('--input',type=Path,required=True); p.add_argument('--output',type=Path,required=True); a=p.parse_args(); start=time.monotonic()
    run=a.input/'run'; done=load(run/'complete.json'); manifest=load(run/'manifest.json')
    assert load(a.input/'process_terminal.json')['exitCode']==0 and done['completed']
    for row in manifest['sources']: assert sha(Path(row['path']))==row['sha256']
    path=run/done['file']; assert sha(path)==done['sha256']; r=json.loads(gzip.decompress(path.read_bytes()))
    assert r['spec']==manifest['spec'] and r['development'] is None
    details=audit(r)
    # Fast corruption tests target the NEW availability/drain contract. The full
    # response, geometry and verifier auditors retain their frozen old tests.
    def rejected(change):
        changed=dict(r); change(changed)
        try: availability_audit(changed)
        except AssertionError: return
        raise AssertionError('Corruption escaped availability audit')
    rejected(lambda x:x.update(summary=dict(x['summary'],inspectionAt=600)))
    rejected(lambda x:x.update(observations=x['observations'][:-1]))
    selected=next(i for i,e in enumerate(r['availabilityTrace']) if e['rawMode']=='blanked' and e['effectiveValid'])
    def corrupt_ledger(x):
        x['availabilityTrace']=list(x['availabilityTrace']); x['availabilityTrace'][selected]=dict(x['availabilityTrace'][selected],rawMode='passive')
    rejected(corrupt_ledger)
    def corrupt_hold(x):
        x['segments']=list(x['segments']); x['segments'][selected]=dict(x['segments'][selected],held=False)
    rejected(corrupt_hold)
    sources=[Path(__file__),*[Path('scripts/lib')/f for f in ('si_turn_motion_audit.py','si_head_motion_audit.py','si_linear_response_audit.py','si_stationary_head_contract.py','si_v4_decision_audit.py')]]
    result=dict(version='full-readout-history-audit-v1',createdAt=datetime.now(timezone.utc).isoformat(),acceptedFor='one real-field development mission, exact-pose reporting only',elapsedSeconds=time.monotonic()-start,manifestSha256=sha(run/'manifest.json'),completeSha256=sha(run/'complete.json'),historySha256=sha(path),sources=[dict(path=str(p),sha256=sha(p)) for p in sources],details=details,negativeMutationsRejected=4,changedTrajectoryConvergence=False,reportingJitterAdmitted=False,performanceCampaign=False,physicalValidation=False)
    with a.output.open('x') as f: json.dump(result,f,indent=2); f.write('\n')
    print(json.dumps(result,indent=2))


if __name__=='__main__': main()
