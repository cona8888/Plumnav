#!/usr/bin/env python3
"""Accept only fully downloaded and independently audited frozen campaign evidence."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import sys
import numpy as np
import scipy
from lib.processing_output_manifest import verify_output_manifest


def read(p): return json.loads(p.read_text())
def sha(p):
    with p.open('rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()


def require_frozen_indices(frozen, actual):
    """Fallback IDs retain original design gaps; never renumber them."""
    assert len(frozen) == len(set(frozen)), 'Duplicate frozen case index'
    assert sorted(actual) == sorted(frozen), 'Case indices differ from frozen manifest'


def main():
    p = argparse.ArgumentParser()
    for key in ['evidence', 'audit', 'bundle', 'launch', 'output']:
        p.add_argument('--'+key, type=Path, required=True)
    a = p.parse_args()
    root, prov = a.evidence/'output', a.evidence/'provenance'
    live = read(a.launch)
    assert live['job'] == 'plumenav-stage2i-campaign-20260922-063830'
    assert sha(prov/'launch.json') == live['launchProvenanceSha256']
    immutable = read(prov/'launch.json'); expected = immutable['spec']
    job = read(prov/'describe-processing-job.json')
    for key in ['ProcessingJobName', 'AppSpecification', 'ProcessingResources', 'StoppingCondition', 'RoleArn', 'Environment']:
        assert job[key] == expected[key], key
    assert job['ProcessingJobName'] == live['job']
    assert job['ProcessingJobArn'] == live['arn']
    assert job['AppSpecification']['ImageUri'] == live['image']
    assert job['ProcessingJobStatus'] == 'Completed' and not job.get('FailureReason') and not job.get('ExitMessage')
    inputs = json.loads(json.dumps(job['ProcessingInputs']))
    assert len(inputs) == 1 and inputs[0].pop('AppManaged', None) is False
    assert inputs == expected['ProcessingInputs'], 'Unexpected input change beyond AWS AppManaged=false default'
    assert len(job['ProcessingOutputConfig']['Outputs']) == 1
    assert job['ProcessingOutputConfig']['Outputs'][0]['S3Output'] == expected['ProcessingOutputConfig']['Outputs'][0]['S3Output']
    for key in ['archiveSha256', 'bundleSha256', 'deliverySha256', 'smokeClosureSha256', 'independentSmokeAuditSha256']:
        assert immutable[key] == live[key]
    transport = verify_output_manifest(root, allow_empty_upload_markers=True)
    transfer = read(prov/'transfer-verification.json')
    assert transfer['verified'] and transfer['transport'] == transport and transfer['job'] == live['job']
    assert transfer['objectCount'] == 981 and transfer['totalBytes'] == 10198442764
    bundle = read(a.bundle/'bundle.json')
    assert sha(a.bundle/'bundle.json') == live['bundleSha256']
    assert len(bundle['frozenSources']) == 141
    for row in bundle['frozenSources']:
        assert sha(a.bundle/row['file']) == row['sha256']
        assert sha(Path(row['original'])) == row['sha256'], row['original']
    manifest = read(root/'manifest.json')
    assert manifest['mode'] == 'nominal-only' and manifest['bundleSha256'] == live['bundleSha256']
    assert manifest['cases'] == bundle['plan']['nominal-only']['cases']
    assert manifest['configs'] == bundle['plan']['nominal-only']['configs']
    assert len(manifest['cases']) == 480
    assert sum(x['caseRole'] == 'primary' for x in manifest['cases']) == 384
    cloud, local = read(root/'analysis/analysis.json'), read(a.audit/'analysis.json')
    # Use the frozen statistics implementation, not a newly altered analysis.
    import lib
    lib.__path__ = [str(a.bundle/'scripts/lib'), *list(lib.__path__)]
    import importlib.util
    spec = importlib.util.spec_from_file_location('frozen_response_statistics', a.bundle/'scripts/lib/si_response_statistics.py')
    stats = importlib.util.module_from_spec(spec); spec.loader.exec_module(stats)
    for data in [cloud, local]:
        assert data['schemaVersion'] == 'stage2i-audit-v2-nominal' and data['mode'] == 'nominal-only'
        for gate in ['accepted', 'integrityPassed', 'coupledResolutionPassed', 'absentControlPassed', 'absentBitIdentical']:
            assert data[gate] is True, gate
        assert data['bundleSha256'] == live['bundleSha256'] and data['manifestSha256'] == sha(root/'manifest.json')
        assert len(data['details']) == len(data['runs']) == 480 and data['compatibilityCount'] == 0
        frozen_indices = [case['index'] for case in manifest['cases']]
        require_frozen_indices(frozen_indices, [d['index'] for d in data['details']])
        require_frozen_indices(frozen_indices, [r['spec']['index'] for r in data['runs']])
        assert all(d['passed'] and d['audit']['passed'] for d in data['details'])
        assert len(data['triples']) == 48 and all(t['passed'] for t in data['triples'])
        assert data['performance'] == stats.summarize(data['runs'], [1])
        assert data['performance']['independentWorlds'] == 32 and data['performance']['primaryMissions'] == 384
    assert cloud['performance'] == local['performance'], 'Cloud/Mac performance disagreement'
    assert cloud['runs'] == local['runs'], 'Cloud/Mac compact history disagreement'
    for c, l in zip(cloud['triples'], local['triples']):
        assert c['indices'] == l['indices'] and c['gates'] == l['gates']
    for directory in [root/'analysis', a.audit]:
        done = read(directory/'complete.json')
        assert done['complete'] and done['accepted'] and done['analysisSha256'] == sha(directory/'analysis.json')
        assert not (directory/'failure.json').exists()
    terminal = read(root/'job-complete.json')
    assert terminal['complete'] and terminal['accepted'] and terminal['mode'] == 'nominal-only'
    assert terminal['analysisSha256'] == sha(root/'analysis/analysis.json')
    assert terminal['bundleSha256'] == live['bundleSha256'] and terminal['deliverySha256'] == live['deliverySha256']
    log = (root/'audit.log').read_text()
    assert 'audited 480/480' in log
    assert not any(x in log for x in ['Traceback (most recent call last)', 'AssertionError', 'FATAL'])
    cloud_logs = read(prov/'cloudwatch.json')
    assert len(cloud_logs) == 1 and cloud_logs[0]['stream']['logStreamName'] == live['cloudWatchStream']
    assert any('cloud audit accepted' in e['message'] for e in cloud_logs[0]['events'])
    seconds = (datetime.fromisoformat(job['ProcessingEndTime'])-datetime.fromisoformat(job['ProcessingStartTime'])).total_seconds()
    result = dict(schemaVersion='stage2i-campaign-closure-v1', accepted=True,
        checkedAt=datetime.now(timezone.utc).isoformat(), job=live['job'],
        downloadedAndIndependentlyAudited=True, cloudAndLocalPerformanceIdentical=True,
        cases=480, primaryMissions=384, independentPairedWorlds=32, resolutionTriplets=48,
        unchangedOriginalSources=141, mode='nominal-only', transport=transport,
        bundleSha256=live['bundleSha256'], deliverySha256=live['deliverySha256'],
        independentAuditSha256=sha(a.audit/'analysis.json'), cloudAuditSha256=sha(root/'analysis/analysis.json'),
        launchProvenanceSha256=sha(prov/'launch.json'), jobDescriptionSha256=sha(prov/'describe-processing-job.json'),
        outputManifestSha256=sha(root/'SHA256SUMS'), managedRuntimeSeconds=seconds,
        estimatedComputeUSD=seconds/3600*float(live['hourlyUSD']),
        costBasis='Recorded launch rate; excludes ancillary charges and billing rounding',
        localRuntime=dict(python=sys.version, numpy=np.__version__, scipy=scipy.__version__, architecture=platform.machine()),
        localAuditSeconds=local['elapsedSeconds'], claimBoundary=live['claimBoundary'])
    with a.output.open('x') as f: json.dump(result, f, indent=2, allow_nan=False); f.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k != 'transport'}, indent=2))


if __name__ == '__main__': main()
