"""Versioned per-case, existing-parent and refinement admission checks."""
import argparse
from datetime import datetime,timezone
import gzip
import hashlib
import json
from pathlib import Path
import time
from lib.si_scan_disabled_audit import audit,self_test
from lib.si_linear_integration_audit import compact,compare

def load(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,r):
    with p.open('x') as f:json.dump(r,f,indent=2);f.write('\n')
def common(r):
    for key in ('acquisitionMode','scanDisabledVersion','scanDisabledTrace','schedulingTraceRole','schedulingVersion','schedulingTrace','availabilityVersion','availability','availabilityTrace'):r.pop(key,None)
    r['spec'].pop('policy');r['summary']['rpcMilliseconds']=0
    return r

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True)
    mode=p.add_mutually_exclusive_group(required=True);mode.add_argument('--case');mode.add_argument('--triplet');mode.add_argument('--closeout',action='store_true');a=p.parse_args()
    begin=time.monotonic();m=load(a.root/'manifest.json');assert m['version']=='scan-disabled-mission-admission-v1'
    for r in m['sources']:assert sha(Path(r['path']))==r['sha256'],r['path']
    index={x['id']:x for x in m['cases']}
    def record(case):
        item=index[case];folder=a.root/case;done=load(folder/'run/complete.json')
        assert done['completed'] and done['item']==item and done['acquisitionMode']=='scan-disabled'
        assert load(folder/'process_terminal.json')['exitCode']==0
        path=folder/'run/mission.json.gz';assert sha(path)==done['historySha256']
        r=json.loads(gzip.decompress(path.read_bytes()));assert r['spec']==item['spec'] and r['development'] is None
        return r
    if a.case:
        item=index[a.case];r=record(a.case);details=audit(r);matched=False
        if item['spec']['field']=='blank':
            old=m['absentParent'];path=Path(old['historyPath']);ap=Path(old['auditPath'])
            assert sha(path)==old['historySha256'] and sha(ap)==old['auditSha256']
            accepted=load(ap);assert accepted['passed'] and accepted['historySha256']==old['historySha256']
            parent=json.loads(gzip.decompress(path.read_bytes()))
            assert common(r)==common(parent),'Absent common record differs';matched=True
        write(a.root/a.case/'independent_audit.json',dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-begin,caseId=a.case,details=details,exactAbsentParentMatched=matched,historySha256=sha(a.root/a.case/'run/mission.json.gz'),manifestSha256=sha(a.root/'manifest.json'),physicalValidation=False))
        print(f'AUDIT PASS {a.case}; absent parent {matched}',flush=True)
    elif a.triplet:
        assert a.triplet in ('si-continuous','si-pulse')
        ids=[a.triplet+f'-scan-disabled-n{n}' for n in (16,32,64)]
        for case in ids:assert load(a.root/case/'independent_audit.json')['passed']
        result=compare([compact(record(case)) for case in ids]);write(a.root/(a.triplet+'-triplet.json'),dict(field=a.triplet,acquisitionMode='scan-disabled',caseIds=ids,result=result,createdAt=datetime.now(timezone.utc).isoformat(),performanceComparison=False))
        print(json.dumps(result),flush=True)
        if not result['passed']:raise SystemExit(1)
    else:
        assert len(index)==7 and all(x['kind']=='candidate' and x['acquisitionMode']=='scan-disabled' for x in index.values())
        audits=[load(a.root/x/'independent_audit.json') for x in index]
        assert all(x['passed'] for x in audits) and sum(x['exactAbsentParentMatched'] for x in audits)==1
        assert all(load(a.root/(field+'-triplet.json'))['result']['passed'] for field in ('si-continuous','si-pulse'))
        visits=sum(x['details']['scanDisabled']['inspectionPathExercised'] for x in audits)
        write(a.root/'acceptance.json',dict(accepted=True,acceptedFor='scan-disabled acquisition fixed development configuration only',createdAt=datetime.now(timezone.utc).isoformat(),manifestSha256=sha(a.root/'manifest.json'),candidateAudits=7,exactAbsentParentMatches=1,passedTriplets=2,inspectionPathWitnesses=visits,inspectionPathExercised=visits>0,contractFixtures=self_test(),fullPerformanceCampaignAdmitted=False,reportingJitterAdmitted=False,physicalValidation=False))
        print(f'ACCEPTED development; inspection-path witnesses {visits}',flush=True)

if __name__=='__main__':main()
