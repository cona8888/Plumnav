"""Independent diagnostic of existing failed v3 evidence; never admission.

No new mission, AWS call, protocol change or tolerance change. All derived output
is exclusive-created separately from downloaded and frozen evidence.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
from pathlib import Path, PurePosixPath
import platform
import shutil
import sys
import tarfile
import time

ROOT = Path(__file__).resolve().parents[1]
SCIENCE = ROOT / 'aws/build/si-mechanism-preflight-candidate-20260925-v3'
OVERLAY = ROOT / 'aws/build/PlumeNav_mechanism_smoke_20260927_v3_attempt02/overlay'
ARCHIVE_SHA = 'e72bac2577a8637a7b6601cf087e03b269adaf056e83c045721c8a6977d929d4'
SCIENCE_SHA = '589b28225057adb09790421f29dc66643bc374fcb757c080184686de0c304235'


def sha(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def load(path):
    return json.loads(Path(path).read_text())


def write(path, obj):
    with Path(path).open('x') as handle:
        json.dump(obj, handle, indent=2, allow_nan=False)
        handle.write('\n')


def rejected_details(left, right, policy):
    """Enumerate every rejection with the UNCHANGED frozen rule."""
    rejects = []
    def reject(path, reason, a, b):
        row = dict(path='/' + '/'.join(map(str, path)),
            group='/' + '/'.join('#' if type(x) is int else x for x in path),
            reason=reason, reference=a, cloud=b,
            referenceType=type(a).__name__, cloudType=type(b).__name__)
        if type(a) in (int, float) and type(b) in (int, float) and math.isfinite(a) and math.isfinite(b):
            row['absoluteDifference'] = abs(a - b)
            row['sameNumericValue'] = a == b
            if a != 0 and b != 0 and math.copysign(1, a) == math.copysign(1, b):
                row['ulps'] = policy.ulps(float(a), float(b))
        rejects.append(row)

    def walk(a, b, p=()):
        if type(a) is not type(b):
            reject(p, 'type', a, b)
        elif type(a) is dict:
            if a.keys() != b.keys():
                reject(p, 'keys', sorted(a), sorted(b))
            for k in a.keys() & b.keys():
                walk(a[k], b[k], p + (k,))
        elif type(a) is list:
            if len(a) != len(b):
                reject(p, 'length', len(a), len(b))
            for i, (x, y) in enumerate(zip(a, b)):
                walk(x, y, p + (i,))
        elif type(a) is float:
            if not math.isfinite(a) or not math.isfinite(b):
                reject(p, 'non-finite', repr(a), repr(b))
            elif a != b or math.copysign(1, a) != math.copysign(1, b):
                kind = policy.field_kind(p)
                if kind is None:
                    reject(p, 'exact-field', a, b)
                elif a == 0 or b == 0 or math.copysign(1, a) != math.copysign(1, b):
                    reject(p, 'zero-or-sign-change', a, b)
                elif policy.ulps(a, b) > policy.MAX_ULPS or abs(a-b) > policy.LIMITS[kind][1]:
                    reject(p, 'roundoff-budget', a, b)
        elif a != b:
            reject(p, 'exact-field', a, b)
    walk(left, right)
    groups = defaultdict(list)
    for row in rejects:
        groups[row['group']].append(row)
    summaries = {k: dict(count=len(v), reasons=dict(Counter(x['reason'] for x in v)),
        maxAbsoluteDifference=max((x.get('absoluteDifference', 0) for x in v), default=0),
        maxUlps=max((x.get('ulps', 0) for x in v), default=0)) for k, v in sorted(groups.items())}
    return dict(count=len(rejects), reasons=dict(Counter(x['reason'] for x in rejects)),
                groups=summaries, allRejectedDifferences=rejects)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.absolute()
    assert out.parent.resolve() == ROOT / 'research/results' and not out.exists()
    assert sha(args.archive) == ARCHIVE_SHA, 'Downloaded archive changed'
    out.mkdir()
    shutil.copyfile(args.archive, out / 'terminal.tar')
    raw = out / 'download'
    raw.mkdir()
    with tarfile.open(out / 'terminal.tar', 'r:') as tar:
        members = tar.getmembers()
        names = [x.name for x in members]
        assert len(names) == len(set(names))
        for item in members:
            p = PurePosixPath(item.name)
            assert item.isfile() and not p.is_absolute() and '..' not in p.parts
            assert str(p) == item.name and p.parts[0] in ('output', 'provenance')
        tar.extractall(raw, members=members, filter='data')
    collection = load(raw / 'provenance/collection-hashes.json')
    assert all(sha(raw / p) == digest for p, digest in collection.items())
    assert set(collection) | {'provenance/collection-hashes.json'} == set(names)
    sys.path.insert(0, str(OVERLAY))
    import common
    import mechanism_portability_candidate_v1 as policy
    from verification_manifest_v1 import verify_manifest
    common.verify_tree(OVERLAY)
    common.verify_tree(SCIENCE)
    assert sha(SCIENCE.with_suffix('.tar.gz')) == SCIENCE_SHA
    science, delivery, registry = common.context(SCIENCE)
    from lib.si_mechanism_history_v1 import history, pinned, canonical
    import numpy
    spec = importlib.util.spec_from_file_location('frozen_overlay_audit', OVERLAY / 'audit.py')
    auditor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(auditor)
    preserved = [p for directory in (SCIENCE, OVERLAY, raw) for p in directory.rglob('*') if p.is_file()]
    before = {str(p): sha(p) for p in preserved}
    write(out / 'preserved-before.json', before)
    started = time.monotonic()
    result = dict(createdAt=datetime.now(timezone.utc).isoformat(), diagnosticOnly=True,
        accepted=False, campaignAllowed=False, newMissions=0, realAwsCalls=0,
        archiveSha256=ARCHIVE_SHA, runtime=dict(python=platform.python_version(),
        numpy=numpy.__version__, machine=platform.machine()), cases=[])
    try:
        payload = raw / 'output'
        index = load(payload / 'payload-index.json')['payloads']
        assert set(index) <= common.allowed_payloads()
        verify_manifest(payload, index)
        inventory = load(raw / 'provenance/s3-index.json')['objects']
        actual = {p.relative_to(payload).as_posix() for p in payload.rglob('*') if p.is_file()}
        assert actual == {x['relative'] for x in inventory}
        assert all((payload / x['relative']).stat().st_size == x['bytes'] for x in inventory)
        job = load(raw / 'provenance/describe-processing-job.json')
        launch = load(ROOT / 'research/results/si_mechanism_smoke_v3_launch_2026-09-28.json')
        assert job['ProcessingJobName'] == launch['jobName'] and job['ProcessingJobStatus'] == 'Failed'
        assert job['AppSpecification']['ImageUri'] == launch['imageUri']
        assert job['RoleArn'] == launch['roleArn']
        assert job['ProcessingResources']['ClusterConfig'] == dict(InstanceCount=1, InstanceType='ml.m5.xlarge', VolumeSizeInGB=20)
        assert job['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3Uri'] == launch['outputPrefix']
        assert job['StoppingCondition']['MaxRuntimeInSeconds'] == 3600
        assert sha(raw / 'provenance/launch-intent.json') == launch['launchIntentSha256']
        assert sha(payload / 'freeze.json') == launch['verificationFreezeSha256'] == sha(OVERLAY / 'freeze.json')
        assert load(payload / 'failed.json')['campaignAllowed'] is False
        result.update(payloadIntegrityPassed=True, payloadCount=len(index),
            outputObjects=len(actual), launchBindingPassed=True, jobStatus='Failed',
            cloudRuntime=load(payload / 'runtime.json'),
            missingCases=[c for c in common.CASES if not (payload / 'cases' / c / 'mission.json.gz').exists()])
        receipts = out / 'independent-audit'
        receipts.mkdir()
        for entry in delivery['smokeCases'][:2]:
            cid = entry['caseId']
            expected_failure = None
            try:
                auditor.audit_case(SCIENCE, payload, receipts, cid)
            except ValueError as error:
                expected_failure = str(error)
            status = load(receipts / (cid + '.json'))
            diagnostics_path = receipts / (cid + '-diagnostics.json')
            comparison_path = receipts / (cid + '-comparison.json')
            assert diagnostics_path.exists() and comparison_path.exists(), status
            diagnostics = load(diagnostics_path)
            comparison = load(comparison_path)
            cloud_comparison = load(payload / 'audits' / (cid + '-comparison.json'))
            ref = canonical(history(pinned(entry['referenceHistory'])))
            record = canonical(history(payload / 'cases' / cid / 'mission.json.gz'))
            full = rejected_details(ref, record, policy)
            assert full['count'] == comparison['history']['rejectedDifferences']
            write(out / (cid + '-all-rejections.json'), full)
            row = dict(caseId=cid, independentScientificAuditPassed=diagnostics['fullAuditPassed'],
                guardPassed=status['guardCheck']['passed'], endpointExactlyMatches=comparison['endpoint']['passed'],
                frozenPortabilityPassed=comparison['candidateChecksPassed'],
                cloudHistoryComparisonReproduced=comparison['history'] == cloud_comparison['history'],
                independentAuditResidualsWithinBounds=comparison['audit']['passed'],
                expectedFailure=expected_failure, rejectionSummary={k:v for k,v in full.items() if k != 'allRejectedDifferences'},
                historySha256=sha(payload / 'cases' / cid / 'mission.json.gz'),
                summaryExactlyMatches=policy.compare(ref['summary'], record['summary'])['passed'],
                nominationExactlyMatches=policy.compare(ref['nomination'], record['nomination'])['passed'],
                specificationExactlyMatches=policy.compare(ref['spec'], record['spec'])['passed'],
                configurationExactlyMatches=policy.compare(ref['config'], record['config'])['passed'])
            result['cases'].append(row)
            print('INDEPENDENT_DIAGNOSTIC ' + json.dumps(row), flush=True)
            del ref, record
        registry.protect()
        result['diagnosticCompleted'] = True
    except BaseException as error:
        result.update(diagnosticCompleted=False, error=type(error).__name__ + ': ' + str(error))
        raise
    finally:
        after = {str(p): sha(p) for p in preserved}
        result['preservedHashesUnchanged'] = before == after
        result['preservedFileCount'] = len(before)
        result['elapsedSeconds'] = time.monotonic() - started
        result['scriptSha256'] = sha(Path(__file__))
        write(out / 'diagnostic.json', result)
        assert before == after, 'Input evidence changed'
        print('DIAGNOSTIC_RECEIPT ' + str(out / 'diagnostic.json'), flush=True)


if __name__ == '__main__':
    main()
