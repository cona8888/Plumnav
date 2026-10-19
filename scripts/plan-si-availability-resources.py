"""Pure planning from timing/size receipts; never reads a raw mission or outcome."""
import argparse
from datetime import datetime,timezone
import hashlib
import itertools
import json
import math
from pathlib import Path
import shutil
import statistics

ROOTS=[
 Path('research/results/si_readout_four_arm_refinement_v1_attempt01_2026-09-24'),
 Path('research/results/si_readout_source_admission_v1_attempt01_2026-09-24'),
 Path('research/results/si_scan_disabled_mission_admission_v1_attempt01_2026-09-24')]
ALPHA=.05;K=4;Z=1.959963984540054
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def width(n,r,k=K):return r*math.sqrt(math.log(2*k/ALPHA)/(2*n))
def required(h,r):return math.ceil(r*r*math.log(2*K/ALPHA)/(2*h*h))
def interaction(rw,gw,rl,gl):return (gl-rl)-(gw-rw)
def self_test():
    patterns=list(itertools.product((0,1),repeat=4));values=[interaction(*p) for p in patterns]
    assert len(values)==16 and min(values)==-2 and max(values)==2
    assert interaction(0,1,0,1)==0 and interaction(0,0,0,1)==1 and interaction(0,1,0,0)==-1
    assert all(interaction(rw,gw,rl,gl)==-interaction(gw,rw,gl,rl) for rw,gw,rl,gl in patterns)
    assert all(interaction(rw,gw,rl,gl)==-interaction(rl,gl,rw,gw) for rw,gw,rl,gl in patterns)
    assert {gl-ns for gl,ns,unused in itertools.product((0,1),repeat=3)}=={-1,0,1}
    for r in (2,4):
        assert width(64,r)>width(128,r)>width(256,r)>0 and width(64,r)>width(64,r,1)
        for h in (.1,.2):
            n=required(h,r);assert width(n,r)<=h and width(n-1,r)>h
    assert 15*64+30*(64//8)==1200
    return dict(passed=True,factorialPatterns=16,scanContrastPatterns=8,signAndRangeChecks=True,monotonicityAndInverseChecks=True,missionCountChecked=True)
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args();tests=self_test()
    protocol=Path('research/protocols/si_availability_precision_planning_v1_2026-09-24.md')
    inputs={str(protocol):sha(protocol),str(Path(__file__)):sha(Path(__file__))};missions=[];audits=[]
    def load(path):
        inputs[str(path)]=sha(path);return json.loads(path.read_text())
    for root in ROOTS:
        manifest=load(root/'manifest.json')
        for item in manifest['cases']:
            folder=root/item['id'];terminal=folder/'process_terminal.json'
            if item.get('reused'):continue
            t=load(terminal);assert t['exitCode']==0 and not t['timedOut']
            c=load(folder/'run/complete.json')
            # Read only performance/resource keys; do not retain or use scientific endpoints.
            seconds=t['elapsedSeconds'];size=c['bytes'];rss=c.get('terminalRssBytes',c.get('maxRssBytes'))
            assert math.isfinite(seconds) and seconds>0 and isinstance(size,int) and size>0
            missions.append(dict(caseId=item['id'],root=str(root),seconds=seconds,bytes=size,terminalRssBytes=rss))
            audit_file=folder/'audit_terminal.json'
            if audit_file.exists():
                t=load(audit_file);assert t['exitCode']==0 and not t['timedOut']
                audits.append(dict(caseId=item['id'],root=str(root),seconds=t['elapsedSeconds']))
    assert len(missions)==40 and audits
    worst_mission=max(missions,key=lambda r:r['seconds']);worst_audit=max(audits,key=lambda r:r['seconds']);largest=max(missions,key=lambda r:r['bytes'])
    free=shutil.disk_usage(Path.cwd()).free;reserve=10*1024**3;options=[]
    for n in (64,128,256):
        witnesses=n//8;primary=15*n;extra=30*witnesses;histories=primary+extra
        hours=1.5*histories*(worst_mission['seconds']+worst_audit['seconds'])/3600
        storage=math.ceil(1.5*histories*largest['bytes'])
        options.append(dict(independentWorlds=n,conditionsPerWorld=3,arms=5,primaryHistories=primary,witnessWorlds=witnesses,extraRefinementHistories=extra,totalHistories=histories,
          precision={name:dict(range=r,marginalWorstVarianceNormalHalfWidth=Z*r/(2*math.sqrt(n)),simultaneousHoeffdingHalfWidth=width(n,r)) for name,r in [('interaction',4),('scanValue',2)]},
          sequentialPlanningHours=hours,unvalidatedFourWorkerIdealHours=hours/4,durationStressSequentialHours=2*hours,rawStoragePlanningBytes=storage,rawStoragePlanningGiB=storage/1024**3,durationStressRawGiB=2*storage/1024**3,fitsCurrentDiskWith10GiBReserve=storage+reserve<=free))
    a.output.mkdir(parents=True,exist_ok=False)
    def write(name,value):
        with (a.output/name).open('x') as f:json.dump(value,f,indent=2);f.write('\n')
    write('manifest.json',dict(createdAt=datetime.now(timezone.utc).isoformat(),planningOnly=True,sourceFiles=[dict(path=p,sha256=h) for p,h in sorted(inputs.items())],hypotheticalN=[64,128,256],alpha=ALPHA,primaryContrastCount=K,noRawHistoriesRead=True,noOutcomeVarianceEstimated=True))
    result=dict(planningOnly=True,selfTests=tests,resourceInputs=dict(missionReceipts=len(missions),auditReceipts=len(audits),missionMaximum=worst_mission,auditMaximum=worst_audit,largestCompressedHistory=largest,missionMedianSeconds=statistics.median(r['seconds'] for r in missions),auditMedianSeconds=statistics.median(r['seconds'] for r in audits),freeDiskBytes=free,reserveBytes=reserve,terminalRssNotPeak=True),
      options=options,inversePrecision=[dict(contrast=name,range=r,halfWidth=h,minimumN=required(h,r),guarantee='Hoeffding/union-bound under independent world draws, four contrasts') for name,r in [('interaction',4),('scanValue',2)] for h in (.1,.2)],
      limitations=['No runtime bound or power guarantee','Same-host receipts only; parallel scaling unvalidated','No hardware/model-discrepancy uncertainty included','No fresh seed registry or execution protocol admitted','No AWS or simulation launched'])
    write('planning.json',result)
    for path,h in inputs.items():assert sha(Path(path))==h,path
    write('complete.json',dict(completed=True,createdAt=datetime.now(timezone.utc).isoformat(),manifestSha256=sha(a.output/'manifest.json'),planningSha256=sha(a.output/'planning.json'),allInputsUnchanged=len(inputs),newMissions=0))
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
