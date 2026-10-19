"""One newly executed derived full audit of a pinned existing development record."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
from lib.si_absent_report_full_audit_v1 import audit
from lib.si_saved_development_binding_v1 import read_pinned, check_chain, same

ROOT=Path(__file__).resolve().parents[1]


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    p=argparse.ArgumentParser();p.add_argument('--manifest',type=Path,required=True);p.add_argument('--case',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    m=json.loads(a.manifest.read_text());entry=m['cases'][a.case];start=time.monotonic()
    for row in m['sources']+m['inputs']:assert sha(ROOT/row['path'])==row['sha256'],row['path']
    files=entry['files'];docs={key:read_pinned(ROOT,row) for key,row in files.items() if key!='history'}
    record,nbytes=read_pinned(ROOT,files['history'],compressed=True)
    if entry['kind']=='scan-disabled':
        parents={key:read_pinned(ROOT,row) for key,row in m['parentFiles'].items()}
        spec=check_chain(a.case,dict(parents,**docs),files['history']['sha256'],nbytes)
        assert same(record['spec'],spec) and record['development'] is None
        assert record['summary']['stage']==docs['completion']['stage'] and record['summary']['completedAt']==docs['completion']['completedAt']
    else:
        assert a.case=='timing-gated-live' and entry['kind']=='timing'
        spec=docs['manifest']['spec'];done=docs['completion'];old=docs['audit']
        assert docs['manifest']['version']=='readout-emitting-timing-v1' and docs['manifest']['exactPoseOnly'] is True
        assert same(record['spec'],spec) and spec['replicate']==3000 and spec['worldIndex']==0 and spec['field']=='si-continuous' and spec['policy']=='encounter-gated' and spec['navDt']==1/64
        assert record['development'] is None and record['availability']=='live-passive'
        assert done['completed'] is True and done['developmentOnly'] is True and done['performanceCampaign'] is False
        assert done['sha256']==files['history']['sha256'] and done['bytes']==nbytes and done['file']=='mission.json.gz'
        assert done['replay']['passed'] is True and done['replay']['privateFieldQueries']==0
        assert record['summary']['stage']==done['terminalStage'] and record['summary']['completedAt']==done['completedAt']
        assert type(docs['process']['exitCode']) is int and docs['process']['exitCode']==0 and docs['process']['timedOut'] is False
        assert old['details']['passed'] is True and old['historySha256']==files['history']['sha256'] and old['manifestSha256']==files['manifest']['sha256'] and old['completeSha256']==files['completion']['sha256']
        for row in docs['manifest']['sources']+old['sources']:assert sha(ROOT/row['path'])==row['sha256']
    details,guard=audit(record,scan_disabled=entry['kind']=='scan-disabled')
    assert details['passed'] is True
    assert details==docs['audit']['details'],'Derived details differ from frozen reference'
    for row in m['sources']+m['inputs']:assert sha(ROOT/row['path'])==row['sha256'],row['path']
    status=None if record['verification'] is None else record['verification']['arms'][0]['decision']['status']
    result=dict(version='absent-report-full-audit-regression-v1',passed=True,createdAt=datetime.now(timezone.utc).isoformat(),
                caseId=a.case,elapsedSeconds=time.monotonic()-start,historySha256=files['history']['sha256'],
                referenceAuditSha256=files['audit']['sha256'],executionManifestSha256=sha(a.manifest),
                details=details,exactReferenceDetailsMatched=True,guard=guard,
                observedTerminalCategory=dict(stage=record['summary']['stage'],nominalStatus=status,field=spec['field']),
                newScientificAuditsExecuted=1,newMissions=0,performanceCampaign=False,physicalValidation=False)
    with a.output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(dict(caseId=a.case,passed=True,exactReferenceDetailsMatched=True,elapsedSeconds=result['elapsedSeconds'],newScientificAuditsExecuted=1,newMissions=0)),flush=True)


if __name__=='__main__':main()
