"""Separate Decimal/count audit of planning arithmetic, not a simulation audit."""
import argparse
from datetime import datetime,timezone
from decimal import Decimal,localcontext,ROUND_CEILING
import hashlib
import itertools
import json
from pathlib import Path

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):return json.loads(p.read_text())
def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    m=load(a.input/'manifest.json');r=load(a.input/'planning.json');c=load(a.input/'complete.json')
    assert m['planningOnly'] and r['planningOnly'] and c['completed']
    assert c['manifestSha256']==sha(a.input/'manifest.json') and c['planningSha256']==sha(a.input/'planning.json')
    for source in m['sourceFiles']:assert sha(Path(source['path']))==source['sha256']
    receipts=[Path(f['path']) for f in m['sourceFiles']]
    mission=[load(p) for p in receipts if p.name=='process_terminal.json']
    audit=[load(p) for p in receipts if p.name=='audit_terminal.json']
    completed=[load(p) for p in receipts if p.name=='complete.json']
    assert len(mission)==40 and len(audit)==34 and len(completed)==40
    assert all(t['exitCode']==0 and not t['timedOut'] for t in mission+audit)
    mission_max=max(t['elapsedSeconds'] for t in mission);audit_max=max(t['elapsedSeconds'] for t in audit);largest=max(t['bytes'] for t in completed)
    assert mission_max==r['resourceInputs']['missionMaximum']['seconds'] and audit_max==r['resourceInputs']['auditMaximum']['seconds'] and largest==r['resourceInputs']['largestCompressedHistory']['bytes']
    patterns=[gl+rw-gw-rl for rw,gw,rl,gl in itertools.product([0,1],repeat=4)]
    assert sorted(set(patterns))==[-2,-1,0,1,2]
    def close(value,wanted):assert abs(Decimal(str(value))-wanted)<Decimal('1e-10'),(value,wanted)
    with localcontext() as ctx:
        ctx.prec=60;log=(Decimal(8)/Decimal('.05')).ln()
        for option in r['options']:
            n=option['independentWorlds'];assert n in [64,128,256]
            primary=sum(1 for _ in range(n) for _ in range(3) for _ in range(5))
            extra=sum(2 for _ in range(n//8) for _ in range(3) for _ in range(5));total=primary+extra
            assert option['primaryHistories']==primary and option['extraRefinementHistories']==extra and option['totalHistories']==total
            for name,span in [('interaction',Decimal(4)),('scanValue',Decimal(2))]:
                close(option['precision'][name]['simultaneousHoeffdingHalfWidth'],span*(log/(2*n)).sqrt())
                close(option['precision'][name]['marginalWorstVarianceNormalHalfWidth'],Decimal('1.959963984540054')*span/(2*Decimal(n).sqrt()))
            hours=Decimal('1.5')*total*(Decimal(str(mission_max))+Decimal(str(audit_max)))/3600
            close(option['sequentialPlanningHours'],hours);close(option['unvalidatedFourWorkerIdealHours'],hours/4);close(option['durationStressSequentialHours'],hours*2)
            size=int((Decimal('1.5')*total*largest).to_integral_value(rounding=ROUND_CEILING));assert option['rawStoragePlanningBytes']==size
            assert option['fitsCurrentDiskWith10GiBReserve']==(size+r['resourceInputs']['reserveBytes']<=r['resourceInputs']['freeDiskBytes'])
        for item in r['inversePrecision']:
            span=Decimal(item['range']);h=Decimal(str(item['halfWidth']));n=int((span*span*log/(2*h*h)).to_integral_value(rounding=ROUND_CEILING))
            assert n==item['minimumN'] and span*(log/(2*n)).sqrt()<=h and span*(log/(2*(n-1))).sqrt()>h
    result=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),checkedDesignOptions=len(r['options']),checkedInverseTargets=len(r['inversePrecision']),resourceReceiptCounts=dict(missions=40,audits=34,complete=40),arithmeticMethod='separate Decimal precision 60 and direct tuple enumeration',planningSha256=sha(a.input/'planning.json'),manifestSha256=sha(a.input/'manifest.json'),auditorSha256=sha(Path(__file__)),allInputsUnchanged=True,newMissions=0,scientificOutcomesAnalyzed=False)
    with a.output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result))

if __name__=='__main__':main()
