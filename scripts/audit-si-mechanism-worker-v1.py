"""Independent new-history audit plus byte-pinned existing-record equivalence."""
import argparse
import copy
import gzip
import hashlib
import json
from pathlib import Path
import time
from lib.si_mechanism_registry_v1 import Registry
from lib.si_absent_report_full_audit_v1 import audit

ROOT=Path(__file__).resolve().parents[1]
PARENT=ROOT/'research/results/si_absent_report_full_audit_v1_attempt01_2026-09-24/execution_manifest.json'
PARENT_SHA='24a9dd7ddd66f70906cf36803a141152121b46071c4a3d40b056493bb4dbcdf5'


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):return json.loads(p.read_text())
def canonical(record):
    record['summary']['rpcMilliseconds']=0
    if record['verification'] is not None:
        record['verification']={key:record['verification'][key] for key in ('exactPoseOnly','arms')}
    return record


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--slot',type=int,choices=(0,1),required=True);a=p.parse_args()
    start=time.monotonic();out=a.root;manifest=out/'development_manifest.json';registry=Registry(manifest,sha(manifest));case=registry.document['cases'][a.slot]
    assert sha(PARENT)==PARENT_SHA
    oldkey='timing-gated-live' if a.slot==0 else 'blank-scan-disabled-n64'
    files=load(PARENT)['cases'][oldkey]['files']
    for row in files.values():assert sha(ROOT/row['path'])==row['sha256']
    history=out/f'case-{a.slot}/mission.json.gz';completion=load(out/f'case-{a.slot}/complete.json');terminal=load(out/f'mission-{a.slot}_terminal.json')
    assert completion['completed'] is True and completion['case']==case and completion['parentManifestSha256']==sha(manifest)
    assert terminal['exitCode']==0 and terminal['timedOut'] is False and completion['historySha256']==sha(history)
    record=json.loads(gzip.decompress(history.read_bytes()));assert record['spec']==case['spec'] and record['development'] is None
    assert completion['replay']['passed'] is True and completion['replay']['privateFieldQueries']==0
    assert completion['stage']==record['summary']['stage'] and completion['completedAt']==record['summary']['completedAt']
    if a.slot==0:
        v=record['verification'];assert completion['verifierCalls']==1
        assert v['version']=='mechanism-exact-v1' and v['manifestSha256']==sha(manifest)
        assert v['context']==dict(caseId=case['id'],worldKey=case['worldKey'],arm='GL',field='si-continuous',reportingReplicate=603000)
    else:assert completion['verifierCalls']==0 and record['verification'] is None
    details,guard=audit(record,scan_disabled=a.slot==1);assert details['passed'] is True
    oldaudit=load(ROOT/files['audit']['path']);assert details==oldaudit['details']
    old=json.loads(gzip.decompress((ROOT/files['history']['path']).read_bytes()))
    assert canonical(copy.deepcopy(record))==canonical(old),'Whole prior record mismatch'
    registry.protect()
    result=dict(passed=True,wholeReferenceMatched=True,exactAuditDetailsMatched=True,caseId=case['id'],elapsedSeconds=time.monotonic()-start,
                historySha256=sha(history),referenceHistorySha256=files['history']['sha256'],parentManifestSha256=sha(manifest),
                details=details,guard=guard,newScientificAudits=1,newFreshMissions=0,physicalValidation=False)
    with (out/f'audit-{a.slot}.json').open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(dict(passed=True,wholeReferenceMatched=True,elapsedSeconds=result['elapsedSeconds'])),flush=True)


if __name__=='__main__':main()
