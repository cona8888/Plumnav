"""Join only bound audited records; check all 15 real development triplets."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import numpy as np
from lib.si_mechanism_registry_v3 import Registry,ARMS,FIELDS
from lib.si_mechanism_history_v1 import ROOT,sha,load,need,pinned
from lib.si_linear_integration_audit import compare
from lib.si_release_endpoint_v2 import endpoint,refinement_check
from lib.si_paired_statistics_v2 import paired_statistics


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);a=p.parse_args();out=a.root
    manifest=out/'development_manifest.json';r=Registry(manifest,sha(manifest));bound={};primary=[]
    for c in r.cases.values():
        receipt=load(out/'bound'/(c['id']+'.json'));need(receipt['passed'] is True and receipt['case']==c,'Bound identity')
        need(receipt['manifestSha256']==sha(manifest) and receipt['ledgerSha256']==sha(out/'binding_ledger.json'),'Bound manifest/ledger')
        pinned(receipt['history']);pinned(receipt['arrays']);need(receipt['details']['passed'] is True,'Bound scientific audit')
        need(endpoint(receipt['extracted']['metadata'])==receipt['extracted']['endpoint'],'Bound endpoint')
        key=(c['arm'],c['spec']['field'],c['spec']['navDt']);need(key not in bound,'Duplicate bound case');bound[key]=receipt
        if c['spec']['navDt']==1/64:primary.append(dict(worldKey=c['worldKey'],arm=c['arm'],field=c['spec']['field'],endpoint=receipt['extracted']['metadata']))
    triples=[]
    for arm in ARMS:
        for field in FIELDS:
            receipts=[bound[arm,field,dt] for dt in (1/16,1/32,1/64)];small=[]
            for b in receipts:
                with np.load(pinned(b['arrays']),allow_pickle=False) as arrays:small.append(dict(b['compact'],positions=arrays['positions'],scalar=arrays['scalar']))
            numerical=compare(small)
            endpoint_gate=refinement_check(dict(parentNumericalPassed=numerical['passed'],resolutions=[dict(worldKey=b['case']['worldKey'],arm=arm,navDt=dt,endpoint=b['extracted']['metadata']) for b,dt in zip(receipts,('1/16','1/32','1/64'))]))
            need(numerical['passed'] and endpoint_gate['passed'],'Numerical/endpoint triplet failed: '+arm+' '+field)
            triples.append(dict(arm=arm,field=field,numerical=numerical,endpointGate=endpoint_gate,caseIds=[b['caseId'] for b in receipts]))
    need(len(primary)==15,'Incomplete real primary world')
    try:paired_statistics(primary,['mechanism-development-3000'],bootstrap_seed=1)
    except ValueError as e:need('Explicit unique ordered world keys required' in str(e),'Unexpected statistics rejection')
    else:raise ValueError('One-world population inference was permitted')
    result=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),manifestSha256=sha(manifest),boundCases=len(bound),triplets=triples,
                primaryStatisticsInput=primary,oneWorldInferenceRejected=True,performanceComparison=False,newPerformanceWorlds=0,
                newScientificAudits=sum(b['newScientificAudit'] for b in bound.values()),reusedScientificAudits=sum(b['reusedScientificAudit'] for b in bound.values()),
                exactHistoricalMatches=sum(b['exactHistoricalMatch'] for b in bound.values()),physicalValidation=False)
    with (out/'assembly_acceptance.json').open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps({k:result[k] for k in ('passed','boundCases','oneWorldInferenceRejected','newScientificAudits','reusedScientificAudits','exactHistoricalMatches')}),flush=True)


if __name__=='__main__':main()
