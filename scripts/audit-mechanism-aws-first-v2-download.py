"""Import and independently audit one sealed AWS-first six-history smoke TAR.

Reads only the given archive and frozen local science; writes a fresh destination.
No AWS calls, simulation, acceptance of earlier failed jobs, or source edits.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
SCIENCE = ROOT / 'aws/build/si-mechanism-preflight-candidate-20260925-v3'
OVERLAY = ROOT / 'aws/build/PlumeNav_mechanism_aws_first_20260928_v2_attempt01/overlay'
LAUNCH = ROOT / 'research/results/si_mechanism_aws_first_v2_launch_2026-09-29.json'
JOB = 'plumenav-mech-awsfirst-v2-20260928-232116'
CASES = (
    'mechanism-development-3000-RW-si-continuous-n64',
    'mechanism-development-3000-GL-si-pulse-n64',
    'mechanism-development-3000-NS-blank-n64',
)
REPEATS = ('repeat-1', 'repeat-2')
PROVENANCE = {
    'describe-processing-job.json', 's3-index.json', 'launch-intent.json',
    'submission-attempt.json', 'launch-response.json',
    'job-describe-initial.json', 'cloudwatch.json', 'collection-hashes.json',
}


def need(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def load(path):
    return json.loads(path.read_text())


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as target:
        json.dump(obj, target, indent=2, sort_keys=True, default=str)
        target.write('\n')


def safe(name):
    path = PurePosixPath(name)
    need(type(name) is str and name and str(path) == name and not path.is_absolute()
         and '..' not in path.parts and '\\' not in name
         and not any(ord(char) < 32 for char in name), 'Unsafe TAR member path')
    need(path.parts[0] in ('output', 'provenance') and len(path.parts) > 1,
         'Unexpected TAR root')
    return name


def extract_exact(archive, destination):
    members = {}
    with tarfile.open(archive, 'r:') as source:
        for member in source:
            name = safe(member.name)
            need(name not in members and member.isfile() and member.size >= 0,
                 'Duplicate, non-file or invalid TAR member: ' + name)
            members[name] = member.size
        source.getmembers()  # Force TAR end and checksum verification before extraction.
        for member in source.getmembers():
            target = destination / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as original, target.open('xb') as saved:
                while block := original.read(1024 * 1024):
                    saved.write(block)
            need(target.stat().st_size == member.size, 'Short TAR member: ' + member.name)
    return members


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    archive, destination = args.archive.resolve(), args.destination.resolve()
    need(archive.is_file() and not archive.is_symlink(), 'Transfer TAR absent')
    need(not destination.exists() and not destination.is_relative_to(archive.parent),
         'Fresh separate destination required')
    need(len(args.archive_sha256) == 64 and sha(archive) == args.archive_sha256,
         'Transfer TAR hash mismatch')
    destination.mkdir(parents=True)
    result = dict(checkedAt=datetime.now(timezone.utc).isoformat(), job=JOB,
        accepted=False, campaignAllowed=False, newMissions=0, realAwsCalls=0,
        archive=str(archive), archiveSha256=args.archive_sha256,
        sourceScriptSha256=sha(Path(__file__)))
    derived = destination / 'independent-audit'
    try:
        members = extract_exact(archive, destination / 'download')
        output = destination / 'download/output'
        provenance = destination / 'download/provenance'
        need({name.removeprefix('provenance/') for name in members if name.startswith('provenance/')}
             == PROVENANCE, 'Missing or extra provenance member')
        hashes = load(provenance / 'collection-hashes.json')['hashes']
        need(set(hashes) == set(members) - {'provenance/collection-hashes.json'},
             'Collection hash coverage differs from TAR')
        for name, digest in hashes.items():
            need(sha(destination / 'download' / name) == digest,
                 'Collection body hash mismatch: ' + name)
        result['collectionHashesPassed'] = len(hashes)

        launch = load(LAUNCH)
        need(launch['jobName'] == JOB and launch['submittedConfigurationVerified'] is True,
             'Local launch receipt binding')
        intent_path = provenance / 'launch-intent.json'
        need(sha(intent_path) == launch['launchIntentSha256'], 'Immutable launch intent hash')
        intent = load(intent_path)
        need(intent['account'] == launch['account'] and intent['region'] == launch['region']
             and intent['spec']['ProcessingJobName'] == JOB and intent['inputHashes'] == launch['inputHashes'],
             'Launch scope or input hashes')
        job = load(provenance / 'describe-processing-job.json')
        need(job['ProcessingJobName'] == JOB and job['ProcessingJobStatus'] == 'Completed'
             and not job.get('FailureReason') and job.get('ProcessingStartTime')
             and job.get('ProcessingEndTime'), 'Terminal AWS job state')
        spec = intent['spec']
        for key in ('RoleArn', 'AppSpecification', 'ProcessingResources',
                    'StoppingCondition', 'Environment'):
            need(job[key] == spec[key], 'Submitted job diverged: ' + key)
        need(job['ProcessingResources']['ClusterConfig'] == dict(InstanceCount=1,
            InstanceType='ml.m5.xlarge', VolumeSizeInGB=20), 'Unexpected resources')
        need(job['AppSpecification']['ImageUri'] == launch['imageUri'], 'Wrong pinned image')
        need(job['StoppingCondition']['MaxRuntimeInSeconds'] == 3600, 'Wrong runtime cap')
        need(job['ProcessingInputs'][0]['S3Input']['S3Uri'] == launch['inputPrefix'],
             'Wrong AWS input destination')
        need(job['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3Uri'] == launch['outputPrefix'],
             'Wrong AWS output destination')
        need(load(provenance / 'launch-response.json')['ProcessingJobArn'] == launch['jobArn'],
             'Submission response mismatch')
        need(load(provenance / 'job-describe-initial.json')['ProcessingJobName'] == JOB,
             'Initial describe mismatch')
        need(load(provenance / 'submission-attempt.json')['job'] == JOB,
             'Durable attempt marker mismatch')

        index = load(provenance / 's3-index.json')
        need(index['job'] == JOB and 's3://' + index['bucket'] + '/' + index['prefix']
             == launch['outputPrefix'], 'S3 inventory scope')
        rows = index['objects']
        names = {row['relative'] for row in rows}
        actual = {path.relative_to(output).as_posix() for path in output.rglob('*') if path.is_file()}
        need(len(rows) == 69 and names == actual and len(names) == 69,
             'Exact 69-object S3/output membership')
        need(all((output / row['relative']).stat().st_size == row['bytes'] for row in rows),
             'S3/object byte size mismatch')
        need(sum(row['bytes'] for row in rows) == 135904347, 'S3 byte total changed')
        result['s3Objects'] = len(rows)
        result['s3Bytes'] = sum(row['bytes'] for row in rows)

        sys.path.insert(0, str(OVERLAY))
        import common
        common.context(SCIENCE)
        from mechanism_portability_candidate_v1 import compare
        from lib.si_mechanism_history_v1 import history, canonical
        need(sha(OVERLAY / 'freeze.json') == launch['verificationFreezeSha256'],
             'Wrong local verification freeze')
        need(sha(SCIENCE.with_suffix('.tar.gz')) == launch['inputHashes']['bundle.tar.gz'],
             'Wrong local scientific archive')
        need(common.verify_outputs(output)['passed'] is True,
             'Full output manifest or smoke contract')
        result['outputManifestPassed'] = True
        need(not (output / 'failed.json').exists()
             and not (output / 'finalization-failed.json').exists(), 'Failure marker present')
        runtime = load(output / 'runtime.json')
        delivery = load(SCIENCE / 'delivery.json')
        need(all(runtime[key] == value for key, value in
                 delivery['historicallyVerifiedRuntime'].items()), 'Runtime versions changed')
        need(runtime['architecture'] == 'x86_64' and runtime['cpus'] == 4
             and all(value == '1' for value in runtime['threadSettings'].values()),
             'Runtime architecture or thread count changed')
        events = load(provenance / 'cloudwatch.json')['events']
        messages = [event['message'] for event in events]
        need(messages.count('AWS_FIRST_SMOKE_COMPLETE_DOWNLOAD_AUDIT_REQUIRED') == 1,
             'Missing/duplicate terminal log marker')
        need(len([message for message in messages if message.startswith('AWS_FIRST_CASE_AUDITED ')]) == 6
             and len([message for message in messages if message.startswith('AWS_FIRST_REPEAT_EXACT ')]) == 3,
             'Incomplete worker/CloudWatch markers')

        derived.mkdir()
        result['independentAudits'] = []
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONNOUSERSITE='1',
                   OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1')
        env.pop('PYTHONPATH', None)
        for repeat in REPEATS:
            original_run = output / 'runs' / repeat
            local_run = derived / 'runs' / repeat
            local_run.mkdir(parents=True)
            for name in ('cases', 'terminals'):
                (local_run / name).symlink_to(original_run / name, target_is_directory=True)
            receipts = local_run / 'audits'
            receipts.mkdir()
            for cid in CASES:
                command = [sys.executable, '-B', str(OVERLAY / 'audit.py'),
                    '--science', str(SCIENCE), '--run', str(local_run),
                    '--receipts', str(receipts), '--case', cid]
                log = derived / 'logs' / repeat / (cid + '.log')
                log.parent.mkdir(parents=True, exist_ok=True)
                with log.open('x') as stream:
                    completed = subprocess.run(command, cwd=SCIENCE, env=env,
                        stdout=stream, stderr=subprocess.STDOUT, timeout=300)
                need(completed.returncode == 0, 'Independent audit failed: ' + repeat + '/' + cid)
                receipt = load(receipts / (cid + '.json'))
                cloud = load(original_run / 'audits' / (cid + '.json'))
                need(receipt['passed'] is True and cloud['passed'] is True,
                     'Full scientific audit did not pass')
                for key in ('comparisonPassed', 'historySha256', 'referenceSha256',
                            'freezeSha256', 'manifestSha256'):
                    need(receipt[key] == cloud[key], 'Local/cloud audit disagreement: ' + key)
                local_diag = load(receipts / (cid + '-diagnostics.json'))
                cloud_diag = load(original_run / 'audits' / (cid + '-diagnostics.json'))
                need(compare(local_diag['extracted'], cloud_diag['extracted'])['exact'] is True,
                     'Independent/cloud endpoint mismatch')
                result['independentAudits'].append(dict(caseId=cid, repeat=repeat,
                    passed=True, historySha256=receipt['historySha256']))

        result['repeatability'] = []
        for cid in CASES:
            paths = [output / 'runs' / repeat / 'cases' / cid / 'mission.json.gz'
                     for repeat in REPEATS]
            records = [canonical(history(path)) for path in paths]
            relation = compare(records[0], records[1])
            endpoints = [load(derived / 'runs' / repeat / 'audits' /
                (cid + '-diagnostics.json'))['extracted'] for repeat in REPEATS]
            endpoint = compare(endpoints[0], endpoints[1])
            remote = load(output / 'repeatability' / (cid + '.json'))
            need(relation['passed'] and relation['exact'] and endpoint['passed']
                 and endpoint['exact'] and remote['passed'] is True
                 and remote['history']['exact'] is True and remote['endpoint']['exact'] is True,
                 'Same-runtime repeat mismatch')
            result['repeatability'].append(dict(caseId=cid, exact=True,
                historySha256=[sha(path) for path in paths]))

        need(common.verify_outputs(output)['passed'] is True,
             'Downloaded evidence changed during independent audit')
        need(all(sha(destination / 'download' / name) == digest for name, digest in hashes.items()),
             'Collected bodies changed during independent audit')
        result.update(accepted=True, acceptedFor='six fixed development smoke histories only',
            campaignAllowed=False, independentDownloadedAuditPassed=True)
    except BaseException as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
        raise
    finally:
        write(destination / 'verification.json', result)
        print(json.dumps(result, indent=2, sort_keys=True), flush=True)


if __name__ == '__main__':
    main()
