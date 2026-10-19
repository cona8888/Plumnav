"""Terminal-bound three-history same-bundle wrapper admission, not science.

Read-only AWS evidence is supplied as a complete downloaded TAR. No AWS calls,
missions or new Mac numerical audits. Acceptance requires an already independently
accepted original-rule x86 reference, complete exact history/diagnostic/array
equivalence, and the future witness's actual launch/runtime/input/output chain.
"""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import zipfile
import numpy as np
from lib.si_exact_registry_v1 import strict_json
from lib.si_wrapper_equivalence_admission_v2 import reference_coverage, record_binding, exact_equivalence, CASES, DEV_SHA

ROOT=Path(__file__).resolve().parents[1]
BOOTSTRAP_SHA='45249c20ef1007ff29fdf700231ee44b19aed51ea9437dbd4f76cf175ed483a5'
ENTRYPOINT_SHA='160afabdd945047445562b162a2c6b2d0bd6cbd5048c2b694628d5fb8a235992'
REFERENCE_TAR_SHA='e5700b6a9e4f2ee5aa0a21d27a2c3d158ecf95f1d35f5689f573d5ff6aba90a7'
REFERENCE_COLLECTION_SHA='9bb04bd78cd5953290f44991e8e01acb133494d674f1d02daec2c14602ce4b48'
IMAGE='885854791233.dkr.ecr.us-east-1.amazonaws.com/sagemaker-distribution-prod@sha256:2ae2a90be54895e8ef66b4a26a913c57d1ee52f5429055afe652627ddbfa253a'
WORKER_SHA='4a834220c6d8d6764cd49268be29b748789e06cc115fe4434a388c51dbef569a'
ENTRY_COMMAND='set -e; cd /opt/ml/processing/input; printf "%s %s\\n" "$CAMPAIGN_ENTRYPOINT_SHA256" entrypoint.sh | sha256sum -c -; exec bash entrypoint.sh'
PROVENANCE={'describe-processing-job.json','s3-index.json','launch-intent.json','submission-attempt.json',
            'launch-response.json','job-describe-initial.json','cloudwatch.json','collection-hashes.json','transfer-complete.json'}
PINS={
    'scripts/verify-mechanism-resource-independent-audit-v2.py':'3c363029e78acaa1db6ffc6ef7a2cea9f365f0516dbed90ebacb3b6bca47888d',
    'scripts/collect-mechanism-resource-v2.py':'b377273b0a0268eff26235a78af65f9794dfea288b4a66f292fb3f7de88269b8',
    'scripts/collect-mechanism-wrapper-witness-v1.py':'431a9466c0598205384dc39faa6856c22daae32ef9262885bd1547763af274b7',
    'scripts/lib/si_wrapper_equivalence_admission_v2.py':'cc0d9236aaf417bdf60196a866189f1352140bebd84927893df53e6cfe96be2c',
    'scripts/lib/si_exact_registry_v1.py':'b09a3d710a6a5ca7926adc60490fbd51fa6d96ad3e26d4c91363cc6dcf873a14',
    'scripts/verification_manifest_v2.py':'e53e00e5f5e3d3d66e3ca3bb76d368c1ca3d5e4bfc5dc553582fa5859bf4d058',
    'aws/mechanism-campaign-bootstrap-v2/bootstrap.py':BOOTSTRAP_SHA,
    'aws/mechanism-campaign-bootstrap-v2/entrypoint.sh':ENTRYPOINT_SHA,
    'aws/mechanism-campaign-admission-v2/check_release.py':'a1af5e282ae23465cd0ca31de85a54ca81525a0b44dcfaa0c6b89889cc80ffbf'
}


def need(ok,why):
    if not ok:raise ValueError(why)


def sha(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def load(path):return strict_json(Path(path).read_bytes())


def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


def write(path,value):
    with path.open('x') as f:json.dump(value,f,indent=2,sort_keys=True,allow_nan=False);f.write('\n')


def source_dependencies():
    for name,h in PINS.items():need(sha(ROOT/name)==h,'Changed terminal verification source: '+name)
    return (module('resource_terminal_tools',ROOT/'scripts/verify-mechanism-resource-independent-audit-v2.py'),
            module('witness_collector',ROOT/'scripts/collect-mechanism-wrapper-witness-v1.py'),
            module('sealed_bootstrap',ROOT/'aws/mechanism-campaign-bootstrap-v2/bootstrap.py'))


def expected_members(payloads):
    return {'output/'+n for n in payloads|{'PAYLOAD_SHA256SUMS_V1'}}|{'provenance/'+n for n in PROVENANCE}


def admitted_release_from_archive(archive,release,accepted,terminal):
    """Revalidate the measured release without extracting or executing missions."""
    checker=module('witness_release_checker',ROOT/'aws/mechanism-campaign-admission-v2/check_release.py')
    with tarfile.open(archive,'r:gz') as tar:
        def pinned(row):
            name=row['path'];path=PurePosixPath(name)
            need(type(name) is str and str(path)==name and not path.is_absolute()
                 and '..' not in path.parts and '\\' not in name,'Canonical release evidence path')
            raw=tar.extractfile(name).read()
            need(hashlib.sha256(raw).hexdigest()==row['sha256'],'Sealed release evidence checksum: '+name)
            return raw
        saved_accepted=strict_json(pinned(release['resourceAcceptance']))
        saved_terminal=strict_json(pinned(release['resourceTerminalAcceptance']))
        need(saved_accepted==accepted and saved_terminal==terminal,'Actual accepted reference differs from sealed release')
        profiles={k:strict_json(pinned(v)) for k,v in release['profiles'].items()}
        tasks={k:strict_json(pinned(v)) for k,v in release['taskProfiles'].items()}
        collection=strict_json(pinned(release['resourceCollectionHashes']))
        analysis=strict_json(pinned(release['analysisConfiguration']))
        pinned(release['assemblyComponent'])
        for name,digest in release['components'].items():pinned(dict(path=name,sha256=digest))
    return checker.validate(release,saved_accepted,profiles,saved_terminal,tasks,collection,analysis)


def transport(tree,archive,archive_sha,payloads,helper):
    wanted=expected_members(payloads)
    need(sha(archive)==archive_sha,'Witness archive SHA changed')
    helper.inspect_tar(archive,wanted)
    actual={p.relative_to(tree).as_posix() for p in tree.rglob('*') if not p.is_dir()}
    need(actual==wanted,'Exact extracted witness membership')
    with tarfile.open(archive,'r:') as tar:
        for row in tar.getmembers():
            path=helper.regular(tree,row.name)
            with tar.extractfile(row) as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
            need(path.stat().st_size==row.size and sha(path)==digest,'Witness body differs from TAR: '+row.name)
    pins=load(helper.regular(tree,'provenance/collection-hashes.json'))['hashes']
    excluded={'provenance/collection-hashes.json','provenance/transfer-complete.json'}
    need(set(pins)==wanted-excluded and all(sha(helper.regular(tree,n))==h for n,h in pins.items()),
         'Complete collection-body hash coverage')
    return pins


def launch_chain(intent,job,provenance,job_name,intent_sha,bundle_sha,release_sha,release,collector):
    prefix=collector.validate_launch(intent,job,job_name,'wrapper-witness',release_sha)
    need(intent['bundleSha256']==bundle_sha and intent['bootstrapSha256']==BOOTSTRAP_SHA
         and intent['entrypointSha256']==ENTRYPOINT_SHA and intent['automaticRetryAllowed'] is False,
         'Same bundle/bootstrap/entrypoint identity')
    need(intent['inputHashes']=={'bootstrap.py':BOOTSTRAP_SHA,'entrypoint.sh':ENTRYPOINT_SHA,'campaign.tar.gz':bundle_sha},
         'Exact witness staged input pins')
    spec=intent['spec'];env=spec['Environment'];cfg=spec['ProcessingResources']['ClusterConfig']
    need(spec['AppSpecification']['ContainerEntrypoint']==['bash','-lc',ENTRY_COMMAND]
         and not spec['AppSpecification'].get('ContainerArguments'), 'Exact checksum-checked entrypoint')
    need(env['CAMPAIGN_BOOTSTRAP_SHA256']==BOOTSTRAP_SHA and env['CAMPAIGN_ENTRYPOINT_SHA256']==ENTRYPOINT_SHA
         and env['CAMPAIGN_BUNDLE_SHA256']==bundle_sha and env['CAMPAIGN_RELEASE_SHA256']==release_sha,
         'Launch environment/source pins')
    resources=release['resources']
    need(cfg==dict(InstanceCount=resources['instanceCount'],InstanceType=resources['instanceType'],VolumeSizeInGB=resources['volumeGiB']),
         'Same measured production instance and volume')
    need(len(spec['ProcessingInputs'])==1 and spec['ProcessingInputs'][0]['InputName']=='campaign-input'
         and spec['ProcessingInputs'][0]['S3Input']['LocalPath']=='/opt/ml/processing/input'
         and spec['ProcessingInputs'][0]['S3Input']['S3InputMode']=='File'
         and spec['ProcessingInputs'][0]['S3Input']['S3DataType']=='S3Prefix'
         and spec['ProcessingInputs'][0]['S3Input']['S3CompressionType']=='None', 'Same sealed input mount')
    need(provenance['launch-response.json']['ProcessingJobArn']==job['ProcessingJobArn']
         and collector.matches(spec,provenance['job-describe-initial.json'])
         and provenance['submission-attempt.json']['job']==job_name
         and provenance['submission-attempt.json']['intentSha256']==intent_sha,
         'Submission response/attempt/initial-describe chain')
    return prefix


def runtime_and_completion(runtime,done,release_sha,bundle_sha):
    wanted=dict(python='3.12.13',numpy='1.26.4',scipy='1.16.3',node='v20.19.6',architecture='x86_64',cpus=48)
    need({k:runtime[k] for k in wanted}==wanted
         and all(runtime['threadSettings'][k]=='1' for k in ('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS'))
         and all(v['num_threads']==1 for v in runtime['threadpoolInfo']), 'Actual pinned x86/thread runtime')
    need(runtime['executionWrapper']==dict(bootstrapSha256=BOOTSTRAP_SHA,bundleSha256=bundle_sha,
         releaseSha256=release_sha,executionMode='development'), 'Mounted bootstrap and sealed bundle runtime chain')
    need(done['completed'] is True and done['executionMode']=='development'
         and type(done['histories']) is int and done['histories']==3
         and type(done['worlds']) is int and done['worlds']==1
         and type(done['reservedWorldsExecuted']) is int and done['reservedWorldsExecuted']==0
         and done['allProducerFullAuditsPassed'] is True and done['refinementTripletsAudited'] is False
         and done['scientificallyAccepted'] is False and done['independentDownloadedAuditRequired'] is True
         and done['manifestSha256']==DEV_SHA and done['releaseSha256']==release_sha, 'Three-history development-only completion')


def arrays(path):
    with zipfile.ZipFile(path) as z:
        rows=z.infolist()
        need(len(rows)==2 and {r.filename for r in rows}=={'positions.npy','scalar.npy'}
             and sum(r.file_size for r in rows)<512*1024**2,'Bounded exact NPZ body set')
    with np.load(path,allow_pickle=False) as z:
        need(len(z.files)==2 and set(z.files)=={'positions','scalar'},'Exact array keys')
        result={k:z[k].copy() for k in z.files}
    need(all(v.dtype.kind=='f' and np.isfinite(v).all() for v in result.values()),'Finite floating arrays')
    return result


def strict_history(path):
    with gzip.open(path,'rb') as f:raw=f.read(1024**3+1)
    need(len(raw)<=1024**3,'Bounded history expansion')
    return strict_json(raw)


def saved_case(run,cid,case,world,helper):
    def file(name):return helper.regular(run,name)
    folder='cases/'+cid+'/'
    hist=file(folder+'mission.json.gz');child=load(file(folder+'manifest.json'));done=load(file(folder+'complete.json'))
    r=file('audits/'+cid+'.json');d=file('audits/'+cid+'-diagnostics.json');z=file('audits/'+cid+'-arrays.npz')
    receipt,diagnostic=load(r),load(d)
    need(receipt['diagnosticsSha256']==sha(d) and receipt['arraysSha256']==diagnostic['arraysSha256']==sha(z),
         'Complete audit derivative body binding')
    record=strict_history(hist)
    record_binding(record,child,done,receipt,diagnostic,load(file('terminals/'+cid+'-mission.json')),
                   case,world,sha(hist),'development')
    return record,diagnostic,arrays(z),receipt,sha(hist)


def verify(a):
    helper,collector,bootstrap=source_dependencies()
    accepted=load(a.resource_accepted);terminal=load(a.resource_terminal)
    accepted_sha=sha(a.resource_accepted);terminal_sha=sha(a.resource_terminal)
    need(sha(a.resource_terminal)==a.resource_terminal_sha256,'Pinned reference terminal receipt')
    proof=reference_coverage(accepted,terminal,sha(a.resource_accepted))
    # The real reference must be accepted before creating any witness output.
    ref_collector=module('resource_collector',ROOT/'scripts/collect-mechanism-resource-v2.py')
    ref_wanted=helper.expected_members(ref_collector.expected_payloads())
    helper.verify_transport(a.reference_producer,a.reference_archive,ref_wanted,REFERENCE_TAR_SHA)
    need(sha(a.reference_producer/'provenance/collection-hashes.json')==REFERENCE_COLLECTION_SHA,'Original reference body ledger')
    bootstrap.validate_archive(a.bundle,a.bundle_sha256,a.release_sha256)
    with tarfile.open(a.bundle,'r:gz') as tar:
        release_raw=tar.extractfile('metadata/campaign-release.json').read()
        dev_raw=tar.extractfile('metadata/development_manifest.json').read()
        routing_raw=tar.extractfile('aws/mechanism-campaign-v1/audit-index.json').read()
    need(hashlib.sha256(release_raw).hexdigest()==a.release_sha256
         and hashlib.sha256(dev_raw).hexdigest()==DEV_SHA,'Sealed release/development manifest body')
    release=strict_json(release_raw);development=strict_json(dev_raw);routing=strict_json(routing_raw)
    need(release['resourceAcceptance']['sha256']==sha(a.resource_accepted)
         and release['resourceTerminalAcceptance']['sha256']==sha(a.resource_terminal), 'Same admitted resource evidence in bundle')
    admitted_release_from_archive(a.bundle,release,accepted,terminal)
    payloads=collector.expected_payloads(routing,'wrapper-witness')
    wanted=expected_members(payloads);helper.inspect_tar(a.archive,wanted)
    dest=a.destination.absolute()
    need(not dest.exists() and dest.parent.is_dir() and dest.resolve().is_relative_to(ROOT)
         and not any(p.is_symlink() for p in (dest,*dest.parents)), 'Fresh workspace verification destination')
    need(not dest.resolve().is_relative_to(a.reference_producer.resolve())
         and not a.reference_producer.resolve().is_relative_to(dest.resolve()), 'Do not overlap saved references')
    need(sha(a.archive)==a.archive_sha256 and shutil.disk_usage(dest.parent).free>a.archive.stat().st_size+1024**3,
         'Pinned archive and download capacity')
    dest.mkdir();result=dict(version='mechanism-campaign-wrapper-admission-v1',accepted=False,
        numericalSameWrapperAdmissionPassed=False,independentDownloadedAuditPassed=False,
        image=IMAGE,bundleSha256=a.bundle_sha256,releaseSha256=a.release_sha256,bootstrapSha256=BOOTSTRAP_SHA,
        workerSha256=WORKER_SHA,developmentHistories=0,reservedWorldsExecuted=0,
        sourceScriptSha256=sha(Path(__file__)),witnessJob=a.job,archiveSha256=a.archive_sha256,
        resourceVerificationSha256=sha(a.resource_accepted),resourceTerminalSha256=sha(a.resource_terminal),
        newMissions=0,awsCalls=0,productionAdmitted=False,scientificallyAccepted=False)
    try:
        tree=dest/'download';tree.mkdir()
        with tarfile.open(a.archive,'r:') as tar:tar.extractall(tree,filter='data')
        transport(tree,a.archive,a.archive_sha256,payloads,helper)
        out=tree/'output';prov=tree/'provenance'
        provenance={n:load(prov/n) for n in PROVENANCE}
        need(sha(prov/'launch-intent.json')==a.intent_sha256,'Witness intent SHA')
        prefix=launch_chain(provenance['launch-intent.json'],provenance['describe-processing-job.json'],provenance,
            a.job,a.intent_sha256,a.bundle_sha256,a.release_sha256,release,collector)
        size=helper.verify_inventory(tree,a.job,collector.BUCKET,prefix,payloads)
        marker=provenance['transfer-complete.json']
        need(marker['transportVerified'] is True and marker['histories']==3 and marker['outputObjects']==44
             and marker['collectorSha256']==PINS['scripts/collect-mechanism-wrapper-witness-v1.py']
             and marker['intentSha256']==a.intent_sha256 and marker['releaseSha256']==a.release_sha256
             and marker['scientificallyAccepted'] is False,'Collector terminal/body chain')
        runtime_and_completion(load(out/'runtime.json'),load(out/'complete.json'),a.release_sha256,a.bundle_sha256)
        need(load(out/'payload-index.json')==dict(version='mechanism-campaign-wrapper-output-v2',executionMode='development',payloads=sorted(payloads))
             and load(out/'release.json')==release and (out/'audit-index.json').read_bytes()==routing_raw,'Exact output index/release/routing')
        messages=[e['message'] for e in provenance['cloudwatch.json']['events']]
        need(messages.count('WRAPPER_DEVELOPMENT_COMPLETE_INDEPENDENT_AUDIT_REQUIRED')==1
             and all(messages.count('CAMPAIGN_CASE_COMPLETED '+cid)==1 for cid in CASES),'Exact three-case terminal log markers')
        by_case={c['id']:c for c in development['cases']};worlds={w['key']:w for w in development['worlds']}
        reference= a.reference_producer/'output/runs/candidate';rows=[]
        for cid in CASES:
            case=by_case[cid];world=worlds[case['worldKey']]
            old=saved_case(reference,cid,case,world,helper);new=saved_case(out/'run',cid,case,world,helper)
            need(old[4]==proof[cid]['historySha256'],'Accepted reference history differs')
            need(new[3]['releaseSha256']==a.release_sha256 and new[3]['executionMode']=='development', 'Witness audit release/mode chain')
            process=load(helper.regular(out/'run','terminals/'+cid+'-audit.json'))
            task=load(helper.regular(out/'run','resources/'+cid+'.json'))
            need(type(process['exitCode']) is int and process['exitCode']==0 and process['timedOut'] is False
                 and type(task['exitCode']) is int and task['exitCode']==0 and task['timedOut'] is False
                 and task['cancelled'] is False and task['samples']>0, 'Witness auditor/task process did not finish')
            comparison=exact_equivalence(old[0],new[0],old[1],new[1],old[2],new[2])
            rows.append(dict(caseId=cid,referenceHistorySha256=old[4],witnessHistorySha256=new[4],comparison=comparison))
        transport(tree,a.archive,a.archive_sha256,payloads,helper)
        helper.verify_transport(a.reference_producer,a.reference_archive,ref_wanted,REFERENCE_TAR_SHA)
        need(sha(a.resource_accepted)==accepted_sha and sha(a.resource_terminal)==terminal_sha
             and sha(a.bundle)==a.bundle_sha256,'Reference receipt or sealed bundle changed during checks')
        for name,h in PINS.items():need(sha(ROOT/name)==h,'Verification source changed during checks')
        result.update(accepted=True,numericalSameWrapperAdmissionPassed=True,independentDownloadedAuditPassed=True,
            developmentHistories=3,verifiedHistories=rows,outputObjects=44,outputBytes=size,
            checkedAtUTC=datetime.now(timezone.utc).isoformat(),acceptanceScope='Exact same-bundle development execution equivalence only')
        bootstrap.wrapper_admission(result,a.bundle_sha256,a.release_sha256,BOOTSTRAP_SHA)
    except BaseException as error:
        result.update(accepted=False,numericalSameWrapperAdmissionPassed=False,independentDownloadedAuditPassed=False)
        result['error']=type(error).__name__+': '+str(error);raise
    finally:
        write(dest/'wrapper-admission.json',result)
    return result


def main():
    p=argparse.ArgumentParser()
    for n in ('archive','bundle','resource-accepted','resource-terminal','reference-producer','reference-archive','destination'):
        p.add_argument('--'+n,type=Path,required=True)
    for n in ('archive-sha256','bundle-sha256','release-sha256','resource-terminal-sha256','intent-sha256','job'):
        p.add_argument('--'+n,required=True)
    result=verify(p.parse_args())
    print(json.dumps({k:v for k,v in result.items() if k!='verifiedHistories'},indent=2),flush=True)


if __name__=='__main__':main()
