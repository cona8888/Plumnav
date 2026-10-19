"""Fresh-ID RPC transport and bound-artifact rejection tests, no new worlds."""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
from lib.si_mechanism_registry_v3 import Registry,validate
from lib.si_mechanism_history_v1 import ROOT,sha,load,pinned,history,old_record,need


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);a=p.parse_args();out=a.root
    path=out/'prospective_manifest_v2.json';r=Registry(path,sha(path));dev=Registry(out/'development_manifest.json',sha(out/'development_manifest.json'))
    ledger=load(out/'binding_ledger.json');ref=next(e['reference'] for e in ledger['cases'].values() if e['mode']=='reuse' and e['case']['arm']=='GL' and e['case']['spec']['navDt']==1/64)
    c=next(e['case'] for e in ledger['cases'].values() if e['reference']==ref)
    old,_=old_record(ref,c['spec']);observation=dict(visits=old['visits'],motionContract=old['motionContract']);expected=old['verification']['arms']
    need(expected[0]['decision']['status']=='supported','Expected fixed reporting fixture')
    module=importlib.util.spec_from_file_location('service_v2',ROOT/'scripts/si-mechanism-bridge-v3.py');service_mod=importlib.util.module_from_spec(module);module.loader.exec_module(service_mod)
    service=service_mod.Service(str(path),sha(path));count=0
    arms=['RW','GW','RL','GL','NS'];fields=['si-continuous','si-pulse','blank']
    for i,w in enumerate(r.document['worlds']):
        case=next(c for c in r.cases.values() if c['worldKey']==w['key'] and c['arm']==arms[i%5] and c['spec']['field']==fields[i%3] and c['spec']['navDt']==1/64)
        request=dict(id=i,caseId=case['id'],operation='verify',reportingReplicate=w['reportingReplicate'],**observation)
        answer=service.handle(request);need(answer['arms']==expected,'Fresh reporting identity changed decision/observations')
        need(answer['context']==dict(caseId=case['id'],worldKey=w['key'],arm=case['arm'],field=case['spec']['field'],reportingReplicate=w['reportingReplicate']),'Wrong fresh echo')
        count+=1
    rejected=0
    for delta in ({'caseId':'unknown'},{'reportingReplicate':603000},{'id':False},{'operation':'guess'},{'source':{'x':.5,'y':.5}}):
        try:service.handle(dict(request,**delta))
        except (ValueError,TypeError):rejected+=1
        else:raise ValueError('Invalid request escaped')
    for change in [lambda m:m['cases'].pop(),lambda m:m['cases'][0]['spec'].update(policy='encounter-gated'),lambda m:m['worlds'][0].update(replicate=1)]:
        bad=copy.deepcopy(dev.document);change(bad)
        try:validate(bad)
        except ValueError:rejected+=1
        else:raise ValueError('Bad development manifest escaped')
    for key in ('history','audit','completion','parent','acceptance','process'):
        bad=copy.deepcopy(ref);bad[key]['sha256']='0'*64
        try:old_record(bad,c['spec'])
        except ValueError:rejected+=1
        else:raise ValueError('Corrupted reference chain escaped')
    result=dict(passed=True,freshReportingIdentities=count,unchangedVerifierArms=True,negativeChecks=rejected,
                sourceOfObservations='One pinned development history; source/arm labels are RPC metadata only',newPerformanceWorlds=0,newMissions=0)
    with (out/'contract_acceptance.json').open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result),flush=True)


if __name__=='__main__':main()
