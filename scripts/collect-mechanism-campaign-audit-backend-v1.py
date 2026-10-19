"""Read-only complete nested auditor download; never numerical acceptance.

All 14428 output objects plus nine provenance bodies are downloaded with stable
inventory, full-body SHA and both nested/outer output ledgers. No AWS writes,
missions or audits. Optional TAR transport is created only with measured space.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import tarfile

ROOT = Path(__file__).resolve().parents[1]
DEPENDENCIES = {
    'scripts/collect-mechanism-campaign-v1.py': '3032d0431737c349d732dc4b6a2cfc1bece7107ee1c3bb91de155c0d7f3f3eb6',
    'scripts/lib/si_campaign_audit_backend_contract_v1.py': '3a6afbf4ac4e804448bdf7b0d65fcf56525a3524e20b704c2f5ae8e498518822',
}


def need(ok, why):
    if not ok: raise ValueError(why)


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def dependencies():
    result = []
    for i, (name, digest) in enumerate(DEPENDENCIES.items()):
        path = ROOT / name
        need(not any(p.is_symlink() for p in (path, *path.parents)) and sha(path) == digest, 'Download source changed: ' + name)
        spec = importlib.util.spec_from_file_location('nested_download_' + str(i), path)
        m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); result.append(m)
    return tuple(result)


def ledger(path, names, hashes, prefix, safe):
    pins = {}
    for row in path.read_text().splitlines():
        digest, name = row.split('  ', 1); safe(name)
        need(name not in pins and re.fullmatch('[0-9a-f]{64}', digest), 'Invalid/duplicate nested ledger row')
        pins[name] = digest
    need(set(pins) == names and all(hashes[prefix + n] == h for n, h in pins.items()), 'Full nested downloaded payload ledger mismatch')


def terminal_tar(tree, path, names):
    path = path.absolute()
    need(not path.exists() and path.parent.is_dir() and not any(p.is_symlink() for p in (path, *path.parents))
         and not path.resolve().is_relative_to(tree.resolve()), 'Fresh separate terminal TAR destination')
    total = sum((tree / n).stat().st_size for n in names)
    estimate = total + 2048 * len(names) + 1024**2
    need(shutil.disk_usage(path.parent).free >= estimate + max(1024**3, estimate // 4), 'No room for additional TAR copy and reserve')
    with path.open('xb') as raw:
        with tarfile.open(fileobj=raw, mode='w:', format=tarfile.PAX_FORMAT) as archive:
            for name in sorted(names):
                source = tree / name
                need(not source.is_symlink() and source.is_file(), 'Nonregular TAR source')
                archive.add(source, arcname=name, recursive=False)
    path.chmod(0o600)
    return dict(path=str(path), bytes=path.stat().st_size, sha256=sha(path), bodies=len(names))


def main():
    p = argparse.ArgumentParser()
    for name in ('job', 'intent-uri', 'intent-sha256', 'controller-sha256'):
        p.add_argument('--' + name, required=True)
    for name in ('audit-index', 'destination'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--terminal-tar', type=Path)
    a = p.parse_args(); collector, contract = dependencies()
    need(sha(a.audit_index) == collector.INDEX_SHA and contract.valid_sha(a.intent_sha256)
         and contract.valid_sha(a.controller_sha256), 'Observed immutable launch and prospective index pins required')
    routing = collector.strict_json(a.audit_index.read_bytes())
    payloads = contract.expected_payloads(routing, collector); names = payloads | {collector.LEDGER}
    key = collector.private_key(a.intent_uri)
    import boto3
    from botocore.config import Config
    cfg = Config(retries={'total_max_attempts': 4, 'mode': 'standard'}, connect_timeout=10, read_timeout=60)
    session = boto3.Session(region_name=contract.REGION)
    client = lambda n: session.client(n, config=cfg)
    need(client('sts').get_caller_identity()['Account'] == contract.ACCOUNT, 'Account mismatch')
    s3, sm, logs = (client(n) for n in ('s3', 'sagemaker', 'logs'))
    need((s3.get_bucket_location(Bucket=contract.BUCKET, ExpectedBucketOwner=contract.ACCOUNT).get('LocationConstraint') or 'us-east-1') == contract.REGION,
         'Private bucket region changed')
    need(all(s3.get_public_access_block(Bucket=contract.BUCKET, ExpectedBucketOwner=contract.ACCOUNT)['PublicAccessBlockConfiguration'].get(k) is True
             for k in ('BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets')), 'Private access controls required')
    def get(name):
        body = s3.get_object(Bucket=contract.BUCKET, Key=name, ExpectedBucketOwner=contract.ACCOUNT)['Body']
        try: return body.read()
        finally: body.close()
    intent_raw = get(key)
    need(hashlib.sha256(intent_raw).hexdigest() == a.intent_sha256, 'Auditor immutable intent SHA changed')
    intent = collector.strict_json(intent_raw)
    actual = sm.describe_processing_job(ProcessingJobName=a.job)
    prefix = contract.validate_actual(intent, actual, a.job, key, a.controller_sha256, collector.matches)
    def inventory():
        rows = [r for page in s3.get_paginator('list_objects_v2').paginate(Bucket=contract.BUCKET, Prefix=prefix, ExpectedBucketOwner=contract.ACCOUNT)
                for r in page.get('Contents', [])]
        return collector.verify_inventory(rows, prefix, names)
    rows = inventory(); size = sum(r['Size'] for r in rows)
    out = collector.destination(a.destination, size); out.mkdir(mode=0o700)
    hashes = {}
    def save(name, raw):
        collector.safe(name); target = out / name; target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream: stream.write(raw)
        hashes[name] = hashlib.sha256(raw).hexdigest()
    def record(name, value):
        save('provenance/' + name, (json.dumps(value, indent=2, default=str, allow_nan=False) + '\n').encode())
    try:
        record('describe-processing-job.json', actual)
        for i, row in enumerate(rows):
            name = 'output/' + collector.safe(row['Key'][len(prefix):]); target = out / name
            target.parent.mkdir(parents=True, exist_ok=True)
            body = s3.get_object(Bucket=contract.BUCKET, Key=row['Key'], ExpectedBucketOwner=contract.ACCOUNT, IfMatch=row['ETag'])['Body']
            h = hashlib.sha256(); count = 0
            try:
                with target.open('xb') as stream:
                    while chunk := body.read(8 * 1024**2):
                        stream.write(chunk); h.update(chunk); count += len(chunk)
            finally: body.close()
            need(count == row['Size'], 'Auditor S3 body length changed'); hashes[name] = h.hexdigest()
            if (i + 1) % 200 == 0: print('AUDIT_COLLECTED_OBJECTS ' + str(i + 1), flush=True)
        need(rows == inventory(), 'Auditor terminal inventory changed during download')
        record('s3-index.json', dict(job=a.job, bucket=contract.BUCKET, prefix=prefix,
            objects=[dict(relative=r['Key'][len(prefix):], bytes=r['Size'], etag=r['ETag'], lastModified=r['LastModified']) for r in rows]))
        for name in collector.PROVENANCE:
            raw = get(key.rsplit('/', 1)[0] + '/' + name)
            if name == 'launch-intent.json': need(raw == intent_raw, 'Intent changed during collection')
            save('provenance/' + name, raw)
        streams = [r for page in logs.get_paginator('describe_log_streams').paginate(logGroupName='/aws/sagemaker/ProcessingJobs',
            logStreamNamePrefix=a.job + '/') for r in page['logStreams']]
        need(len(streams) == 1, 'One auditor CloudWatch stream required')
        events = []; token = None
        while True:
            args = dict(logGroupName='/aws/sagemaker/ProcessingJobs', logStreamName=streams[0]['logStreamName'], startFromHead=True)
            if token: args['nextToken'] = token
            page = logs.get_log_events(**args); events.extend(page['events']); following = page['nextForwardToken']
            if following == token: break
            token = following
        record('cloudwatch.json', dict(logStream=streams[0]['logStreamName'], events=events))
        ledger(out / 'output' / collector.LEDGER, payloads, hashes, 'output/', collector.safe)
        independent = collector.expected_payloads(routing, 'independent-audit')
        ledger(out / 'output/independent' / collector.LEDGER, independent, hashes, 'output/independent/', collector.safe)
        record('collection-hashes.json', dict(hashes=dict(hashes)))
        record('transfer-complete.json', dict(version='mechanism-campaign-audit-backend-transfer-v1', transportVerified=True,
            job=a.job, producerJob=contract.PRODUCER_JOB, histories=2400, outputObjects=14428, outputBytes=size,
            intentSha256=a.intent_sha256, controllerSha256=a.controller_sha256, collectorSha256=sha(Path(__file__)),
            contractSha256=DEPENDENCIES['scripts/lib/si_campaign_audit_backend_contract_v1.py'],
            collectedAtUTC=datetime.now(timezone.utc).isoformat(), independentlyScientificallyAccepted=False))
        transport = None
        if a.terminal_tar:
            transport = terminal_tar(out, a.terminal_tar, set(hashes))
        print('NESTED_ALL_HISTORY_AUDIT_TRANSFER_VERIFIED_TERMINAL_ACCEPTANCE_REQUIRED ' + json.dumps(dict(
            destination=str(out), terminalTar=transport, histories=2400, outputObjects=14428, scientificallyAccepted=False)), flush=True)
    except BaseException as error:
        record('transfer-failed.json', dict(error=type(error).__name__ + ': ' + str(error), diagnosticOnly=True, transportVerified=False))
        raise


if __name__ == '__main__':
    main()
