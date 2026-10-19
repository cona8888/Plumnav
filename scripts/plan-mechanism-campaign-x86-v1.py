"""Read-only science admission and derived AWS deadline arithmetic; no missions.

Resource scenarios are NOT an admitted forecast or launch specification. No
outcome values are read to choose resources, seeds, endpoints or sample size.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
from lib.si_mechanism_registry_v3 import Registry

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'research/results/si_mechanism_all_arm_v2_attempt01_2026-09-25/prospective_manifest_v2.json'
MANIFEST_SHA = '0f68a87ea6a902848948338d1c5d076bef214bb7f5e59708203df77c2cb6d6cd'


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def plan(smoke_root):
    registry = Registry(MANIFEST, MANIFEST_SHA)
    counts = Counter(case['spec']['caseRole'] for case in registry.cases.values())
    assert counts == {'primary': 1920, 'resolution-witness': 480}
    terminals = sorted((smoke_root / 'download/output/runs').glob('*/terminals/*.json'))
    assert len(terminals) == 12
    groups = {'mission': [], 'audit': []}
    for path in terminals:
        value = json.loads(path.read_text())
        assert value['exitCode'] == 0 and value['timedOut'] is False
        role = 'mission' if path.name.endswith('-mission.json') else 'audit'
        assert value['elapsedSeconds'] > 0
        groups[role].append(value['elapsedSeconds'])
    assert all(len(values) == 6 for values in groups.values())
    per_case = max(groups['mission']) + max(groups['audit'])
    verification = smoke_root / 'verification.json'
    admitted = verification.exists() and json.loads(verification.read_text()).get('accepted') is True
    return dict(version='mechanism-x86-three-day-planning-v1',
        createdAt=datetime.now(timezone.utc).isoformat(),
        targetDeadlineUTC='2026-10-02T21:40:39Z',
        primaryPlatform='AWS x86_64; pinned image and one numerical thread per process',
        science=dict(manifest=str(MANIFEST.relative_to(ROOT)), sha256=MANIFEST_SHA,
            sourcePinsVerified=len(registry.document['sources']), worlds=128,
            histories=2400, primaryHistories=1920, refinementHistories=480,
            triplets=240, unchanged=True),
        smoke=dict(independentDownloadedAcceptance=admitted,
            verificationSha256=sha(verification) if verification.exists() else None,
            terminalPins=[dict(path=str(p.relative_to(ROOT)),sha256=sha(p)) for p in terminals],
            maximumMissionSeconds=max(groups['mission']), maximumAuditSeconds=max(groups['audit']),
            caveat='Three fixed development cases repeated: not all-arm, worst-case, memory or concurrency evidence.'),
        arithmeticScenarios=[dict(workers=n,
            serialTaskWallHours=per_case*2400/3600,
            idealWallHours=per_case*2400/3600/n,
            wallHoursWith50PercentHeadroom=per_case*2400/3600/n*1.5,
            doubledDurationStressHours=per_case*2400/3600/n*3,
            admitted=False) for n in (4,8,16)],
        storage=dict(planningGiB=116, doubledDurationStressGiB=232,
            currentMacFreeGiB=shutil.disk_usage(ROOT).free/1024**3,
            candidateManagedVolumeGiB=300,
            strategy='Preserve raw histories in private S3. Download all inputs into a separately provisioned x86 audit job, verify full hashes and re-audit independently; return sealed receipts and analysis to Mac. Do not delete old evidence or fit the whole campaign into Mac storage.',
            admitted=False),
        executionOrder=[
            'Accept all six downloaded smoke histories and exact repeatability.',
            'Admit separately versioned production worker/runner with synthetic negative fixtures; preserve all scientific equations and assignments.',
            'Measure all-arm development peak process-tree memory and concurrent throughput on x86; no reserved-world tuning.',
            'Freeze production package and measured concurrency; verify current price, quota, runtime/volume headroom and authorised spend before submission.',
            'Execute 2400 complete histories with per-history replay/audit, failure propagation and durable continuous S3 markers.',
            'Download and independently re-audit all histories and all 240 triplets on adequately sized x86 storage; compute frozen world-paired statistics.',
            'Seal results, adverse outcomes and limitation/claim map; deliver concise findings by deadline if acceptance passes.'],
        deadlinePolicy='Aim to reserve the final 18–24 hours for independent audit, numerical triplets and analysis. Do not relax science gates or call a terminal job scientifically accepted to meet the date.',
        newSimulations=0, awsCalls=0, campaignLaunched=False,
        currentLaunchDecision='NOT ADMITTED: production worker, measured resource witness, fresh price/quota/budget and independent campaign auditor still required.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--smoke-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = plan(args.smoke_root.resolve())
    with args.output.open('x') as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write('\n')
    print(json.dumps(dict(worlds=128, histories=2400,
        sourcePinsVerified=result['science']['sourcePinsVerified'],
        smokeAccepted=result['smoke']['independentDownloadedAcceptance'],
        campaignLaunched=False, simulations=0)))
