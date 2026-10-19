"""Independently re-audit all 120 downloaded development histories.

No AWS calls or simulated outcomes. Only a terminal transfer archive bound to
the author-approved launch intent is eligible. A pass admits the resource/wrapper
witness, not the 2400-history campaign or any scientific-performance claim.
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
SCIENCE=ROOT/'aws/build/si-mechanism-preflight-candidate-20260925-v3'
POLICY=ROOT/'aws/build/PlumeNav_mechanism_aws_first_20260928_v2_attempt01/overlay'
EXECUTION=ROOT/'aws/build/PlumeNav_mechanism_resource_20260929_v1_attempt02/execution'
PACKAGE=ROOT/'aws/build/PlumeNav_mechanism_resource_20260929_v1_attempt02/PACKAGE.json'


def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


transfer=module('smoke_transfer',ROOT/'scripts/audit-mechanism-aws-first-v2-download.py')
collector=module('resource_collector',ROOT/'scripts/collect-mechanism-resource-v1.py')
control=module('resource_control',ROOT/'aws/mechanism_resource_control_v1.py')
need,sha,load,write=transfer.need,transfer.sha,transfer.load,transfer.write
PROVENANCE={'describe-processing-job.json','s3-index.json','launch-intent.json',
    'submission-attempt.json','launch-response.json','job-describe-initial.json',
    'cloudwatch.json','collection-hashes.json'}


def scope(phase):
    return sorted({n.split('/')[3] for n in collector.expected_payloads()
        if n.startswith('runs/'+phase+'/cases/')})


def markers():
    return {'RESOURCE_CASE_COMPLETED '+('stress' if p.startswith('stress-') else p)+' '+p+' '+cid
        for p in ('baseline','candidate','stress-a','stress-b') for cid in scope(p)}


def main():
    p=argparse.ArgumentParser()
    for name in ('archive','destination'): p.add_argument('--'+name,type=Path,required=True)
    for name in ('archive-sha256','intent-sha256','job'): p.add_argument('--'+name,required=True)
    a=p.parse_args(); collector.validate_job_name(a.job)
    archive,dest=a.archive.resolve(),a.destination.resolve()
    need(archive.is_file() and not archive.is_symlink() and sha(archive)==a.archive_sha256,'Transfer archive mismatch')
    need(dest.is_relative_to(ROOT) and not dest.exists() and not dest.is_relative_to(archive.parent),'Fresh separate workspace destination required')
    dest.mkdir(parents=True)
    result=dict(checkedAt=datetime.now(timezone.utc).isoformat(),job=a.job,
        sourceScriptSha256=sha(Path(__file__)),archiveSha256=a.archive_sha256,
        accepted=False,productionAdmitted=False,newMissions=0,awsCalls=0,
        independentAudits=[],reservedWorldsExecuted=0)
    try:
        members=transfer.extract_exact(archive,dest/'download')
        out=dest/'download/output'; prov=dest/'download/provenance'
        need({n.removeprefix('provenance/') for n in members if n.startswith('provenance/')}==PROVENANCE,'Provenance membership')
        ledger=load(prov/'collection-hashes.json')['hashes']
        need(set(ledger)==set(members)-{'provenance/collection-hashes.json'},'Transfer hash coverage')
        need(all(sha(dest/'download'/n)==d for n,d in ledger.items()),'Transfer body mismatch')
        need(sha(prov/'launch-intent.json')==a.intent_sha256,'Immutable launch intent changed')
        intent=load(prov/'launch-intent.json'); spec=intent['spec']
        need(intent['account']==control.ACCOUNT and intent['region']==control.REGION
            and intent['zipSha256']==control.ZIP_SHA and intent['packageSha256']==control.PACKAGE_SHA
            and intent['inputHashes']==control.INPUTS and intent['authorApprovedBudgetUSD']>=8
            and bool(intent['approvalReference'].strip()) and intent['productionAdmitted'] is False,'Launch identity/input/approval binding')
        need(sha(PACKAGE)==control.PACKAGE_SHA,'Local package changed')
        job=load(prov/'describe-processing-job.json')
        need(job['ProcessingJobStatus']=='Completed' and not job.get('FailureReason')
            and job.get('ProcessingStartTime') and job.get('ProcessingEndTime')
            and job['ProcessingJobName']==a.job and control.matches(spec,job),'Terminal job configuration')
        need(spec['RoleArn']==control.ROLE and spec['AppSpecification']['ImageUri']==control.IMAGE
            and spec['ProcessingResources']['ClusterConfig']==control.RESOURCES
            and spec['StoppingCondition']=={'MaxRuntimeInSeconds':7200}
            and spec['Environment']['MECHANISM_RESOURCE_APPROVED']=='YES','Resource-witness launch scope')
        prefix=control.PREFIX+'jobs/'+a.job+'/output/'
        need(spec['ProcessingInputs'][0]['S3Input']['S3Uri']=='s3://'+control.BUCKET+'/'+control.PREFIX+'input/'
            and spec['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3Uri']=='s3://'+control.BUCKET+'/'+prefix
            and spec['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3UploadMode']=='Continuous','Private input/output binding')
        need(load(prov/'launch-response.json')['ProcessingJobArn']==job['ProcessingJobArn']
            and control.matches(spec,load(prov/'job-describe-initial.json'))
            and load(prov/'submission-attempt.json')['job']==a.job
            and load(prov/'submission-attempt.json')['intentSha256']==a.intent_sha256,'Submit/initial provenance')
        index=load(prov/'s3-index.json'); rows=index['objects']
        expected=collector.expected_payloads()|{'PAYLOAD_SHA256SUMS_V1'}
        actual={n.removeprefix('output/') for n in members if n.startswith('output/')}
        need(index['job']==a.job and index['bucket']==control.BUCKET and index['prefix']==prefix
            and len(rows)==1449 and {r['relative'] for r in rows}==expected==actual
            and all((out/r['relative']).stat().st_size==r['bytes'] for r in rows),'Exact output inventory')
        result['outputObjects']=len(rows); result['outputBytes']=sum(r['bytes'] for r in rows)

        sys.path.insert(0,str(EXECUTION)); sys.path.insert(0,str(POLICY))
        import common
        _,delivery,registry=common.context(SCIENCE)
        from verification_manifest_v1 import verify_manifest
        from mechanism_portability_candidate_v1 import compare
        need(verify_manifest(out,sorted(collector.expected_payloads()))['passed'],'Output hash manifest')
        need(load(out/'payload-index.json')==dict(version='mechanism-resource-witness-v1',payloads=sorted(collector.expected_payloads())),'Output contract')
        freeze=load(EXECUTION/'EXECUTION.json')
        need(load(out/'execution-freeze.json')==freeze and all(sha(EXECUTION/n)==d for n,d in freeze['components'].items()),'Separate execution freeze')
        runtime=load(out/'runtime.json')
        need(all(runtime[k]==v for k,v in delivery['historicallyVerifiedRuntime'].items())
            and runtime['cpus']==48 and runtime['architecture']=='x86_64'
            and all(v=='1' for v in runtime['threadSettings'].values())
            and all(t['num_threads']==1 for t in runtime['threadpoolInfo']),'Actual runtime/threading')
        done=load(out/'complete.json')
        need(done['completed'] is True and done['histories']==120 and done['allFullAuditsPassed'] is True
            and done['exactCandidateComparisons']==75 and done['reservedWorldsExecuted']==0
            and done['productionAdmitted'] is False and done['scientificallyAccepted'] is False,'Terminal witness claims')
        messages=[e['message'] for e in load(prov/'cloudwatch.json')['events']]
        case_messages=[m for m in messages if m.startswith('RESOURCE_CASE_COMPLETED ')]
        need(len(case_messages)==120 and set(case_messages)==markers()
            and messages.count('RESOURCE_WITNESS_COMPLETE_DOWNLOAD_AUDIT_REQUIRED')==1
            and {m for m in messages if m.startswith('RESOURCE_PHASE_COMPLETE ')}=={'RESOURCE_PHASE_COMPLETE '+s for s in ('baseline','candidate','stress')},'Worker/log completion markers')
        for stage,workers,count in [('baseline',8,45),('candidate',16,45),('stress',24,30)]:
            profile=load(out/('profile-'+stage+'.json'))
            need(profile['stage']==stage and profile['workers']==workers and profile['histories']==count
                and 0<profile['elapsedSeconds']<6900 and profile['samples']>0
                and 0<profile['sampledAggregatePeakRssBytes']<=140*1024**3
                and profile['absolutePeakBound'] is False,'Missing/invalid measured resource profile')

        env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',MKL_NUM_THREADS='1')
        env.pop('PYTHONPATH',None)
        derived=dest/'independent-audit'; comparisons=0
        import numpy as np
        for phase in ('baseline','candidate','stress-a','stress-b'):
            source=out/'runs'/phase; local=derived/'runs'/phase; local.mkdir(parents=True)
            for n in ('cases','terminals'): (local/n).symlink_to(source/n,target_is_directory=True)
            for cid in scope(phase):
                for role in ('mission','audit'):
                    proc=load(source/'terminals'/(cid+'-'+role+'.json'))
                    need(type(proc['exitCode']) is int and proc['exitCode']==0 and proc['timedOut'] is False,'Remote child failed')
                resource=load(source/'resources'/(cid+'.json'))
                need(type(resource['exitCode']) is int and resource['exitCode']==0
                    and resource['timedOut'] is False and resource['cancelled'] is False
                    and 0<resource['elapsedSeconds']<=1810 and resource['samples']>0
                    and resource['sampledTreePeakRssBytes']>0
                    and resource['absolutePeakBound'] is False,'Invalid per-task resource receipt')
                command=[sys.executable,'-B',str(EXECUTION/'audit.py'),'--science',str(SCIENCE),'--policy',str(POLICY),'--run',str(local),'--case',cid]
                if phase!='baseline': command+=['--reference-run',str(derived/'runs/baseline')]
                log=derived/'logs'/phase/(cid+'.log'); log.parent.mkdir(parents=True,exist_ok=True)
                with log.open('x') as stream:
                    child=subprocess.run(command,cwd=SCIENCE,env=env,stdout=stream,stderr=subprocess.STDOUT,timeout=600)
                need(child.returncode==0,'Independent full-history audit failed: '+phase+'/'+cid)
                rec=load(local/'audits'/(cid+'.json')); remote=load(source/'audits'/(cid+'.json'))
                need(rec['passed'] is True and remote['passed'] is True,'Audit did not pass')
                for key in ('caseId','case','manifestSha256','historySha256','detailsPassed','referenceComparison'):
                    need(rec[key]==remote[key],'Cloud/local audit disagreement: '+key)
                ld=load(local/'audits'/(cid+'-diagnostics.json')); rd=load(source/'audits'/(cid+'-diagnostics.json'))
                for diagnostics,receipt,folder in ((ld,rec,local),(rd,remote,source)):
                    need(diagnostics['arraysSha256']==sha(folder/'audits'/(cid+'-arrays.npz'))
                        and receipt['diagnosticsSha256']==sha(folder/'audits'/(cid+'-diagnostics.json'))
                        and receipt['arraysSha256']==diagnostics['arraysSha256'],'Derived body checksum binding')
                # Verify each compressed archive against its own pinned hash, then
                # compare arrays exactly. ZIP serialization across NumPy versions
                # is not a scientific whole-history or endpoint requirement.
                need(compare({k:v for k,v in ld.items() if k!='arraysSha256'},
                    {k:v for k,v in rd.items() if k!='arraysSha256'})['exact'],'Independent diagnostics differ')
                with np.load(local/'audits'/(cid+'-arrays.npz'),allow_pickle=False) as left, np.load(source/'audits'/(cid+'-arrays.npz'),allow_pickle=False) as right:
                    need(set(left.files)==set(right.files) and all(np.array_equal(left[k],right[k]) for k in left.files),'Independent arrays differ')
                if phase!='baseline':
                    need(rec['referenceComparison']['exact'] is True,'Wrapper repeat mismatch'); comparisons+=1
                result['independentAudits'].append(dict(phase=phase,caseId=cid,historySha256=rec['historySha256'],passed=True))
        need(len(result['independentAudits'])==120 and comparisons==75,'Incomplete independent scope')
        need(all(sha(dest/'download'/n)==d for n,d in ledger.items()),'Downloaded evidence changed during audit')
        registry.protect()
        result.update(accepted=True,acceptedFor='fixed-development wrapper/resource witness only',
            independentDownloadedAuditPassed=True,exactComparisons=75,
            productionAdmitted=False,performanceEvidence=False,
            remaining='Measured campaign resource decision, separately frozen production release, full campaign and independent refinement/statistical audit')
    except BaseException as error:
        result['error']=type(error).__name__+': '+str(error)
        raise
    finally:
        write(dest/'verification.json',result)
        print(json.dumps({k:v for k,v in result.items() if k!='independentAudits'},indent=2),flush=True)


if __name__=='__main__': main()
