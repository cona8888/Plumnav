"""Read-only terminal resource-witness collector. No AWS mutations or audits.

Use the observed job and launch-intent hash, never a guessed job. Stream a sealed
TAR to a fresh /tmp directory only if its exact 1449-object inventory fits. Full
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
BASE='plumenav/mechanism/20260929-resource-v1-7f6b8e800a3c/'
PROVENANCE=('launch-intent.json','submission-attempt.json','launch-response.json','job-describe-initial.json')


def need(ok, why):
    if not ok: raise ValueError(why)


def expected_payloads():
    names={'start.json','runtime.json','execution-freeze.json','complete.json',
        'profile-baseline.json','profile-candidate.json','profile-stress.json','payload-index.json'}
    for phase in ('baseline','candidate','stress-a','stress-b'):
        for arm in ('RW','GW','RL','GL','NS'):
            for field in ('si-continuous','si-pulse','blank'):
                for dt in ((16,32,64) if phase in ('baseline','candidate') else (64,)):
                    cid=f'mechanism-development-3000-{arm}-{field}-n{dt}'
                    prefix='runs/'+phase+'/'
                    names|={prefix+'cases/'+cid+'/'+n for n in ('manifest.json','complete.json','mission.json.gz')}
                    names|={prefix+'audits/'+cid+n for n in ('.json','-diagnostics.json','-arrays.npz')}
                    names|={prefix+'logs/'+cid+'-'+r+'.log' for r in ('mission','audit','task')}
                    names|={prefix+'terminals/'+cid+'-'+r+'.json' for r in ('mission','audit')}
                    names.add(prefix+'resources/'+cid+'.json')
    need(len(names)==1448,'Fixed witness membership')
    return names


def validate_job_name(name):
    need(re.fullmatch(r'plumenav-mech-resource-v1-[0-9]{8}-[0-9]{6}',name) is not None,'Not a resource-witness job')


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
    need(intent['spec']['ProcessingJobName']==a.job and intent['inputHashes']['execution.tar.gz']=='7f6b8e800a3ccf991b224f17d1e2ad669d26ddf35264a49be55e1e8ebb87c800','Wrong witness execution')

    def inventory():
        rows=[r for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET,Prefix=prefix,ExpectedBucketOwner=ACCOUNT) for r in page.get('Contents',[])]
        need(len(rows)==1449 and {r['Key'][len(prefix):] for r in rows}==expected_payloads()|{'PAYLOAD_SHA256SUMS_V1'},'Missing, extra or duplicate output objects')
        return sorted(rows,key=lambda r:r['Key'])

    rows=inventory(); size=sum(r['Size'] for r in rows)
    # Reserve for provenance, TAR headers and unrelated live CloudShell activity.
    need(size<8*1024**3 and shutil.disk_usage('/tmp').free>size+1024**3,
        'Terminal witness does not fit /tmp; use a separately approved transfer route, not the full home')
    folder=Path(tempfile.mkdtemp(prefix='plumenav-resource-transfer-',dir='/tmp'))
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
        outputObjects=1449,outputBytes=size,histories=120,scientificallyAccepted=False)),flush=True)


if __name__=='__main__': main()
