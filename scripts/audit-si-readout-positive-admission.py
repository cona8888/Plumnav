"""Separate Python reconstruction of positive-fixture clocks, motion and verifier."""
import argparse
import copy
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import time
import numpy as np
from lib.si_stationary_head_contract import evaluate

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def load(path):return json.loads(path.read_text())
def history(path):return json.loads(gzip.decompress(path.read_bytes()))
def normalized(r):
    r=copy.deepcopy(r)
    for k in ['availability','availabilityVersion','availabilityTrace']:r.pop(k,None)
    r['summary']['rpcMilliseconds']=0
    return r

def same_numbers(a,b):
    if type(a) is dict:
        assert a.keys()==b.keys()
        for k in a:same_numbers(a[k],b[k])
    elif type(a) is list:
        assert len(a)==len(b)
        for x,y in zip(a,b):same_numbers(x,y)
    elif type(a) in (int,float) and type(b) in (int,float):
        assert math.isfinite(a) and math.isfinite(b)
        assert math.isclose(a,b,rel_tol=1e-11,abs_tol=1e-12), (a,b)
    else:assert a==b,(a,b)

def audit(r, *, verify=True):
    assert r['development']=={'startAtSource':True,'analyticPeak':True,'acquisitionSeconds':30.0625}
    assert r['spec']['replicate']==3000 and r['spec']['field']=='si-continuous'
    assert r['summary']['stage']=='inspection-complete' and r['summary']['nominationAt']==30.0625
    controls=r['controls'];segments=r['segments'];ledger=r['availabilityTrace'];trace=np.asarray(r['trace'])
    assert len(controls)==len(ledger)==len(segments)+1
    assert len(controls)==int(r['summary']['completedAt']*16)+1
    assert len(trace)==int(r['summary']['completedAt']*256)+1
    assert np.isfinite(trace).all() and np.array_equal(trace[:,0],np.arange(len(trace))/256)
    active=None;last_scan=None;observations=[];drain=0;first_inspection=None;first_encounter=None;first_eligible=None;schedule_index=0
    for i,(row,entry) in enumerate(zip(controls,ledger)):
        t=i/16;m=row['measurement']
        assert row['time']==entry['time']==m['time']==t
        returned=active is not None and t>=active['start']+12 and t.is_integer()
        raw_mode=('quad-passive-return' if returned else 'blanked') if active else 'passive'
        raw_valid=returned if active else t.is_integer()
        assert entry['scanId']==(active['id'] if active else None)
        assert entry['rawMode']==raw_mode and entry['rawValid']==raw_valid
        promoted=r['availability']=='live-passive' and raw_mode=='blanked' and t.is_integer()
        assert m['valid']==entry['effectiveValid']==(raw_valid or promoted)
        assert m['sampleMode']==entry['effectiveMode']==('passive' if promoted else raw_mode)
        values=[c['concentration'] for c in m['localInletReadings']]
        assert values==trace[i*16,-4:].tolist()
        assert math.isclose(m['concentration'],sum(values)/4,abs_tol=1e-15,rel_tol=0)
        expected_hit=(any(v>=.115 for v in values) if returned else sum(values)/4>=.115) if m['valid'] else False
        assert m['hit']==expected_hit
        if m['valid']:
            observations.append({**m,'position':row['position']})
            if m['hit'] and first_encounter is None:first_encounter=t
        if row['stage']=='acquisition':
            gate=r['schedulingTrace'][schedule_index];schedule_index+=1
            eligible=m['valid'] and m['hit'] and m['concentration']>=.115 and m['sampleMode'] in ('passive','quad-passive-return') and len(m['localInletReadings'])==4 and all(not c['saturated'] for c in m['localInletReadings'])
            if eligible and first_eligible is None:first_eligible=t
            assert gate['eligible']==eligible and gate['firstEligibleTime']==first_eligible
            assert gate['latched']==(first_eligible is not None)
            if r['spec']['policy']=='encounter-gated' and first_eligible is None:assert not row['decision'].get('quadSniff')
        if row['stage']=='drain':
            drain+=1;assert raw_mode=='blanked'
            assert t>=r['summary']['nominationAt']
        if row['stage']=='inspection' and first_inspection is None:
            first_inspection=t;assert raw_mode!='blanked'
        accepted=False
        if returned:active=None
        command=row['decision'].get('quadSniff')
        if i<len(segments) and command and active is None and command['scanId']!=last_scan:
            last_scan=command['scanId'];active={'id':last_scan,'start':t};accepted=True
        if i<len(segments):
            seg=segments[i]
            assert seg['held']==(raw_mode=='blanked' or accepted)
            assert seg['start']==t and seg['duration']==1/16
            if seg['held']:
                assert seg['turnSeconds']==seg['moveSeconds']==seg['speed']==0
                assert controls[i+1]['position']==row['position'] and controls[i+1]['heading']==row['heading']
    assert schedule_index==len(r['schedulingTrace'])
    assert observations==r['observations'] and len({o['time'] for o in observations})==len(observations)
    assert first_inspection==r['summary']['inspectionAt'] and first_inspection>=30.0625
    assert first_encounter==r['summary']['firstEncounter']['time']
    # Reconstruct every sub-controller trace pose from its preceding continuous segment.
    maximum_pose_error=0.
    for i,seg in enumerate(segments):
        window=trace[i*16+1:(i+1)*16+1]
        age=window[:,0]-seg['start'];initial=seg['initial']
        travel=seg['speed']*np.minimum(seg['moveSeconds'],np.maximum(0,age-seg['turnSeconds']))
        expected=np.column_stack([initial['position']['x']+seg['direction']['x']*travel,initial['position']['y']+seg['direction']['y']*travel,initial['heading']+seg['angularVelocity']*np.minimum(age,seg['turnSeconds'])])
        maximum_pose_error=max(maximum_pose_error,float(np.max(np.abs(expected-window[:,1:4]))))
    assert maximum_pose_error<=64*sys.float_info.epsilon,maximum_pose_error
    visits=r['visits'];assert len(visits)==17
    assert len(r['motionContract']['windows'])==17
    offset=r['config']['localInletSampling']['inspection']['offsetNormalized'];candidate=r['nomination']['point']
    for k,visit in enumerate(visits):
        begin,end=visit['arrivedAt'],visit['closedAt'];assert end-begin==12
        assert len(visit['samples'])==5 and [s['time'] for s in visit['samples']]==[begin+n for n in range(8,13)]
        a=int(begin*16);b=int(end*16)
        # Each segment is monotone constant-rate turn then translation. Zero
        # active turn/move overlap proves continuous stationarity, not just endpoints.
        for seg in segments[a:b]:
            assert seg['turnSeconds']*abs(seg['angularVelocity'])==0
            assert seg['moveSeconds']*seg['speed']==0
        for sample in visit['samples']:
            row=controls[int(sample['time']*16)];m=row['measurement']
            assert m['valid'] and m['sampleMode']=='passive'
            assert sample['value']==m['concentration'] and sample['hit']==m['hit']
            for axis in ['x','y']:
                assert math.isclose(sample[axis],(row['position'][axis]-candidate[axis])/offset,abs_tol=1e-14,rel_tol=0)
            assert sample['clipped']==any(c['saturated'] for c in m['localInletReadings'])
            assert sample['telemetryComplete'] and len({c['channel'] for c in m['localInletReadings']})==4
        window=r['motionContract']['windows'][k]
        assert window['start']==begin and window['end']==end and window['visit']==k
    assert r['verification']['exactPoseOnly'] and len(r['verification']['arms'])==1
    arm=r['verification']['arms'][0];assert arm['poseRadiusMetres']==0 and arm['observation']['visits']==visits
    if verify:
        recomputed=evaluate(visits,0.,motion_contract=r['motionContract'])
        same_numbers(recomputed,arm['decision'])
        old_spec=importlib.util.spec_from_file_location('pre_fixture_bridge','scripts/si-integration-bridge.py')
        old=importlib.util.module_from_spec(old_spec);old_spec.loader.exec_module(old)
        previous=old.handle({'operation':'verify','visits':visits,'motionContract':r['motionContract'],'reportingReplicate':603000})
        same_numbers(previous['arms'][0]['decision'],arm['decision'])
    return dict(controlRows=len(controls),responseRows=len(trace),drainRows=drain,inspectionAt=first_inspection,retainedSamples=85,maximumPoseReconstructionError=maximum_pose_error,exactDecisionRecomputed=verify,verifierStatus=arm['decision']['status'],verifierReason=arm['decision']['reason'])

def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();start=time.monotonic()
    run=a.input/'run';done=load(run/'complete.json');manifest=load(run/'manifest.json')
    assert load(a.input/'process_terminal.json')['exitCode']==0 and done['completed']
    for row in manifest['sources']:assert sha(Path(row['path']))==row['sha256']
    details=[];live=None
    for item in done['inventory']:
        path=run/item['file'];assert sha(path)==item['sha256'];r=history(path)
        if item['kind']=='candidate':
            result=audit(r);details.append({'file':item['file'],**result})
            if r['availability']=='original-withheld':assert normalized(r)==normalized(history(run/f"{r['spec']['policy']}-parent.json.gz"))
            if r['availability']=='live-passive' and r['spec']['policy']=='reference':live=r
    assert len(details)==4 and any(d['drainRows']>0 for d in details)
    def reject(change):
        r=copy.deepcopy(live);change(r)
        try:audit(r,verify=False)
        except AssertionError:return
        raise AssertionError('Corruption escaped audit')
    reject(lambda r:r['summary'].update(inspectionAt=r['summary']['nominationAt']))
    first=int(live['visits'][0]['arrivedAt']*16)
    reject(lambda r:r['segments'][first].update(moveSeconds=1/16,speed=.01))
    reject(lambda r:r['visits'][0]['samples'][0].update(value=99))
    selected=next(i for i,e in enumerate(live['availabilityTrace']) if e['rawMode']=='blanked' and e['effectiveValid'])
    reject(lambda r:r['availabilityTrace'][selected].update(rawMode='passive'))
    result=dict(version='positive-readout-audit-v1',createdAt=datetime.now(timezone.utc).isoformat(),acceptedFor='analytic development fixture, exact-pose reporting only',elapsedSeconds=time.monotonic()-start,manifestSha256=sha(run/'manifest.json'),completeSha256=sha(run/'complete.json'),auditorSha256=sha(Path(__file__)),details=details,originalParentReferences=2,negativeMutationsRejected=4,full600SecondAcquisition=False,changedTrajectoryConvergence=False,reportingJitterAdmitted=False,performanceCampaign=False,physicalValidation=False)
    with a.output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
