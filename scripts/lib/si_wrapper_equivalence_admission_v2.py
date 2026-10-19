"""V2 exact equivalence core, applying the frozen RPC exclusion to both views.

All numerical trajectories and hardware readout traces must match an already
independently audited x86 reference. This prospective wrapper-only check never
relaxes the original resource importer, generates fields, or recomputes physics
with different Mac numerical libraries. A separate terminal verifier must first
authenticate every source, input, output and reference receipt/body hash.
"""
import copy
import hashlib
import importlib.util
import math
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DEV_SHA = '666126c63b3d9e4cd6686320ed8c6a49a643bd1783ac8e09aaa408cc6db49946'
REFERENCE_JOB = 'plumenav-mech-resource-v2-20260930-050952'
RESOURCE_VERIFIER_SHA = '3c363029e78acaa1db6ffc6ef7a2cea9f365f0516dbed90ebacb3b6bca47888d'
RESOURCE_IMPORTER_SHA = '2ff4901be64d8131bcf355d92257da99acca806da79b422d1cd2151e0ce16b89'
CASES = ('mechanism-development-3000-RW-si-continuous-n64',
         'mechanism-development-3000-GL-si-pulse-n64',
         'mechanism-development-3000-NS-blank-n64')
PINS = {
    'scripts/lib/si_mechanism_history_v1.py': '4dd8c2d0b5f3eb333c6c9abff27778a5d2b50c164c44ce9ea03513d0bf270df9',
    'aws/build/PlumeNav_mechanism_aws_first_20260928_v2_attempt01/overlay/mechanism_portability_candidate_v1.py':
        '2e09ea5b9aeee71079cc4be5b3998585bd383808a0a1fc9cc0c18290e5e27d33'
}


def need(ok, why):
    if not ok: raise ValueError(why)


def sha(path):
    with Path(path).open('rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()


def dependencies():
    for name, digest in PINS.items():
        need(sha(ROOT/name) == digest, 'Frozen equivalence source changed: ' + name)
    from lib.si_mechanism_history_v1 import canonical
    path = ROOT / next(n for n in PINS if n.endswith('mechanism_portability_candidate_v1.py'))
    spec = importlib.util.spec_from_file_location('strict_wrapper_comparison', path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return canonical, m.compare


def reference_coverage(accepted, terminal, accepted_sha):
    """Validate the exact prior scope; caller must authenticate files and hashes."""
    need(accepted['accepted'] is True and accepted['independentDownloadedAuditPassed'] is True
         and accepted['job'] == REFERENCE_JOB and accepted['sourceScriptSha256'] == RESOURCE_IMPORTER_SHA
         and accepted['exactComparisons'] == 75 and accepted['productionAdmitted'] is False
         and accepted['performanceEvidence'] is False, 'Unaccepted original-rule x86 reference')
    need(terminal['accepted'] is True and terminal['sourceScriptSha256'] == RESOURCE_VERIFIER_SHA
         and terminal['producerJob'] == REFERENCE_JOB and terminal['resourceVerificationSha256'] == accepted_sha
         and terminal['independentAuditFilesVerified'] == 120 and terminal['exactComparisonsVerified'] == 75
         and terminal['outputObjects'] == 486 and terminal['scientificallyAccepted'] is False
         and terminal['productionAdmitted'] is False, 'Missing independent reference terminal acceptance')
    rows = accepted['independentAudits']; verified = terminal['verifiedHistories']
    need(len(rows) == len(verified) == 120 and all(r['passed'] is True for r in rows + verified),
         'All 120 audited references required')
    by_key = {(r['phase'], r['caseId']): r for r in rows}
    terminal_key = {(r['phase'], r['caseId']): r for r in verified}
    expected = {(phase, f'mechanism-development-3000-{arm}-{field}-n{dt}')
        for phase in ('baseline', 'candidate', 'stress-a', 'stress-b')
        for arm in ('RW','GW','RL','GL','NS') for field in ('si-continuous','si-pulse','blank')
        for dt in ((16,32,64) if phase in ('baseline','candidate') else (64,))}
    need(set(by_key) == set(terminal_key) == expected and len(by_key) == len(terminal_key) == 120,
         'Exact independently accepted reference membership')
    need(all(by_key[k]['historySha256'] == terminal_key[k]['historySha256'] for k in expected),
         'Reference acceptance/history SHA cross-binding')
    return {cid: by_key['candidate', cid] for cid in CASES}


def record_binding(record, child, done, receipt, diagnostic, mission_process, case, world, history_sha, mode):
    need(case['id'] in CASES and mode == 'development', 'Wrapper witness cannot admit reserved worlds')
    need(type(mission_process['exitCode']) is int and mission_process['exitCode'] == 0
         and mission_process['timedOut'] is False, 'Full mission process did not finish')
    need(child['version'] == 'mechanism-worker-case-v4' and child['executionMode'] == mode
         and child['case'] == done['case'] == receipt['case'] == case and child['world'] == world,
         'Case/world/worker identity chain')
    need(child['parentManifestSha256'] == done['parentManifestSha256'] == receipt['manifestSha256'] == DEV_SHA
         and done['caseId'] == receipt['caseId'] == case['id'], 'Manifest/case identity chain')
    need(done['completed'] is True and done['developmentOnly'] is True and done['performanceCampaign'] is False
         and done['historySha256'] == receipt['historySha256'] == diagnostic['historySha256'] == history_sha,
         'Development completion/history chain')
    need(done['replay']['passed'] is True and done['replay']['privateFieldQueries'] == 0
         and done['replay']['schedulingTraceMatched'] is True, 'Source-blind public replay failed')
    need(record['spec'] == case['spec'] and record['development'] is None
         and record['summary']['stage'] == done['stage']
         and record['summary']['completedAt'] == done['completedAt'], 'Whole raw-history terminal/spec binding')
    need(receipt['passed'] is True and receipt['detailsPassed'] is True and diagnostic['details']['passed'] is True
         and receipt['scientificallyAccepted'] is False, 'Full numerical audit did not pass')
    v = record['verification']
    if v is not None:
        need(v['version'] == 'mechanism-exact-v2' and v['manifestSha256'] == DEV_SHA and v['exactPoseOnly'] is True
             and v['context'] == dict(caseId=case['id'], worldKey=case['worldKey'], arm=case['arm'],
                field=case['spec']['field'], reportingReplicate=world['reportingReplicate']), 'Verifier metadata binding')


def exact_equivalence(reference, witness, reference_diagnostic, witness_diagnostic, reference_arrays, witness_arrays):
    """Compare all data, not summary metrics. No tolerance policy is enabled."""
    canonical, compare = dependencies()
    for record in (reference,witness):
        rpc=record['summary']['rpcMilliseconds']
        need(type(rpc) in (int,float) and math.isfinite(rpc) and rpc>=0, 'Invalid excluded RPC timing')
    # The frozen canonical function mutates its argument. Preserve saved inputs.
    h = compare(canonical(copy.deepcopy(reference)), canonical(copy.deepcopy(witness)), mode='strict')
    need(h['passed'] is True and h['exact'] is True, 'Complete canonical numerical history differs')
    # Container-specific gzip/NPZ serialization hashes and the resource worker's
    # referenceComparison receipt are provenance, not numeric fields. Every
    # numerical diagnostic field is compared exactly, including residuals.
    keys = ('details', 'guard', 'extracted', 'compact')
    def diagnostic_view(value):
        view=copy.deepcopy({k:value[k] for k in keys})
        summary=view['compact'].get('summary')
        if type(summary) is dict and 'rpcMilliseconds' in summary:
            rpc=summary['rpcMilliseconds']
            need(type(rpc) in (int,float) and math.isfinite(rpc) and rpc>=0, 'Invalid compact RPC timing')
            summary['rpcMilliseconds']=0
        return view
    d = compare(diagnostic_view(reference_diagnostic),diagnostic_view(witness_diagnostic),mode='strict')
    need(d['passed'] is True and d['exact'] is True, 'Full audit diagnostic differs')
    need(set(reference_arrays) == set(witness_arrays) == {'positions','scalar'}, 'Exact NPZ array member set')
    for k in reference_arrays:
        a, b = reference_arrays[k], witness_arrays[k]
        need(a.dtype.kind == b.dtype.kind == 'f' and a.dtype == b.dtype and a.shape == b.shape
             and np.isfinite(a).all() and np.isfinite(b).all()
             and a.tobytes() == b.tobytes(), 'Full finite binary array differs: ' + k)
    return dict(passed=True, exactWholeCanonicalHistory=True, exactFullAuditDiagnostics=True,
        exactFullArrays=True, numericalToleranceRelaxed=False,
        exclusions='Frozen canonical RPC milliseconds in the raw history and its compact diagnostic view; separately bound verifier metadata; serialization/provenance hashes not numeric data',
        terminalProvenanceVerified=False, numericalSameWrapperAdmissionPassed=False,
        productionAdmitted=False, scientificallyAccepted=False)

