"""Read-only terminal independent-resource-audit collector. No AWS mutations or audits.

Use the observed job and launch-intent hash, never a guessed job. Stream a sealed
TAR to a fresh /tmp directory only if its exact 486-object inventory fits. Full
campaign collection is intentionally outside this development-only utility.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile

ACCOUNT='380061838272'
REGION='us-east-1'
BUCKET='sagemaker-us-east-1-380061838272'
BASE='plumenav/mechanism/20260930-resource-independent-audit-v2-d8c4570e3040/'
PROVENANCE=('launch-intent.json','submission-attempt.json','launch-response.json','job-describe-initial.json')


def need(ok, why):
    if not ok: raise ValueError(why)


def expected_payloads():
    names = {'runtime.json', 'audit-driver.log', 'verification.json', 'complete.json', 'payload-index.json'}
    for phase in ('baseline', 'candidate', 'stress-a', 'stress-b'):
        for arm in ('RW', 'GW', 'RL', 'GL', 'NS'):
            for field in ('si-continuous', 'si-pulse', 'blank'):
                for dt in ((16, 32, 64) if phase in ('baseline', 'candidate') else (64,)):
                    cid = f'mechanism-development-3000-{arm}-{field}-n{dt}'
                    names |= {'independent-audit/runs/' + phase + '/audits/' + cid + suffix
                              for suffix in ('.json', '-diagnostics.json', '-arrays.npz')}
                    names.add('independent-audit/logs/' + phase + '/' + cid + '.log')
    need(len(names) == 485, 'Fixed independent audit membership')
    return names


def validate_job_name(name):
    need(re.fullmatch(r'plumenav-mech-resource-audit-v2-[0-9]{8}-[0-9]{6}',name) is not None,'Not an independent-resource-audit job')

def matches(expected,actual):
    if isinstance(expected,dict):
        return isinstance(actual,dict) and all(k in actual and matches(v,actual[k]) for k,v in expected.items())
    if isinstance(expected,list):
        return isinstance(actual,list) and len(expected)==len(actual) and all(matches(a,b) for a,b in zip(expected,actual))
    return type(expected)==type(actual) and expected==actual


def validate_launch(intent,job,name):
    validate_job_name(name)
    inputs={
        'bootstrap.py':'c40022a44263c038d957837c4905dd5eea9021ed439b3632d4ab2b777c360f8b',
        'entrypoint.sh':'c77e5b9fcac124c9648aa91c1adc20ae43b8f0482fb3c9089551f9663113a659',
        'overlay.tar.gz':'d8c4570e3040ff62b185741e1ac643a052b2749bc8fb79613d2a34861cfbb47b',
    }
    need(intent['inputHashes']==inputs and intent['newMissions']==0 and intent['productionAdmitted'] is False
         and intent['zipSha256']=='0c99fa9160c49e5188ea8d350fe00d3a19b3f7d6c6931ed186b2e5893e391bf2'
         and intent['packageSha256']=='38128ac105bfe8c56c3621a1327f1ea1dd059100af29a2fded4e76239ccfca9c'
         and intent['archiveSha256']=='e5700b6a9e4f2ee5aa0a21d27a2c3d158ecf95f1d35f5689f573d5ff6aba90a7'
         and intent['archiveBytes']==1897267200,'Independent audit exact input identity')
    spec=intent['spec']
    need(spec['ProcessingJobName']==name
         and spec['AppSpecification']['ImageUri']=='885854791233.dkr.ecr.us-east-1.amazonaws.com/sagemaker-distribution-prod@sha256:2ae2a90be54895e8ef66b4a26a913c57d1ee52f5429055afe652627ddbfa253a'
         and spec['RoleArn']=='arn:aws:iam::380061838272:role/service-role/AmazonSageMaker-ExecutionRole-20230925T144582'
         and spec['ProcessingResources']['ClusterConfig']==dict(InstanceCount=1,InstanceType='ml.m5.12xlarge',VolumeSizeInGB=100)
         and spec['StoppingCondition']==dict(MaxRuntimeInSeconds=7200)
         and spec['Environment']['MECHANISM_INDEPENDENT_AUDIT_APPROVED']=='YES','Independent audit runtime/resource scope')
    env=spec['Environment']
    need(all(env[key]=='1' for key in ('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS'))
         and env['AUDIT_BOOTSTRAP_SHA256']==inputs['bootstrap.py']
         and env['AUDIT_ENTRYPOINT_SHA256']==inputs['entrypoint.sh']
         and env['AUDIT_OVERLAY_SHA256']==inputs['overlay.tar.gz'],'Independent audit source/thread environment')
    need([r['S3Input']['S3Uri'] for r in spec['ProcessingInputs']]==[
         's3://'+BUCKET+'/'+BASE+'input/',
         's3://'+BUCKET+'/'+BASE+'evidence/plumenav-mech-resource-v2-20260930-050952-terminal.tar',
         's3://'+BUCKET+'/plumenav/manual-transfer-20260930/PlumeNav_mechanism_resource_20260930_v2_attempt01.zip'],
         'Independent audit private evidence URIs')
    need(spec['ProcessingOutputConfig']['Outputs']==[dict(OutputName='independent-audit',S3Output=dict(
         LocalPath='/opt/ml/processing/output',S3Uri='s3://'+BUCKET+'/'+BASE+'jobs/'+name+'/output/',
         S3UploadMode='Continuous'))],'Independent audit exact private output')
    need(matches(spec,job),'Actual AWS audit differs from immutable intent')
    need(job['ProcessingJobArn']=='arn:aws:sagemaker:'+REGION+':'+ACCOUNT+':processing-job/'+name,
         'Independent audit ARN/account')
    need(job['ProcessingJobStatus']=='Completed' and not job.get('FailureReason')
         and job.get('ProcessingStartTime') and job.get('ProcessingEndTime'),'Audit not cleanly terminal')


class HashingReader:
    def __init__(self, body):
        self.body=body; self.hash=hashlib.sha256(); self.count=0
    def read(self,n=-1):
        data=self.body.read(n); self.hash.update(data); self.count+=len(data)
        return data


def main():
    p=argparse.ArgumentParser(); p.add_argument('--job',required=True)
    p.add_argument('--intent-sha256',required=True); a=p.parse_args()
    validate_job_name(a.job)
    need(re.fullmatch('[0-9a-f]{64}',a.intent_sha256) is not None,'Intent hash required')
    import boto3
    from botocore.config import Config
    session=boto3.Session(region_name=REGION)
    cfg=Config(retries={'total_max_attempts':4,'mode':'standard'},connect_timeout=10,read_timeout=60)
    client=lambda n:session.client(n,config=cfg)
    need(client('sts').get_caller_identity()['Account']==ACCOUNT,'Account mismatch')
    s3,sm,logs=(client(n) for n in ('s3','sagemaker','logs'))
    prefix=BASE+'jobs/'+a.job+'/output/'
    job=sm.describe_processing_job(ProcessingJobName=a.job)
    need(job['ProcessingJobStatus']=='Completed' and not job.get('FailureReason')
        and job.get('ProcessingStartTime') and job.get('ProcessingEndTime'),'Job not cleanly terminal')
    need(job['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3Uri']=='s3://'+BUCKET+'/'+prefix,'Wrong private output')
    intent_raw=s3.get_object(Bucket=BUCKET,Key=BASE+'provenance/'+a.job+'/launch-intent.json',ExpectedBucketOwner=ACCOUNT)['Body'].read()
    need(hashlib.sha256(intent_raw).hexdigest()==a.intent_sha256,'Launch intent changed')
    intent=json.loads(intent_raw)
    validate_launch(intent,job,a.job)

    def inventory():
        rows=[r for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET,Prefix=prefix,ExpectedBucketOwner=ACCOUNT) for r in page.get('Contents',[])]
        need(len(rows)==486 and {r['Key'][len(prefix):] for r in rows}==expected_payloads()|{'PAYLOAD_SHA256SUMS_V1'},'Missing, extra or duplicate output objects')
        return sorted(rows,key=lambda r:r['Key'])

    rows=inventory(); size=sum(r['Size'] for r in rows)
    # Reserve for provenance, TAR headers and unrelated live CloudShell activity.
    need(size<8*1024**3 and shutil.disk_usage('/tmp').free>size+1024**3,
        'Terminal witness does not fit /tmp; use a separately approved transfer route, not the full home')
    folder=Path(tempfile.mkdtemp(prefix='plumenav-independent-audit-transfer-',dir='/tmp'))
    archive=folder/(a.job+'-terminal.tar'); hashes={}
    with tarfile.open(archive,'x') as tar:
        def add(name,raw):
            info=tarfile.TarInfo(name); info.size=len(raw); info.mode=0o600
            tar.addfile(info,io.BytesIO(raw)); hashes[name]=hashlib.sha256(raw).hexdigest()
        def record(name,value):
            add('provenance/'+name,(json.dumps(value,indent=2,default=str)+'\n').encode())
        record('describe-processing-job.json',job)
        for row in rows:
            body=s3.get_object(Bucket=BUCKET,Key=row['Key'],ExpectedBucketOwner=ACCOUNT,IfMatch=row['ETag'])['Body']
            try:
                reader=HashingReader(body); name='output/'+row['Key'][len(prefix):]
                info=tarfile.TarInfo(name); info.size=row['Size']; info.mode=0o600
                tar.addfile(info,reader)
                need(reader.count==row['Size'] and body.read(1)==b'','S3 byte count changed')
                hashes[name]=reader.hash.hexdigest()
            finally: body.close()
        need(rows==inventory(),'Terminal output changed during transfer')
        record('s3-index.json',dict(job=a.job,bucket=BUCKET,prefix=prefix,collectedAt=datetime.now(timezone.utc).isoformat(),
            objects=[dict(relative=r['Key'][len(prefix):],bytes=r['Size'],etag=r['ETag'],lastModified=r['LastModified']) for r in rows]))
        for name in PROVENANCE:
            raw=s3.get_object(Bucket=BUCKET,Key=BASE+'provenance/'+a.job+'/'+name,ExpectedBucketOwner=ACCOUNT)['Body'].read()
            if name=='launch-intent.json': need(raw==intent_raw,'Intent changed during transfer')
            add('provenance/'+name,raw)
        streams=[r for page in logs.get_paginator('describe_log_streams').paginate(logGroupName='/aws/sagemaker/ProcessingJobs',logStreamNamePrefix=a.job+'/') for r in page['logStreams']]
        need(len(streams)==1,'One-instance log stream expected')
        events=[]; token=None
        while True:
            args=dict(logGroupName='/aws/sagemaker/ProcessingJobs',logStreamName=streams[0]['logStreamName'],startFromHead=True)
            if token: args['nextToken']=token
            page=logs.get_log_events(**args); events.extend(page['events'])
            following=page['nextForwardToken']
            if following==token: break
            token=following
        record('cloudwatch.json',dict(logGroup='/aws/sagemaker/ProcessingJobs',logStream=streams[0]['logStreamName'],events=events))
        record('collection-hashes.json',dict(hashes=dict(hashes)))
    with archive.open('rb') as source: digest=hashlib.file_digest(source,'sha256').hexdigest()
    print('TRANSFER_READY '+json.dumps(dict(archive=str(archive),sha256=digest,bytes=archive.stat().st_size,
        outputObjects=486,outputBytes=size,histories=120,scientificallyAccepted=False)),flush=True)


if __name__=='__main__': main()

