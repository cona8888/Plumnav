"""Read-only testing of EXISTING development histories, never job admission.

No simulation worker, AWS client, network operation or package rewrite exists in
this driver. Outputs must be a fresh, separate directory under research/results.
"""
import argparse
import ast
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import runpy
import sys
import time

from mechanism_portability_candidate_v1 import (
    VERSION, compare, compare_audits, compare_reference_guard, write_comparison_receipt,
)
from verification_manifest_v1 import write_manifest, verify_manifest

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'aws/build/si-mechanism-preflight-candidate-20260925-v3'
RAW = ROOT / 'research/results/si_mechanism_smoke_v2_cloud_2026-09-26/download'
ARCHIVE = ROOT / 'aws/build/si-mechanism-preflight-candidate-20260925-v3.tar.gz'
ARCHIVE_SHA = '589b28225057adb09790421f29dc66643bc374fcb757c080184686de0c304235'
CLOUD_SHA = 'd6d254f67226056a076870c0aaf9e382817ae6c07b7c155e31cf76af378abb5c'
INHERITED_NS = ROOT / 'research/results/si_mechanism_worker_admission_v2_attempt01_2026-09-25/audit-1.json'
INHERITED_NS_SHA = 'a1b38685b25d94d42bbca6ab367b1dc671832e8b1e5f1037c468602d14ea9be0'


def sha(p):
    with p.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def write(p, value):
    with p.open('x') as f:
        json.dump(value, f, indent=2, allow_nan=False)
        f.write('\n')


def audit_bounds(field):
    """Extract literal limits from the already SHA-verified frozen auditors."""
    values = {}
    for name in ('scripts/audit-si-readout-full-history.py', 'scripts/lib/si_turn_motion_audit.py'):
        tree = ast.parse((PACKAGE / name).read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'close':
                if len(node.args) != 4 or not isinstance(node.args[0], ast.Constant):
                    raise ValueError('Unknown frozen audit call')
                key = node.args[0].value
                tolerance = ast.literal_eval(node.args[3])
                values.setdefault(key, set()).add(tolerance)
    result = {}
    for key, limits in values.items():
        if key == 'fieldInput':
            if limits != {1e-12, 1e-10}:
                raise ValueError('Field-bound schema changed')
            result[key] = 1e-12 if field == 'blank' else 1e-10
        elif len(limits) == 1:
            result[key] = next(iter(limits))
        else:
            raise ValueError('Ambiguous audit bound: ' + key)
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--candidate-policy', required=True, choices=[VERSION])
    a = p.parse_args()
    out = a.output.absolute()
    if (out.exists() or out.is_symlink() or out.parent.resolve() != ROOT / 'research/results'):
        raise ValueError('Use a fresh direct child of research/results')
    out.mkdir()
    started = time.monotonic()
    result = dict(version=VERSION, createdAt=datetime.now(timezone.utc).isoformat(),
                  accepted=False, admissionAllowed=False, newMissions=0,
                  realAwsCalls=0, physicalValidation=False, cases=[])
    # Snapshot all frozen package files and raw downloaded evidence, plus previous
    # rejection/diagnostic receipts. Comparing before/after does not modify them.
    preserved = [x for x in PACKAGE.rglob('*') if x.is_file()]
    evidence = RAW.parent
    preserved += [x for x in evidence.rglob('*') if x.is_file()]
    preserved += [ARCHIVE, INHERITED_NS, ROOT / 'aws/si_mechanism_smoke_bootstrap_v1.py',
                  ROOT / 'aws/si_mechanism_smoke_entrypoint_v2.sh',
                  ROOT / 'aws/build/PlumeNav_mechanism_smoke_launcher_20260926_v2.zip',
                  ROOT / 'research/protocols/si_readout_mechanism_128_v1_2026-09-25.md']
    prior = ROOT / 'research/results/si_mechanism_portability_candidate_v1_attempt01_2026-09-27'
    if prior != out and prior.exists():
        preserved += [x for x in prior.rglob('*') if x.is_file()]
    before = {str(x.relative_to(ROOT)): sha(x) for x in preserved}
    write(out / 'preserved-before.json', before)
    try:
        if sha(ARCHIVE) != ARCHIVE_SHA:
            raise ValueError('Frozen archive changed')
        checks = runpy.run_path(str(ROOT / 'scripts/verify-mechanism-smoke-v2-download.py'))['checksums']
        result['packagedPayloadsVerified'] = len(checks(PACKAGE, 'SHA256SUMS'))
        # Load the original modules FROM the sealed package, not mutable copies.
        sys.path.insert(0, str(PACKAGE / 'scripts'))
        from lib.si_mechanism_history_v1 import history, load, pinned, full_audit, canonical, terminal
        from lib.si_mechanism_registry_v3 import Registry
        import numpy
        result['runtime'] = dict(python=platform.python_version(), numpy=numpy.__version__,
                                 machine=platform.machine())
        delivery = load(PACKAGE / 'delivery.json')
        registry = Registry(PACKAGE / delivery['manifest']['path'], delivery['manifest']['sha256'])
        for entry in delivery['smokeCases']:
            cid = entry['caseId']; case = registry.cases[cid]
            refpath = pinned(entry['referenceHistory']); bound = load(pinned(entry['boundReceipt']))
            if bound['passed'] is not True or bound['history']['sha256'] != sha(refpath):
                raise ValueError('Reference receipt binding')
            ref = history(refpath)
            ref_details, ref_guard = full_audit(ref, case['arm'])
            ref_endpoint = terminal(ref)
            bounds = audit_bounds(case['spec']['field'])
            inherited = None
            if bound['guard'] is None:
                if cid != 'mechanism-development-3000-NS-blank-n64' or sha(INHERITED_NS) != INHERITED_NS_SHA:
                    raise ValueError('Unexpected inherited reference guard')
                inherited = load(INHERITED_NS)
            reference_checks = dict(
                audit=compare_audits(bound['details'], ref_details, bounds, VERSION),
                endpoint=compare(bound['extracted'], ref_endpoint),
                guard=compare_reference_guard(bound, ref_guard, inherited))
            write(out / (cid + '-reference-audit.json'), dict(
                actualAuditDetails=ref_details, guard=ref_guard, checks=reference_checks,
                inheritedAuditSha256=INHERITED_NS_SHA if inherited is not None else None))
            if not all(x['passed'] for x in reference_checks.values()):
                raise ValueError('Reference re-audit failed: ' + cid)
            canonical(ref)  # Only the previously frozen canonical exclusions.
            for mode, suffix in (('strict', 'strict'), (VERSION, 'candidate')):
                receipt = write_comparison_receipt(out / (cid + '-self-' + suffix + '.json'),
                    ref, ref, ref_details, ref_details, bounds, ref_endpoint, ref_endpoint, mode)
                if not receipt['candidateChecksPassed']:
                    raise ValueError('Self-comparison failed: ' + cid)
            result['cases'].append(dict(caseId=cid, role='pinned-reference-selfcheck',
                historySha256=sha(refpath), independentFullAuditPassed=True,
                strictComparisonPassed=True, candidateComparisonPassed=True))
            print('REFERENCE_REAUDITED ' + cid, flush=True)
            if entry != delivery['smokeCases'][0]:
                continue
            # In-memory corruptions of an existing record, never new missions.
            # Test that the unchanged full scientific auditor remains a real gate.
            mutations = []
            for label, col, delta in (('body-position', 1, .001),
                                      ('physical-input', 12, .1),
                                      ('hardware-readout', 20, .001)):
                changed = dict(ref, trace=list(ref['trace']))
                changed['trace'][0] = list(ref['trace'][0])
                changed['trace'][0][col] += delta
                comparison = compare(ref, changed, VERSION)
                rejection = None
                try:
                    full_audit(changed, case['arm'])
                except (AssertionError, ValueError) as error:
                    rejection = type(error).__name__ + ': ' + str(error)
                mutations.append(dict(mutation=label, rejectedByPortability=not comparison['passed'],
                                      rejectedByFullAudit=rejection is not None, reason=rejection))
                del changed
            write(out / 'real-history-corruption-tests.json', dict(
                newMissions=0, mutations=mutations, accepted=False))
            if not all(x['rejectedByPortability'] and x['rejectedByFullAudit'] for x in mutations):
                raise ValueError('Real-history corruption escaped a verification gate')
            result['realHistoryCorruptionsRejected'] = len(mutations)
            cloudpath = RAW / 'output/smoke/cases' / cid / 'mission.json.gz'
            if sha(cloudpath) != CLOUD_SHA:
                raise ValueError('Downloaded diagnostic history changed')
            done = load(cloudpath.parent / 'complete.json')
            proc = load(RAW / 'output/smoke/terminals' / (cid + '-mission.json'))
            if not (done['completed'] is True and done['historySha256'] == CLOUD_SHA
                    and done['case'] == case and done['parentManifestSha256'] == delivery['manifest']['sha256']
                    and done['replay']['passed'] is True and done['replay']['privateFieldQueries'] == 0
                    and type(proc['exitCode']) is int and proc['exitCode'] == 0 and proc['timedOut'] is False):
                raise ValueError('Cloud worker provenance failed')
            cloud = history(cloudpath)
            if cloud['spec'] != case['spec'] or cloud['development'] is not None:
                raise ValueError('Cloud specification mismatch')
            details, guard = full_audit(cloud, case['arm'])
            extracted = terminal(cloud)
            # Save actual audit output before ANY portability comparison.
            write(out / (cid + '-cloud-reaudit.json'), dict(actualAuditDetails=details,
                guard=guard, endpoint=extracted, independentlyReauditedOn='local Mac',
                originalCloudAuditDetailsAvailable=False))
            if not compare(ref_guard, guard)['passed']:
                raise ValueError('Auditor guard changed')
            canonical(cloud)
            receipts = {}
            for mode, suffix in (('strict', 'strict'), (VERSION, 'candidate')):
                receipts[suffix] = write_comparison_receipt(out / (cid + '-cloud-' + suffix + '.json'),
                    ref, cloud, ref_details, details, bounds, ref_endpoint, extracted, mode)
            job = load(RAW / 'provenance/describe-processing-job.json')
            if job['ProcessingJobStatus'] != 'Failed':
                raise ValueError('Unexpected historical job state')
            result['cases'].append(dict(caseId=cid, role='failed-cloud-diagnostic-only',
                historySha256=CLOUD_SHA, independentFullAuditPassed=True,
                strictComparisonPassed=receipts['strict']['candidateChecksPassed'],
                candidateComparisonPassed=receipts['candidate']['candidateChecksPassed'],
                historyComparison=receipts['candidate']['history'], jobStatusUnchanged='Failed',
                jobAccepted=False))
            print('FAILED_CLOUD_DIAGNOSTIC_REAUDITED ' + cid, flush=True)
            del cloud
        registry.protect()
        result['completedLocalChecks'] = True
    except Exception as e:
        result.update(completedLocalChecks=False, error=type(e).__name__ + ': ' + str(e))
        raise
    finally:
        after = {str(x.relative_to(ROOT)): sha(x) for x in preserved}
        result['preservedFiles'] = len(before)
        result['preservedHashesUnchanged'] = before == after
        result['elapsedSeconds'] = time.monotonic() - started
        result['verificationSources'] = {str(x.relative_to(ROOT)): sha(x) for x in (
            Path(__file__), ROOT / 'scripts/mechanism_portability_candidate_v1.py',
            ROOT / 'scripts/verification_manifest_v1.py',
            ROOT / 'scripts/test-mechanism-verification-candidate-v1.py',
            ROOT / 'research/protocols/si_mechanism_portability_candidate_v1_2026-09-27.md')}
        write(out / 'verification.json', result)
        # Only derived, known outputs are included; no uploader metadata exists.
        expected = sorted(x.name for x in out.iterdir() if x.is_file())
        write_manifest(out, expected)
        verify_manifest(out, expected)
        print(json.dumps(result, indent=2), flush=True)
        if before != after:
            raise ValueError('Preserved input changed during checks')


if __name__ == '__main__':
    main()
