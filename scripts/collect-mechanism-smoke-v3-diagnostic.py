"""Read-only AWS collection; writes one diagnostic archive to fresh /tmp storage.

No job mutation, upload, simulation, audit, credential change or home-directory
write. Intended for the already authorised CloudShell session.
"""
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile

JOB = 'plumenav-mech-smoke-v3-20260928-075429'
ACCOUNT = '380061838272'
BUCKET = 'sagemaker-us-east-1-380061838272'
BASE = 'plumenav/mechanism/20260927-v3-0dc89ec6cf44/'
PREFIX = BASE + 'jobs/' + JOB + '/output/'


def main():
    import boto3
    from botocore.config import Config
    session = boto3.Session(region_name='us-east-1')
    cfg = Config(retries={'mode': 'standard', 'max_attempts': 3})
    assert session.client('sts', config=cfg).get_caller_identity()['Account'] == ACCOUNT
    sm, s3, logs = (session.client(n, config=cfg) for n in ('sagemaker', 's3', 'logs'))
    job = sm.describe_processing_job(ProcessingJobName=JOB)
    assert job['ProcessingJobStatus'] == 'Failed'
    assert job['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3Uri'] == 's3://' + BUCKET + '/' + PREFIX

    def inventory():
        rows = [r for p in s3.get_paginator('list_objects_v2').paginate(
            Bucket=BUCKET, Prefix=PREFIX, ExpectedBucketOwner=ACCOUNT) for r in p.get('Contents', [])]
        assert rows and len(rows) == len({r['Key'] for r in rows})
        for r in rows:
            rel = r['Key'][len(PREFIX):]
            p = PurePosixPath(rel)
            assert r['Key'].startswith(PREFIX) and rel and not p.is_absolute()
            assert '..' not in p.parts and str(p) == rel
        return sorted(rows, key=lambda r: r['Key'])

    rows = inventory()
    size = sum(r['Size'] for r in rows)
    assert size < 200_000_000 and shutil.disk_usage('/tmp').free > size * 3 + 100_000_000
    folder = Path(tempfile.mkdtemp(prefix='plumenav-v3-diagnostic-', dir='/tmp'))
    archive = folder / (JOB + '-terminal.tar')
    hashes = {}
    with tarfile.open(archive, 'x') as tar:
        def add(name, body):
            info = tarfile.TarInfo(name)
            info.size = len(body)
            info.mode = 0o600
            tar.addfile(info, io.BytesIO(body))
            hashes[name] = hashlib.sha256(body).hexdigest()

        def record(name, obj):
            add('provenance/' + name, (json.dumps(obj, indent=2, default=str) + '\n').encode())

        record('describe-processing-job.json', job)
        for row in rows:
            body = s3.get_object(Bucket=BUCKET, Key=row['Key'], ExpectedBucketOwner=ACCOUNT,
                                 IfMatch=row['ETag'])['Body'].read()
            assert len(body) == row['Size']
            add('output/' + row['Key'][len(PREFIX):], body)
        assert rows == inventory(), 'Terminal S3 inventory changed during collection'
        record('s3-index.json', dict(job=JOB, bucket=BUCKET, prefix=PREFIX,
            collectedAt=datetime.now(timezone.utc).isoformat(), diagnosticOnly=True,
            objects=[dict(relative=r['Key'][len(PREFIX):], bytes=r['Size'],
                          etag=r['ETag'], lastModified=r['LastModified']) for r in rows]))
        for name in ('launch-intent.json', 'submission-attempt.json', 'launch-response.json', 'job-describe-initial.json'):
            key = BASE + 'provenance/' + JOB + '/' + name
            add('provenance/' + name, s3.get_object(Bucket=BUCKET, Key=key,
                ExpectedBucketOwner=ACCOUNT)['Body'].read())
        events = []
        token = None
        while True:
            args = dict(logGroupName='/aws/sagemaker/ProcessingJobs',
                logStreamName=JOB + '/algo-1-1790582163', startFromHead=True)
            if token:
                args['nextToken'] = token
            page = logs.get_log_events(**args)
            events.extend(page['events'])
            following = page['nextForwardToken']
            if following == token:
                break
            token = following
        record('cloudwatch.json', events)
        record('collection-hashes.json', dict(hashes))
    with archive.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    print(json.dumps(dict(archive=str(archive), bytes=archive.stat().st_size,
        sha256=digest, outputObjects=len(rows), outputBytes=size,
        diagnosticOnly=True, accepted=False)), flush=True)


if __name__ == '__main__':
    main()
