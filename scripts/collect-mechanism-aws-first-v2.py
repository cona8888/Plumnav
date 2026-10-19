"""Collect the completed six-history AWS smoke into a sealed /tmp transfer TAR.

Read-only AWS APIs; no simulation, job mutation, upload, or home-directory write.
The transfer TAR is not a scientific acceptance receipt.
"""

from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile

ACCOUNT = '380061838272'
REGION = 'us-east-1'
BUCKET = 'sagemaker-us-east-1-380061838272'
JOB = 'plumenav-mech-awsfirst-v2-20260928-232116'
BASE = 'plumenav/mechanism/20260928-awsfirst-v2-33bcca72a005/'
PREFIX = BASE + 'jobs/' + JOB + '/output/'
EXPECTED_ROOT = {
    'PAYLOAD_SHA256SUMS_V1', 'complete.json', 'freeze.json',
    'payload-index.json', 'runtime.json', 'start.json',
}
PROVENANCE = (
    'launch-intent.json', 'submission-attempt.json',
    'launch-response.json', 'job-describe-initial.json',
)


def main():
    import boto3
    from botocore.config import Config

    session = boto3.Session(region_name=REGION)
    cfg = Config(retries={'mode': 'standard', 'max_attempts': 3})
    assert session.client('sts', config=cfg).get_caller_identity()['Account'] == ACCOUNT
    sm, s3, logs = (session.client(n, config=cfg) for n in ('sagemaker', 's3', 'logs'))
    job = sm.describe_processing_job(ProcessingJobName=JOB)
    assert job['ProcessingJobStatus'] == 'Completed' and not job.get('FailureReason')
    assert job['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3Uri'] == (
        's3://' + BUCKET + '/' + PREFIX
    )

    def inventory():
        rows = [r for page in s3.get_paginator('list_objects_v2').paginate(
            Bucket=BUCKET, Prefix=PREFIX, ExpectedBucketOwner=ACCOUNT
        ) for r in page.get('Contents', [])]
        assert rows and len(rows) == len({r['Key'] for r in rows})
        for row in rows:
            relative = row['Key'][len(PREFIX):]
            path = PurePosixPath(relative)
            assert row['Key'].startswith(PREFIX) and relative
            assert not path.is_absolute() and '..' not in path.parts
            assert str(path) == relative
        return sorted(rows, key=lambda row: row['Key'])

    rows = inventory()
    relative = {row['Key'][len(PREFIX):] for row in rows}
    size = sum(row['Size'] for row in rows)
    assert len(rows) == 69 and {r for r in relative if '/' not in r} == EXPECTED_ROOT
    assert len([r for r in relative if r.endswith('/mission.json.gz')]) == 6
    assert size < 250_000_000 and shutil.disk_usage('/tmp').free > 3 * size + 100_000_000

    folder = Path(tempfile.mkdtemp(prefix='plumenav-awsfirst-v2-transfer-', dir='/tmp'))
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
            body = s3.get_object(Bucket=BUCKET, Key=row['Key'],
                ExpectedBucketOwner=ACCOUNT, IfMatch=row['ETag'])['Body'].read()
            assert len(body) == row['Size']
            add('output/' + row['Key'][len(PREFIX):], body)
        assert rows == inventory(), 'Terminal S3 inventory changed during collection'
        record('s3-index.json', dict(job=JOB, bucket=BUCKET, prefix=PREFIX,
            collectedAt=datetime.now(timezone.utc).isoformat(),
            objects=[dict(relative=row['Key'][len(PREFIX):], bytes=row['Size'],
                etag=row['ETag'], lastModified=row['LastModified']) for row in rows]))
        for name in PROVENANCE:
            key = BASE + 'provenance/' + JOB + '/' + name
            add('provenance/' + name, s3.get_object(Bucket=BUCKET, Key=key,
                ExpectedBucketOwner=ACCOUNT)['Body'].read())
        streams = logs.describe_log_streams(logGroupName='/aws/sagemaker/ProcessingJobs',
            logStreamNamePrefix=JOB + '/')['logStreams']
        assert len(streams) == 1
        events = []
        token = None
        while True:
            args = dict(logGroupName='/aws/sagemaker/ProcessingJobs',
                logStreamName=streams[0]['logStreamName'], startFromHead=True)
            if token:
                args['nextToken'] = token
            page = logs.get_log_events(**args)
            events.extend(page['events'])
            following = page['nextForwardToken']
            if following == token:
                break
            token = following
        record('cloudwatch.json', dict(logGroup='/aws/sagemaker/ProcessingJobs',
            logStream=streams[0]['logStreamName'], events=events))
        record('collection-hashes.json', {'hashes': dict(hashes)})
    with archive.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    print('TRANSFER_READY ' + json.dumps(dict(archive=str(archive),
        bytes=archive.stat().st_size, sha256=digest,
        outputObjects=len(rows), outputBytes=size, histories=6,
        scientificallyAccepted=False)), flush=True)


if __name__ == '__main__':
    main()
