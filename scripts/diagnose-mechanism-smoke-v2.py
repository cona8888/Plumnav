"""Read-only numerical diagnostic of a rejected history; never grants acceptance."""
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import runpy
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
PACKAGE=ROOT/'aws/build/si-mechanism-preflight-candidate-20260925-v3'
RAW=ROOT/'research/results/si_mechanism_smoke_v2_cloud_2026-09-26/download'
OUT=ROOT/'research/results/si_mechanism_smoke_v2_cloud_2026-09-26/numerical-diagnostic.json'

def differences(a,b):
    groups=defaultdict(lambda:dict(numericDifferences=0,maxAbsoluteDifference=0.0,structuralDifferences=0,examples=[]))
    def visit(x,y,path):
        if isinstance(x,dict) and isinstance(y,dict):
            if x.keys()!=y.keys():
                g=groups[path.split('/')[1] if '/' in path else 'root'];g['structuralDifferences']+=1
                if len(g['examples'])<5:g['examples'].append(dict(path=path,leftKeys=sorted(x),rightKeys=sorted(y)))
            for k in x.keys() & y.keys():visit(x[k],y[k],path+'/'+str(k))
        elif isinstance(x,list) and isinstance(y,list):
            if len(x)!=len(y):
                g=groups[path.split('/')[1]];g['structuralDifferences']+=1
                if len(g['examples'])<5:g['examples'].append(dict(path=path,leftLength=len(x),rightLength=len(y)))
            for i,(xx,yy) in enumerate(zip(x,y)):visit(xx,yy,path+'/'+str(i))
        elif x != y or (isinstance(x,bool) != isinstance(y,bool)):
            g=groups[path.split('/')[1] if '/' in path else 'root']
            if type(x) in (float,int) and type(y) in (float,int) and math.isfinite(x) and math.isfinite(y):
                g['numericDifferences']+=1;g['maxAbsoluteDifference']=max(g['maxAbsoluteDifference'],abs(x-y))
            else:g['structuralDifferences']+=1
            if len(g['examples'])<5:g['examples'].append(dict(path=path,cloud=x,local=y))
    visit(a,b,'')
    return dict(groups)

def main():
    assert not OUT.exists()
    started=time.monotonic()
    verifier=runpy.run_path(str(ROOT/'scripts/verify-mechanism-smoke-v2-download.py'))
    assert verifier['checksums'](PACKAGE,'SHA256SUMS')
    sys.path.insert(0,str(PACKAGE/'scripts'))
    from lib.si_mechanism_history_v1 import sha,load,history,full_audit,terminal,canonical,pinned
    delivery=load(PACKAGE/'delivery.json'); entry=delivery['smokeCases'][0]; cid=entry['caseId']
    result=dict(checkedAt=datetime.now(timezone.utc).isoformat(),caseId=cid,diagnosticOnly=True,
                accepted=False,productionAdmitted=False,newMissions=0,realAwsCalls=0)
    declared={line.split('  ',1)[1]:line.split('  ',1)[0] for line in (RAW/'output/OUTPUT_SHA256SUMS').read_text().splitlines()}
    present={p.relative_to(RAW/'output').as_posix() for p in (RAW/'output').rglob('*') if p.is_file() and p.name!='OUTPUT_SHA256SUMS'}
    assert present <= declared.keys()
    assert all(sha(RAW/'output'/name)==declared[name] for name in present)
    missing=sorted(declared.keys()-present)
    result['payloadIntegrity']=dict(presentFilesMatched=len(present),missingDeclaredFiles=missing,
        missingOnlyEmptyUploaderMarkers=all(n.endswith('.sagemaker-uploaded') and declared[n]==hashlib.sha256(b'').hexdigest() for n in missing),
        strictOuterManifestAccepted=False if missing else True)
    cloud=history(RAW/'output/smoke/cases'/cid/'mission.json.gz')
    local=history(pinned(entry['referenceHistory'])); bound=load(pinned(entry['boundReceipt']))
    done=load(RAW/'output/smoke/cases'/cid/'complete.json')
    assert done['historySha256']==sha(RAW/'output/smoke/cases'/cid/'mission.json.gz')
    result['cloudReplay']=done['replay']
    try:
        details,guard=full_audit(cloud,'RW')
        result['independentLocalFullAuditPassed']=details['passed']
        result['independentLocalFullAuditDetails']=details
        result['localAuditVsReference']=differences(details,bound['details'])
        result['endpoint']=terminal(cloud)
        result['endpointMatchesReference']=result['endpoint']==bound['extracted']
        result['guardMatchesReference']=guard==bound['guard']
    except Exception as error:
        result['independentLocalFullAuditPassed']=False
        result['auditError']=type(error).__name__+': '+str(error)
    result['canonicalHistoryDifferences']=differences(canonical(cloud),canonical(local))
    result['canonicalHistoryExactlyMatches']=not result['canonicalHistoryDifferences']
    result['cloudRuntime']=load(RAW/'output/smoke/runtime.json')
    result['bootstrapFailure']=load(RAW/'output/bootstrap-failed.json')
    job=load(RAW/'provenance/describe-processing-job.json')
    elapsed=(datetime.fromisoformat(job['ProcessingEndTime'])-datetime.fromisoformat(job['ProcessingStartTime'])).total_seconds()
    result['processingSeconds']=elapsed
    result['estimatedComputeUSD']=elapsed*0.23/3600
    result['costCaveat']='Processing interval times checked hourly rate; excludes storage, transfer, requests, logs and tax; not a billing receipt.'
    result['elapsedSeconds']=time.monotonic()-started
    result['scriptSha256']=sha(Path(__file__))
    with OUT.open('x') as f:json.dump(result,f,indent=2,allow_nan=False);f.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ('independentLocalFullAuditDetails','cloudReplay','bootstrapFailure')},indent=2))

if __name__=='__main__':main()
