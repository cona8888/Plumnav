"""Read-only three-history wrapper-witness download; no campaign acceptance.

No AWS writes, mission execution or numerical acceptance. Uses fresh /tmp or
another explicit scratch volume, never CloudShell home. This small witness can
make a bounded TAR copy for download. Its contract needs a future launch tool;
fixture success does not establish that any campaign has run or been admitted.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile

ACCOUNT = '380061838272'
REGION = 'us-east-1'
BUCKET = 'sagemaker-us-east-1-380061838272'
IMAGE = '885854791233.dkr.ecr.us-east-1.amazonaws.com/sagemaker-distribution-prod@sha256:2ae2a90be54895e8ef66b4a26a913c57d1ee52f5429055afe652627ddbfa253a'
ROLE = 'arn:aws:iam::380061838272:role/service-role/AmazonSageMaker-ExecutionRole-20230925T144582'
INDEX_SHA = 'de17dcd5e156970f16944104286e825952f4eaebd9f5de66203e873e8c5cc2d8'
MANIFEST_SHA = '625706ed07b9be7415f81d214272348d1f5757cb32833f14cf4272aecddb7e6d'
LEDGER = 'PAYLOAD_SHA256SUMS_V1'
PROVENANCE = ('launch-intent.json', 'submission-attempt.json', 'launch-response.json', 'job-describe-initial.json')


def need(ok, why):
    if not ok:
        raise ValueError(why)


def strict_json(raw):
    def pairs(rows):
        out = {}
        for k, v in rows:
            need(k not in out, 'Duplicate JSON key'); out[k] = v
        return out
    def constant(value):
        raise ValueError('Nonfinite JSON: ' + value)
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def sha(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def safe(name):
    need(type(name) is str and name, 'Empty/non-string path')
    p = PurePosixPath(name)
    need(str(p) == name and not p.is_absolute() and '..' not in p.parts
         and '\\' not in name and not any(ord(c) < 32 for c in name), 'Unsafe relative path')
    return name


CASES = ('mechanism-development-3000-RW-si-continuous-n64',
         'mechanism-development-3000-GL-si-pulse-n64',
         'mechanism-development-3000-NS-blank-n64')
DEV_SHA = '666126c63b3d9e4cd6686320ed8c6a49a643bd1783ac8e09aaa408cc6db49946'


def expected_payloads(index, kind):
    need(kind=='wrapper-witness', 'Only fixed development witness collection')
    need(len(index['historyIds'])==2400 and len(index['resolutionTriplets'])==240
         and index['containsOutcomes'] is False, 'Pinned prospective routing required')
    names={'start.json','runtime.json','release.json','complete.json','payload-index.json',
           'resource-profile.json','audit-index.json'}
    for cid in CASES:
        names|={'run/cases/'+cid+'/'+n for n in ('manifest.json','complete.json','mission.json.gz')}
        names|={'run/audits/'+cid+n for n in ('.json','-diagnostics.json','-arrays.npz')}
        names|={'run/logs/'+cid+'-'+r+'.log' for r in ('mission','audit','task')}
        names|={'run/terminals/'+cid+'-'+r+'.json' for r in ('mission','audit')}
        names.add('run/resources/'+cid+'.json')
    need(len(names)==43,'Exact three-history witness membership')
    return names


def matches(expected, actual):
    if type(expected) is dict:
        return type(actual) is dict and all(k in actual and matches(v, actual[k]) for k, v in expected.items())
    if type(expected) is list:
        return type(actual) is list and len(expected) == len(actual) and all(matches(a, b) for a, b in zip(expected, actual))
    return type(expected) is type(actual) and expected == actual


def private_key(uri):
    prefix = 's3://' + BUCKET + '/'
    need(type(uri) is str and uri.startswith(prefix), 'Wrong private bucket')
    key = uri[len(prefix):]
    # A trailing slash is an S3 prefix, not a local file name.
    safe(key.rstrip('/'))
    need(key.startswith('plumenav/mechanism/'), 'Outside scoped mechanism prefix')
    return key


def validate_launch(intent, actual, name, kind, release_sha):
    need(kind=='wrapper-witness', 'Witness launch kind only')
    scope = 'wrapper-witness'
    need(re.fullmatch(r'plumenav-mech-' + scope + r'-v[0-9]+-[0-9]{8}-[0-9]{6}', name), 'Wrong campaign job kind')
    need(intent['version'] == 'mechanism-campaign-launch-intent-v1' and intent['kind'] == kind
         and intent['releaseSha256'] == release_sha and intent['manifestSha256'] == MANIFEST_SHA
         and intent['auditIndexSha256'] == INDEX_SHA and type(intent['histories']) is int and intent['histories'] == 3
         and intent['developmentManifestSha256']==DEV_SHA and intent['developmentCases']==list(CASES)
         and type(intent['reservedWorldsExecuted']) is int and intent['reservedWorldsExecuted']==0
         and intent['scientificallyAccepted'] is False, 'Launch contract/source binding')
    need(type(intent['inputHashes']) is dict and bool(intent['inputHashes'])
         and all(re.fullmatch('[0-9a-f]{64}', v) for v in intent['inputHashes'].values()), 'Pinned input hashes required')
    spec = intent['spec']
    need(spec['ProcessingJobName'] == name and spec['RoleArn'] == ROLE
         and spec['AppSpecification']['ImageUri'] == IMAGE, 'Pinned account/role/image')
    resource = spec['ProcessingResources']['ClusterConfig']
    need(resource['InstanceCount'] == 1 and resource['InstanceType'] == 'ml.m5.12xlarge'
         and type(resource['VolumeSizeInGB']) is int and resource['VolumeSizeInGB'] >= 100,
         'One measured x86 resource required')
    cap = spec['StoppingCondition']['MaxRuntimeInSeconds']
    need(type(cap) is int and 0 < cap <= 7200, 'Bounded managed runtime')
    env = spec['Environment']
    need(all(env[k] == '1' for k in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS')),
         'Single-thread numerical environment')
    need(env.get('MECHANISM_DEVELOPMENT_APPROVED')=='YES'
         and env.get('MECHANISM_CAMPAIGN_APPROVED','NO')!='YES'
         and env.get('MECHANISM_INSPECTION_APPROVED','NO')!='YES', 'Development-only execution approval')
    inputs = spec['ProcessingInputs']
    need(inputs and len({r['InputName'] for r in inputs}) == len(inputs), 'Unique staged inputs required')
    for row in inputs:
        private_key(row['S3Input']['S3Uri'])
    outputs = spec['ProcessingOutputConfig']['Outputs']
    need(len(outputs) == 1 and outputs[0]['S3Output']['LocalPath'] == '/opt/ml/processing/output'
         and outputs[0]['S3Output']['S3UploadMode'] == 'Continuous', 'One continuous terminal output')
    prefix = private_key(outputs[0]['S3Output']['S3Uri'])
    need(prefix.endswith('/jobs/' + name + '/output/'), 'Job-owned output prefix')
    need(matches(spec, actual), 'AWS job differs from immutable intent')
    need(actual['ProcessingJobArn'] == 'arn:aws:sagemaker:' + REGION + ':' + ACCOUNT + ':processing-job/' + name
         and actual['ProcessingJobStatus'] == 'Completed' and not actual.get('FailureReason')
         and actual.get('ProcessingStartTime') and actual.get('ProcessingEndTime'), 'Clean terminal job required')
    return prefix


def verify_inventory(rows, prefix, names):
    need(len(rows) == len(names) and {r['Key'][len(prefix):] for r in rows} == names
         and all(r['Key'].startswith(prefix) and type(r['Size']) is int and r['Size'] >= 0 for r in rows),
         'Missing, extra, duplicate or invalid output objects')
    return sorted(rows, key=lambda r: r['Key'])


def destination(path, size):
    path = Path(path).absolute()
    need(not path.exists() and path.parent.is_dir()
         and not any(p.is_symlink() for p in (path, *path.parents)), 'Fresh nonsymlink destination required')
    need(not path.is_relative_to(Path.home()), 'Do not download full campaign into CloudShell home')
    need(shutil.disk_usage(path.parent).free >= 2*size + max(1024**3, size // 4),
         'Insufficient witness body and TAR space plus 25%/1GiB reserve')
    return path


def main():
    p = argparse.ArgumentParser()
    for name in ('job', 'intent-uri', 'intent-sha256', 'release-sha256', 'kind'):
        p.add_argument('--' + name, required=True)
    for name in ('audit-index', 'destination'):
        p.add_argument('--' + name, type=Path, required=True)
    a = p.parse_args()
    need(sha(a.audit_index) == INDEX_SHA, 'Prospective audit index changed')
    for digest in (a.intent_sha256, a.release_sha256):
        need(re.fullmatch('[0-9a-f]{64}', digest), 'Explicit observed hash required')
    names = expected_payloads(strict_json(a.audit_index.read_bytes()), a.kind) | {LEDGER}
    key = private_key(a.intent_uri)
    need(key.endswith('/provenance/' + a.job + '/launch-intent.json'), 'Job-owned launch intent path')
    import boto3
    from botocore.config import Config
    session = boto3.Session(region_name=REGION)
    cfg = Config(retries={'total_max_attempts': 4, 'mode': 'standard'}, connect_timeout=10, read_timeout=60)
    client = lambda n: session.client(n, config=cfg)
    need(client('sts').get_caller_identity()['Account'] == ACCOUNT, 'Account mismatch')
    s3, sm, logs = (client(n) for n in ('s3', 'sagemaker', 'logs'))
    need((s3.get_bucket_location(Bucket=BUCKET, ExpectedBucketOwner=ACCOUNT).get('LocationConstraint') or 'us-east-1') == REGION,
         'Bucket region differs')
    need(all(s3.get_public_access_block(Bucket=BUCKET, ExpectedBucketOwner=ACCOUNT)['PublicAccessBlockConfiguration'].get(k) is True
             for k in ('BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets')), 'Private bucket controls required')
    def get(key):
        body = s3.get_object(Bucket=BUCKET, Key=key, ExpectedBucketOwner=ACCOUNT)['Body']
        try: return body.read()
        finally: body.close()
    intent_raw = get(key)
    need(hashlib.sha256(intent_raw).hexdigest() == a.intent_sha256, 'Intent checksum')
    actual = sm.describe_processing_job(ProcessingJobName=a.job)
    prefix = validate_launch(strict_json(intent_raw), actual, a.job, a.kind, a.release_sha256)
    def inventory():
        rows = [r for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=prefix, ExpectedBucketOwner=ACCOUNT)
                for r in page.get('Contents', [])]
        return verify_inventory(rows, prefix, names)
    rows = inventory(); size = sum(r['Size'] for r in rows)
    need(size<1024**3,'Witness output exceeds 1GiB transfer guard')
    out = destination(a.destination, size); out.mkdir(mode=0o700)
    hashes = {}
    def save(name, raw):
        safe(name); path = out / name; path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as f: f.write(raw)
        hashes[name] = hashlib.sha256(raw).hexdigest()
    def record(name, value):
        save('provenance/' + name, (json.dumps(value, indent=2, default=str, allow_nan=False) + '\n').encode())
    try:
        record('describe-processing-job.json', actual)
        for i, row in enumerate(rows):
            name = 'output/' + safe(row['Key'][len(prefix):]); path = out / name
            path.parent.mkdir(parents=True, exist_ok=True)
            body = s3.get_object(Bucket=BUCKET, Key=row['Key'], ExpectedBucketOwner=ACCOUNT, IfMatch=row['ETag'])['Body']
            h = hashlib.sha256(); count = 0
            try:
                with path.open('xb') as f:
                    while chunk := body.read(8 * 1024**2):
                        f.write(chunk); h.update(chunk); count += len(chunk)
            finally: body.close()
            need(count == row['Size'], 'S3 body byte count changed'); hashes[name] = h.hexdigest()
            if (i + 1) % 200 == 0: print('COLLECTED_OBJECTS ' + str(i + 1), flush=True)
        need(rows == inventory(), 'Output changed during download')
        record('s3-index.json', dict(job=a.job, bucket=BUCKET, prefix=prefix,
            objects=[dict(relative=r['Key'][len(prefix):], bytes=r['Size'], etag=r['ETag'], lastModified=r['LastModified']) for r in rows]))
        base = key.rsplit('/', 1)[0] + '/'
        for name in PROVENANCE:
            raw = get(base + name)
            if name == 'launch-intent.json': need(raw == intent_raw, 'Intent changed during download')
            save('provenance/' + name, raw)
        streams = [r for page in logs.get_paginator('describe_log_streams').paginate(
            logGroupName='/aws/sagemaker/ProcessingJobs', logStreamNamePrefix=a.job + '/') for r in page['logStreams']]
        need(len(streams) == 1, 'One log stream required')
        events = []; token = None
        while True:
            args = dict(logGroupName='/aws/sagemaker/ProcessingJobs', logStreamName=streams[0]['logStreamName'], startFromHead=True)
            if token: args['nextToken'] = token
            page = logs.get_log_events(**args); events.extend(page['events'])
            following = page['nextForwardToken']
            if following == token: break
            token = following
        record('cloudwatch.json', dict(logStream=streams[0]['logStreamName'], events=events))
        ledger = {}
        for line in (out / 'output' / LEDGER).read_text().splitlines():
            h, name = line.split('  ', 1); safe(name)
            need(name not in ledger and re.fullmatch('[0-9a-f]{64}', h), 'Invalid/duplicate output ledger row'); ledger[name] = h
        need(set(ledger) == names - {LEDGER} and all(hashes['output/' + n] == h for n, h in ledger.items()),
             'Full downloaded payload ledger mismatch')
        record('collection-hashes.json', dict(hashes=dict(hashes)))
        record('transfer-complete.json', dict(version='mechanism-wrapper-witness-transfer-v1', transportVerified=True,
            kind=a.kind, job=a.job, histories=3, reservedWorldsExecuted=0, outputObjects=len(rows), outputBytes=size,
            collectedAtUTC=datetime.now(timezone.utc).isoformat(), intentSha256=a.intent_sha256,
            releaseSha256=a.release_sha256, collectorSha256=sha(Path(__file__)),
            fullNumericalAuditPerformed=False, scientificallyAccepted=False))
        # Small witness only: unlike the full campaign, this can safely make a
        # bounded second TAR copy for the ordinary CloudShell file-download UI.
        archive=out.parent/(out.name+'-terminal.tar')
        with tarfile.open(archive,'x') as tar:
            for path in sorted(out.rglob('*')):
                need(not path.is_symlink(),'Transfer archive symlink')
                if path.is_dir():continue
                need(path.is_file(),'Nonregular transfer archive body')
                name=safe(path.relative_to(out).as_posix())
                info=tarfile.TarInfo(name);info.size=path.stat().st_size;info.mode=0o600
                with path.open('rb') as f:tar.addfile(info,f)
        print('WRAPPER_WITNESS_TRANSFER_READY '+json.dumps(dict(archive=str(archive),sha256=sha(archive),
            bytes=archive.stat().st_size,outputObjects=len(rows),histories=3,
            reservedWorldsExecuted=0,scientificallyAccepted=False)),flush=True)
    except BaseException as error:
        record('transfer-failed.json', dict(error=type(error).__name__ + ': ' + str(error),
            transportVerified=False, diagnosticOnly=True, scientificallyAccepted=False))
        raise


if __name__ == '__main__': main()
