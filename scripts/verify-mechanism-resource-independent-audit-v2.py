"""Verify terminal transport/provenance of the same-image AWS independent audit.

The byte-identical original importer re-executes all 120 full numerical audits
on AWS x86. This local verifier authenticates that execution and binds every
downloaded derivative to the original saved producer evidence. It does NOT run
simulations, relax comparisons or repeat numerical equations on the Mac.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tarfile
import numpy as np
from lib.si_exact_registry_v1 import strict_json
from lib.si_release_endpoint_v2 import endpoint

ROOT=Path(__file__).resolve().parents[1]
PRODUCER_JOB='plumenav-mech-resource-v2-20260930-050952'
PRODUCER_TAR_SHA='e5700b6a9e4f2ee5aa0a21d27a2c3d158ecf95f1d35f5689f573d5ff6aba90a7'
PRODUCER_INTENT_SHA='7242558419f98d47d0b59100d4ac8ee158a09d89833df5a1792e258c4dcf7452'
IMPORTER_SHA='2ff4901be64d8131bcf355d92257da99acca806da79b422d1cd2151e0ce16b89'
SCIENCE=ROOT/'aws/build/si-mechanism-preflight-candidate-20260925-v3'
POLICY=ROOT/'aws/build/PlumeNav_mechanism_aws_first_20260928_v2_attempt01/overlay'
EXECUTION=ROOT/'aws/build/PlumeNav_mechanism_resource_20260930_v2_attempt01/execution'
PINS={
    'scripts/audit-mechanism-aws-first-v2-download.py':'c15c98d0029350baecff718d6d4dd7b2001aea3585c02b33e5d5ca92d7dc8ec8',
    'scripts/audit-mechanism-resource-v2-download.py':IMPORTER_SHA,
    'scripts/collect-mechanism-resource-v2.py':'b377273b0a0268eff26235a78af65f9794dfea288b4a66f292fb3f7de88269b8',
    'scripts/collect-mechanism-resource-independent-audit-v2.py':'e058903815deb3c35e52b316778b35e050542ff5ca73e3a0c071d29b09708652',
    'aws/mechanism_resource_audit_control_v2.py':'76f56255062186cfcf1c2defb257c1a00485f3fb8e439c774497b100ccd6ccb6',
    'scripts/verification_manifest_v2.py':'e53e00e5f5e3d3d66e3ca3bb76d368c1ca3d5e4bfc5dc553582fa5859bf4d058',
    'scripts/lib/si_exact_registry_v1.py':'b09a3d710a6a5ca7926adc60490fbd51fa6d96ad3e26d4c91363cc6dcf873a14',
    'scripts/lib/si_release_endpoint_v1.py':'fe5f8dd86f1bb9ab78b793603ad9d6abce3b60312380f04ada386e5e939f9ecf',
    'scripts/lib/si_release_endpoint_v2.py':'614cbd7780faa657cb8ea9be64586278ccfb952afa9d619bb1fb90d3c0dc6df8',
}
PROVENANCE={'describe-processing-job.json','s3-index.json','launch-intent.json',
    'submission-attempt.json','launch-response.json','job-describe-initial.json',
    'cloudwatch.json','collection-hashes.json'}


def need(ok,why):
    if not ok: raise ValueError(why)


def sha(path):
    with Path(path).open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()


def load(path): return strict_json(Path(path).read_bytes())


def write(path,value):
    with Path(path).open('x') as f:
        json.dump(value,f,indent=2,sort_keys=True,allow_nan=False,default=str);f.write('\n')


def module(name,path):
    s=importlib.util.spec_from_file_location(name,path)
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m


def regular(root,name):
    root=Path(root).resolve();p=Path(name)
    need(type(name) is str and not p.is_absolute() and '..' not in p.parts
         and '\\' not in name and str(p)==name,'Noncanonical evidence path')
    current=root
    for part in p.parts:
        current=current/part;need(not current.is_symlink(),'Symlinked evidence path')
    need(current.is_file() and current.resolve().is_relative_to(root),'Missing evidence file: '+name)
    return current


def expected_members(payloads):
    return {'output/'+n for n in payloads|{'PAYLOAD_SHA256SUMS_V1'}}|{'provenance/'+n for n in PROVENANCE}


def inspect_tar(path,wanted):
    with tarfile.open(path,'r:') as t:
        rows=t.getmembers();names=[r.name for r in rows]
        need(len(names)==len(set(names)) and set(names)==wanted,'Exact transfer TAR membership')
        need(all(r.isfile() and 0<=r.size<8*1024**3 for r in rows),'Nonregular/oversized transfer member')
        total=sum(r.size for r in rows);need(total<8*1024**3,'Transfer expansion cap')
    return total


def verify_transport(tree,path,wanted,expected_sha):
    """Bind every actual extracted body to a hash-pinned original TAR."""
    need(sha(path)==expected_sha,'Saved transport archive hash mismatch')
    inspect_tar(path,wanted)
    actual={p.relative_to(tree).as_posix() for p in tree.rglob('*') if not p.is_dir()}
    need(actual==wanted,'Saved transfer tree membership')
    with tarfile.open(path,'r:') as t:
        for r in t.getmembers():
            body=regular(tree,r.name)
            with t.extractfile(r) as stream:
                digest=hashlib.file_digest(stream,'sha256').hexdigest()
            need(body.stat().st_size==r.size and sha(body)==digest,'Saved transfer body differs: '+r.name)
    hashes=load(regular(tree,'provenance/collection-hashes.json'))['hashes']
    need(set(hashes)==wanted-{'provenance/collection-hashes.json'},'Collection hash coverage')
    need(all(sha(regular(tree,n))==h for n,h in hashes.items()),'Collection hash mismatch')
    return hashes


def verify_inventory(tree,job,bucket,prefix,payloads):
    out=tree/'output';index=load(tree/'provenance/s3-index.json');rows=index['objects']
    expected=payloads|{'PAYLOAD_SHA256SUMS_V1'}
    need(index['job']==job and index['bucket']==bucket and index['prefix']==prefix
         and len(rows)==len(expected) and {r['relative'] for r in rows}==expected,'S3 output inventory identity')
    need(all(type(r['bytes']) is int and r['bytes']>=0 and regular(out,r['relative']).stat().st_size==r['bytes']
             for r in rows),'S3 output byte count')
    from verification_manifest_v2 import verify_manifest
    verify_manifest(out,sorted(payloads))
    return sum(r['bytes'] for r in rows)


def audit_identities():
    return {(phase,f'mechanism-development-3000-{arm}-{field}-n{dt}')
        for phase in ('baseline','candidate','stress-a','stress-b')
        for arm in ('RW','GW','RL','GL','NS') for field in ('si-continuous','si-pulse','blank')
        for dt in ((16,32,64) if phase in ('baseline','candidate') else (64,))}


def check_verification(value,output_bytes):
    need(value['accepted'] is True and value['independentDownloadedAuditPassed'] is True
         and value['job']==PRODUCER_JOB and value['archiveSha256']==PRODUCER_TAR_SHA
         and value['sourceScriptSha256']==IMPORTER_SHA
         and value['outputObjects']==1449 and value['outputBytes']==output_bytes
         and value['exactComparisons']==75 and value['productionAdmitted'] is False
         and value['performanceEvidence'] is False and value['newMissions']==0
         and value['reservedWorldsExecuted']==0 and value['awsCalls']==0,'Resource verification scope')
    rows=value['independentAudits']
    need(len(rows)==120 and {(r['phase'],r['caseId']) for r in rows}==audit_identities()
         and all(r['passed'] is True for r in rows),'Exact 120-history independent coverage')
    return {(r['phase'],r['caseId']):r for r in rows}


def check_pair(producer,independent,phase,cid,case,proof,compare):
    src=producer/'runs'/phase
    audit=independent/'independent-audit/runs'/phase
    history=regular(src,'cases/'+cid+'/mission.json.gz');h=sha(history)
    need(proof['historySha256']==h,'Accepted history hash differs')
    diagnostics=[];receipts=[];arrays=[]
    for folder in (src/'audits',audit/'audits'):
        r=load(regular(folder,cid+'.json'));d=load(regular(folder,cid+'-diagnostics.json'))
        need(r['passed'] is True and r['detailsPassed'] is True and r['caseId']==cid and r['case']==case
             and r['historySha256']==d['historySha256']==h
             and r['manifestSha256']=='666126c63b3d9e4cd6686320ed8c6a49a643bd1783ac8e09aaa408cc6db49946',
             'Independent/producer case-history binding')
        need(r['diagnosticsSha256']==sha(regular(folder,cid+'-diagnostics.json'))
             and r['arraysSha256']==d['arraysSha256']==sha(regular(folder,cid+'-arrays.npz')),
             'Audit derivative body mismatch')
        need(d['details']['passed'] is True and d['compact']['spec']==case['spec']
             and d['extracted']['metadata']['field']==case['spec']['field']
             and compare(endpoint(d['extracted']['metadata']),d['extracted']['endpoint'])['exact'],
             'Derived audit/endpoint identity')
        with np.load(regular(folder,cid+'-arrays.npz'),allow_pickle=False) as z:
            need(set(z.files)=={'positions','scalar'},'Exact audit NPZ members')
            a={k:z[k].copy() for k in z.files}
            need(all(v.dtype.kind=='f' and np.isfinite(v).all() for v in a.values()),'Invalid audit arrays')
        diagnostics.append(d);receipts.append(r);arrays.append(a)
    for key in ('caseId','case','manifestSha256','historySha256','detailsPassed','referenceComparison'):
        need(compare(receipts[0][key],receipts[1][key])['exact'],'Independent/producer receipt disagreement')
    need(compare({k:v for k,v in diagnostics[0].items() if k!='arraysSha256'},
                 {k:v for k,v in diagnostics[1].items() if k!='arraysSha256'})['exact'],
         'Independent diagnostics differ')
    need(all(np.array_equal(arrays[0][k],arrays[1][k]) for k in arrays[0]),'Independent arrays differ')
    relation=receipts[1]['referenceComparison']
    if phase=='baseline':need(relation is None,'Baseline has unexpected reference comparison')
    else:
        need(relation['passed'] is True and relation['exact'] is True
             and relation['bothFullAuditsPassed'] is True and relation['history']['exact'] is True
             and relation['endpoint']['exact'] is True
             and relation['referenceHistorySha256']==sha(regular(producer,'runs/baseline/cases/'+cid+'/mission.json.gz')),
             'Exact canonical reference binding failed')
    return dict(phase=phase,caseId=cid,historySha256=h,passed=True,
        independentReceiptSha256=sha(regular(audit/'audits',cid+'.json')),
        independentDiagnosticSha256=sha(regular(audit/'audits',cid+'-diagnostics.json')))


def main():
    p=argparse.ArgumentParser()
    for name in ('archive','producer-archive','producer-directory','destination'):p.add_argument('--'+name,type=Path,required=True)
    for name in ('archive-sha256','intent-sha256','job'):p.add_argument('--'+name,required=True)
    a=p.parse_args()
    for name,h in PINS.items():need(sha(regular(ROOT,name))==h,'Changed verification source: '+name)
    collector=module('independent_collector',ROOT/'scripts/collect-mechanism-resource-independent-audit-v2.py')
    producer_collector=module('producer_collector',ROOT/'scripts/collect-mechanism-resource-v2.py')
    transfer=module('safe_transfer',ROOT/'scripts/audit-mechanism-aws-first-v2-download.py')
    control=module('independent_control',ROOT/'aws/mechanism_resource_audit_control_v2.py')
    collector.validate_job_name(a.job)
    dest=a.destination.resolve();archive=a.archive.resolve();producer_archive=a.producer_archive.resolve()
    need(dest.is_relative_to(ROOT) and not dest.exists() and not dest.is_relative_to(archive.parent)
         and not dest.is_relative_to(producer_archive.parent),'Fresh separate workspace destination')
    need(sha(archive)==a.archive_sha256 and sha(producer_archive)==PRODUCER_TAR_SHA,'Archive hash binding')
    wanted=expected_members(collector.expected_payloads());size=inspect_tar(archive,wanted)
    need(shutil.disk_usage(dest.parent).free>size+1024**3,'Local audit transfer capacity')
    dest.mkdir();result=dict(accepted=False,checkedAt=datetime.now(timezone.utc).isoformat(),
        sourceScriptSha256=sha(Path(__file__)),auditJob=a.job,producerJob=PRODUCER_JOB,
        newMissions=0,awsCalls=0,productionAdmitted=False,performanceEvidence=False,
        numericalAuditExecution='Original byte-identical importer on pinned AWS x86; no Mac equation rerun')
    try:
        transfer.extract_exact(archive,dest/'download')
        tree=dest/'download';out=tree/'output';prov=tree/'provenance'
        verify_transport(tree,archive,wanted,a.archive_sha256)
        producer=a.producer_directory.resolve()
        producer_wanted=expected_members(producer_collector.expected_payloads())
        verify_transport(producer,producer_archive,producer_wanted,PRODUCER_TAR_SHA)
        need(sha(regular(producer,'provenance/launch-intent.json'))==PRODUCER_INTENT_SHA,'Producer intent changed')
        intent=load(prov/'launch-intent.json');job=load(prov/'describe-processing-job.json')
        need(sha(prov/'launch-intent.json')==a.intent_sha256,'Independent launch intent changed')
        collector.validate_launch(intent,job,a.job)
        need(intent['account']==control.ACCOUNT and intent['region']==control.REGION
             and intent['approvalReference']==control.APPROVAL and intent['authorApprovedAdditionalBudgetUSD']==200
             and intent['thisAuditPlanningAllocationUSD']==8 and intent['submitted'] is False
             and intent['automaticRetryAllowed'] is False,'Audit authorisation provenance')
        package,_,offline=control.inspect((ROOT/'aws/build/PlumeNav_mechanism_resource_independent_audit_20260930_v2_attempt01.zip').read_bytes())
        offline['ProcessingJobName']=a.job;offline['Environment']['MECHANISM_INDEPENDENT_AUDIT_APPROVED']='YES'
        prefix=control.PREFIX+'jobs/'+a.job+'/output/'
        offline['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3Uri']='s3://'+control.BUCKET+'/'+prefix
        need(control.matches(offline,job),'Actual job differs from hash-pinned offline package')
        need(load(prov/'launch-response.json')['ProcessingJobArn']==job['ProcessingJobArn']
             and control.matches(offline,load(prov/'job-describe-initial.json'))
             and load(prov/'submission-attempt.json')['job']==a.job
             and load(prov/'submission-attempt.json')['intentSha256']==a.intent_sha256,'Submission evidence chain')
        audit_bytes=verify_inventory(tree,a.job,control.BUCKET,prefix,collector.expected_payloads())
        producer_prefix=producer_collector.BASE+'jobs/'+PRODUCER_JOB+'/output/'
        producer_bytes=verify_inventory(producer,PRODUCER_JOB,control.BUCKET,producer_prefix,producer_collector.expected_payloads())
        runtime=load(out/'runtime.json')
        need({k:runtime[k] for k in ('python','numpy','scipy','node','architecture','cpus')}==
             dict(python='3.12.13',numpy='1.26.4',scipy='1.16.3',node='v20.19.6',architecture='x86_64',cpus=48)
             and all(v=='1' for v in runtime['threadSettings'].values())
             and all(t['num_threads']==1 for t in runtime['threads']),'Audit actual runtime/threading')
        need(load(out/'payload-index.json')==dict(version='resource-independent-audit-output-v2',payloads=sorted(collector.expected_payloads())),
             'Audit fixed output index')
        done=load(out/'complete.json')
        need(done['completed'] is True and done['resourceWitnessAccepted'] is True and done['independentAudits']==120
             and done['exactComparisons']==75 and done['newMissions']==0 and done['reservedWorldsExecuted']==0
             and done['productionAdmitted'] is False and done['scientificallyAccepted'] is False
             and done['archiveSha256']==PRODUCER_TAR_SHA and done['importerSha256']==IMPORTER_SHA,'Audit completion scope')
        messages=[e['message'] for e in load(prov/'cloudwatch.json')['events']]
        need(messages.count('INDEPENDENT_RESOURCE_AUDIT_COMPLETE_TERMINAL_DOWNLOAD_REQUIRED')==1,'Independent terminal log marker')
        value=load(out/'verification.json');proof=check_verification(value,producer_bytes)
        driver=load(out/'audit-driver.log')
        printed={k:v for k,v in value.items() if k!='independentAudits'}
        need(control.matches(printed,driver) and control.matches(driver,printed),'Original importer terminal stdout')
        sys.path.insert(0,str(POLICY));import common
        _,_,registry=common.context(SCIENCE)
        from mechanism_portability_candidate_v1 import compare
        rows=[]
        for phase,cid in sorted(audit_identities()):
            rows.append(check_pair(producer/'output',out,phase,cid,registry.cases[cid],proof[phase,cid],compare))
        registry.protect()
        verify_transport(tree,archive,wanted,a.archive_sha256)
        verify_transport(producer,producer_archive,producer_wanted,PRODUCER_TAR_SHA)
        for name,h in PINS.items():need(sha(regular(ROOT,name))==h,'Verification source changed during terminal checks')
        # Preserve the original importer's accepted receipt byte-for-byte. This
        # copy is eligible for the existing release checker ONLY with this new
        # terminal acceptance receipt and its launch/file provenance retained.
        with (dest/'accepted-resource-verification.json').open('xb') as f:f.write((out/'verification.json').read_bytes())
        result.update(accepted=True,acceptedFor='Same-image independently downloaded fixed-development resource witness only',
            outputObjects=486,outputBytes=audit_bytes,independentAuditFilesVerified=120,
            exactComparisonsVerified=75,resourceVerificationSha256=sha(out/'verification.json'),
            archiveSha256=a.archive_sha256,intentSha256=a.intent_sha256,sourcePins=PINS,
            verifiedHistories=rows,scientificallyAccepted=False,
            remaining='Measured campaign release and admission, full 2400-history run and independent triplet/statistical audit')
    except BaseException as error:
        result['error']=type(error).__name__+': '+str(error);raise
    finally:
        write(dest/'terminal-verification.json',result)
        print(json.dumps({k:v for k,v in result.items() if k!='verifiedHistories'},indent=2),flush=True)


if __name__=='__main__':main()
