"""Frozen entry point for per-case audit, exact parent agreement and triplets."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import time
from lib.si_linear_integration_audit import compact, compare


def load(p): return json.loads(p.read_text())
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,v):
    with p.open('x') as f: json.dump(v,f,indent=2); f.write('\n')
def normalize(r):
    for k in ('availability','availabilityVersion','availabilityTrace'): r.pop(k,None)
    r['summary']['rpcMilliseconds']=0
    return r


def main():
    p=argparse.ArgumentParser(); p.add_argument('--root',type=Path,required=True)
    mode=p.add_mutually_exclusive_group(required=True); mode.add_argument('--case'); mode.add_argument('--triplet'); mode.add_argument('--closeout',action='store_true')
    a=p.parse_args(); start=time.monotonic(); manifest=load(a.root/'manifest.json')
    for row in manifest['sources']: assert sha(Path(row['path']))==row['sha256'],row['path']
    index={c['id']:c for c in manifest['cases']}
    def record(item):
        if item.get('reused'):
            path=Path(item['historyPath']); assert sha(path)==item['historySha256']
            assert sha(Path(item['auditPath']))==item['auditSha256']
        else:
            folder=a.root/item['id']; done=load(folder/'run/complete.json')
            assert load(folder/'process_terminal.json')['exitCode']==0 and done['completed']
            assert done['item']==item
            path=folder/'run/mission.json.gz'; assert sha(path)==done['historySha256']
        r=json.loads(gzip.decompress(path.read_bytes())); assert r['spec']==item['spec'] and r['development'] is None
        return r
    if a.case:
        item=index[a.case]; assert item['kind']=='candidate' and not item.get('reused')
        module_spec=importlib.util.spec_from_file_location('readout_full_audit','scripts/audit-si-readout-full-history.py')
        module=importlib.util.module_from_spec(module_spec); module_spec.loader.exec_module(module)
        r=record(item); details=module.audit(r); exact_parent=False
        if item['availability']=='original-withheld' and item['spec']['navDt']==1/64:
            parent=record(index[item['spec']['policy']+'-parent-n64'])
            assert normalize(r)==normalize(parent),'Unchanged parent mismatch'; exact_parent=True
        write(a.root/a.case/'independent_audit.json',dict(passed=True,caseId=a.case,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,details=details,exactParentMatched=exact_parent,historySha256=sha(a.root/a.case/'run/mission.json.gz'),manifestSha256=sha(a.root/'manifest.json'),physicalValidation=False))
        print(f'AUDIT PASS {a.case}; exact parent comparison {exact_parent}',flush=True)
    elif a.triplet:
        ids=[a.triplet+f'-n{n}' for n in (16,32,64)]
        records=[]
        for case in ids:
            item=index[case]
            if not item.get('reused'): assert load(a.root/case/'independent_audit.json')['passed']
            records.append(compact(record(item)))
        result=compare(records)
        receipt=dict(version='readout-refinement-triplet-v1',arm=a.triplet,caseIds=ids,createdAt=datetime.now(timezone.utc).isoformat(),result=result,performanceComparison=False)
        write(a.root/(a.triplet+'-triplet.json'),receipt)
        print(json.dumps(receipt),flush=True)
        if not result['passed']: raise SystemExit(1)
    else:
        assert len(index)==14 and sum(bool(x.get('reused')) for x in index.values())==1
        assert sum(x['kind']=='parent' for x in index.values())==2
        audits=[load(a.root/x['id']/'independent_audit.json') for x in index.values() if x['kind']=='candidate' and not x.get('reused')]
        assert len(audits)==11 and all(x['passed'] for x in audits) and sum(x['exactParentMatched'] for x in audits)==2
        triplets=[load(a.root/(policy+'-'+availability+'-triplet.json')) for policy in ('reference','encounter-gated') for availability in ('original-withheld','live-passive')]
        assert len(triplets)==4 and all(x['result']['passed'] for x in triplets)
        reused=next(x for x in index.values() if x.get('reused')); r=record(reused)
        assert r['availability']=='live-passive' and r['summary']['acquisitionBudgetSeconds']==600
        write(a.root/'acceptance.json',dict(accepted=True,acceptedFor='continuous-field four-arm development interface and refinement, exact-pose only',createdAt=datetime.now(timezone.utc).isoformat(),manifestSha256=sha(a.root/'manifest.json'),newCandidateAudits=11,reusedCandidateAudits=1,exactParentMatches=2,passedTriplets=4,fullPerformanceCampaignAdmitted=False,pulsedAbsentAdmission=False,reportingJitterAdmitted=False,physicalValidation=False))
        print('ACCEPTED: four-arm continuous development refinement only',flush=True)


if __name__=='__main__': main()
