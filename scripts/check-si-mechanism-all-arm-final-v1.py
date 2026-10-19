"""Preservation and negative execution gates after local package smoke; no mission."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from lib.si_mechanism_registry_v3 import Registry

ROOT = Path(__file__).resolve().parents[1]
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def load(path): return json.loads(path.read_text())


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--admission', type=Path, required=True)
    p.add_argument('--package', type=Path, required=True)
    p.add_argument('--smoke', type=Path, required=True)
    p.add_argument('--node', required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    admission, package, smoke = (x.resolve() for x in (a.admission, a.package, a.smoke))
    accepted = load(admission/'acceptance.json')
    assert accepted['accepted'] and accepted['newPerformanceWorlds'] == 0
    assert accepted['boundCases'] == 45 and accepted['passedTriplets'] == 15
    for field, name in [('assemblySha256', 'assembly_acceptance.json'), ('contractSha256', 'contract_acceptance.json'), ('bindingLedgerSha256', 'binding_ledger.json')]:
        assert sha(admission/name) == accepted[field]
    assembly = load(admission/'assembly_acceptance.json')
    assert assembly['passed'] and assembly['oneWorldInferenceRejected']
    assert len(assembly['triplets']) == 15 and all(x['numerical']['passed'] and x['endpointGate']['passed'] for x in assembly['triplets'])
    prospective = admission/'prospective_manifest_v2.json'
    r = Registry(prospective, accepted['prospectiveManifestSha256'])
    Registry(admission/'development_manifest.json', accepted['developmentManifestSha256'])
    previous = ROOT/'research/results/si_mechanism_worker_admission_v2_attempt01_2026-09-25'
    old = load(previous/'prospective_manifest.json')
    assert sha(previous/'prospective_manifest.json') == '8500ceb2cbaf7b77a4a64799e3c080a36a3ad0f40a339ce7c9b1426efb8d96a8'
    assert r.document['worlds'] == old['worlds'] and r.document['cases'] == old['cases']
    for row in old['sources']:
        assert sha(ROOT/row['path']) == row['sha256']
    inventory = load(previous/'historical_identity_inventory.json')
    for row in inventory['files']:
        assert sha(ROOT/row['path']) == row['sha256']
    protected = load(ROOT/'research/results/si_interface_analysis_closeout_2026-09-24.json')['unchangedDrafts']
    for name, expected in protected.items():
        assert sha(ROOT/'research/publication_closeout_2026-09-22/draft_v3'/name) == expected
    typepath = ROOT/'research/results/si_mechanism_all_arm_typecheck_2026-09-25.json'
    assert load(typepath)['noNewDiagnostics'] is True
    archive = package.with_name(package.name+'.tar.gz')
    package_receipt = archive.with_name(archive.name+'.json')
    sealed = load(package_receipt)
    assert sealed['prepared'] and not sealed['uploaded'] and not sealed['paidLaunchAuthorized']
    assert sha(archive) == sealed['sha256']
    assert sha(package/'delivery.json') == sealed['deliverySha256']
    assert sha(package/'SHA256SUMS') == sealed['checksumIndexSha256']
    for folder in (package, smoke):
        for line in (folder/'SHA256SUMS').read_text().splitlines():
            digest, name = line.split('  ', 1)
            path = (folder/name).resolve()
            assert path.is_relative_to(folder) and sha(path) == digest
    complete = load(smoke/'complete.json')
    assert complete['completed'] and complete['accepted']
    assert complete['deliverySha256'] == sha(package/'delivery.json')
    delivery = load(package/'delivery.json')
    expected_ids = [x['caseId'] for x in delivery['smokeCases']]
    assert complete['caseIds'] == expected_ids and len(expected_ids) == 3
    for cid in expected_ids:
        audit = load(smoke/'audits'/(cid+'.json'))
        assert audit['passed'] and audit['wholeReferenceMatched']
        assert audit['historySha256'] == sha(smoke/'cases'/cid/'mission.json.gz')
    env = dict(os.environ, PYTHON=sys.executable, PYTHONDONTWRITEBYTECODE='1', PYTHONNOUSERSITE='1', OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1')
    env.pop('PYTHONPATH', None)
    checks = []
    def reject(name, command, cwd, message):
        result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=45)
        assert result.returncode != 0 and message in result.stderr, (name, result.stdout, result.stderr)
        checks.append(dict(name=name, command=command, exitCode=result.returncode, stdout=result.stdout, stderr=result.stderr))
    forbidden = admission/'forbidden-fresh-execution'
    assert not forbidden.exists()
    reject('fresh performance lock', [a.node, str(admission/'worker.mjs'), '--manifest', str(prospective), '--sha256', sha(prospective), '--case', r.document['cases'][0]['id'], '--output', str(forbidden)], ROOT, 'Fresh campaign execution is not authorised/admitted')
    assert not forbidden.exists()
    reject('wrong packaged manifest digest', [sys.executable, '-B', str(package/'scripts/check-si-mechanism-manifest-v3.py'), '--manifest', str(package/delivery['manifest']['path']), '--sha256', '0'*64], package, 'Manifest hash mismatch')
    reject('local machine cannot claim pinned cloud runtime', [sys.executable, '-B', str(package/'aws/mechanism-preflight-v3/run.py'), '--mode', 'inspect', '--cloud-runtime', '--node', a.node], package, 'Unexpected pinned-image runtime')
    receipt = dict(passed=True, createdAt=datetime.now(timezone.utc).isoformat(), acceptanceSha256=sha(admission/'acceptance.json'),
                   protectedSourceEntries=len(r.document['sources']), previousSourceEntries=len(old['sources']),
                   unchangedHistoricalMetadata=len(inventory['files']), draftsUnchanged=protected,
                   freshWorldsCasesUnchanged=True, freshExecutionBlocked=True, newPerformanceWorlds=0,
                   newlyExecutedDevelopmentMissions=accepted['newDevelopmentMissions'], additionalPackagedDevelopmentMissions=3,
                   packageArchiveSha256=sha(archive), packageReceiptSha256=sha(package_receipt), smokeCompleteSha256=sha(smoke/'complete.json'),
                   typecheckSha256=sha(typepath), negativeChecks=checks, scriptSha256=sha(Path(__file__)), paidActions=0,
                   cloudValidated=False, cleanInstallValidated=False, physicalValidation=False)
    with a.output.open('x') as f:
        json.dump(receipt, f, indent=2, allow_nan=False); f.write('\n')
    print(json.dumps({k:v for k,v in receipt.items() if k not in ('negativeChecks','draftsUnchanged')}))


if __name__ == '__main__': main()
