"""Audit/bind one preselected development case and save endpoint plus compact data."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import time
import numpy as np
from lib.si_mechanism_registry_v3 import Registry
from lib.si_mechanism_history_v1 import ROOT,sha,load,need,history,old_record,full_audit,terminal,canonical,pinned
from lib.si_linear_integration_audit import compact


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--case',required=True);a=p.parse_args()
    out=a.root;start=time.monotonic();manifest=out/'development_manifest.json';r=Registry(manifest,sha(manifest));c=r.cases[a.case]
    ledger=load(out/'binding_ledger.json');entry=ledger['cases'][a.case];new=entry['mode']=='new';matched=False
    if new:
        folder=out/'cases'/a.case;path=folder/'mission.json.gz';done=load(folder/'complete.json');proc=load(out/'terminals'/(a.case+'-mission.json'))
        need(proc['exitCode']==0 and proc['timedOut'] is False and done['completed'] is True,'New execution failure')
        need(done['case']==c and done['parentManifestSha256']==sha(manifest) and done['historySha256']==sha(path),'New chain binding')
        need(done['replay']['passed'] is True and done['replay']['privateFieldQueries']==0,'New replay failure')
        record=history(path);need(record['spec']==c['spec'] and record['development'] is None,'New raw spec')
        need(record['summary']['stage']==done['stage'] and record['summary']['completedAt']==done['completedAt'],'New terminal/completion')
        v=record['verification']
        if v is not None:
            need(v['version']=='mechanism-exact-v2' and v['manifestSha256']==sha(manifest),'New verifier pin')
            w=r.worlds[c['worldKey']]
            need(v['context']==dict(caseId=c['id'],worldKey=c['worldKey'],arm=c['arm'],field=c['spec']['field'],reportingReplicate=w['reportingReplicate']),'New verifier context')
        details,guard=full_audit(record,c['arm'])
    else:
        record,old_audit=old_record(entry['reference'],c['spec']);details=old_audit['details'];guard=None
        path=pinned(entry['reference']['history'])
    extracted=terminal(record);data=compact(record)
    folder=out/'bound';folder.mkdir(exist_ok=True)
    arrays=folder/(a.case+'.npz')
    with arrays.open('xb') as f:np.savez_compressed(f,positions=data.pop('positions'),scalar=data.pop('scalar'))
    if new and entry['reference'] is not None:
        old,old_audit=old_record(entry['reference'],c['spec'])
        need(details==old_audit['details'],'New audit differs from historical details')
        need(canonical(record)==canonical(old),'Whole historical record differs');matched=True
    r.protect()
    receipt=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),caseId=a.case,case=c,manifestSha256=sha(manifest),ledgerSha256=sha(out/'binding_ledger.json'),
                 history=dict(path=str(path.relative_to(ROOT)),sha256=sha(path)),details=details,guard=guard,extracted=extracted,compact=data,
                 arrays=dict(path=str(arrays.relative_to(ROOT)),sha256=sha(arrays)),newScientificAudit=new,reusedScientificAudit=not new,
                 exactHistoricalMatch=matched,elapsedSeconds=time.monotonic()-start,physicalValidation=False)
    with (folder/(a.case+'.json')).open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
    print(json.dumps(dict(caseId=a.case,passed=True,newScientificAudit=new,exactHistoricalMatch=matched,elapsedSeconds=receipt['elapsedSeconds'])),flush=True)


if __name__=='__main__':main()
