"""Bind three pinned existing development records; no new scientific audit."""
import gzip
import hashlib
import json
from pathlib import Path
from lib.si_exact_registry_v1 import strict_json
from lib.si_terminal_report_v1 import terminal_metadata
from lib.si_release_endpoint_v2 import endpoint

PARENT = 'research/results/si_scan_disabled_mission_admission_v1_attempt01_2026-09-24'
PARENT_SHA = 'fd074f85c1c7f88ce883180b7610a9a9c59e2f130f6288e37d188fdb2ed520d1'
CASES = tuple(f'{field}-scan-disabled-n64' for field in ('si-continuous', 'si-pulse', 'blank'))
VERSIONS = dict(schemaVersion='si-event-exact-integration-run-v1', acquisitionMode='scan-disabled',
                scanDisabledVersion='scan-disabled-acquisition-v1', schedulingTraceRole='passive-eligibility-observer',
                availabilityVersion='stationary-scan-readout-v1', availability='live-passive',
                responseVersion='linear-inlet-v1', motionVersion='antipodal-positive-v1', schedulingVersion='encounter-gate-v1')


def need(condition, message):
    if not condition:
        raise ValueError(message)


def same(left, right):
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def checked_path(root, relative):
    need(type(relative) is str and not relative.startswith('/') and '\\' not in relative, 'Unsafe relative path')
    need(all(part not in ('', '.', '..') for part in relative.split('/')), 'Unsafe path component')
    path = Path(root)
    for part in relative.split('/'):
        path = path/part
        need(not path.is_symlink(), 'Symlink not admitted')
    need(path.is_file() and path.resolve().is_relative_to(Path(root).resolve()), 'Missing or escaping input')
    return path


def read_pinned(root, item, compressed=False):
    path = checked_path(root, item['path'])
    limit = 64*1024**2 if compressed else 2*1024**2
    need(path.stat().st_size <= limit, 'Compressed/metadata byte cap')
    raw = path.read_bytes()
    need(hashlib.sha256(raw).hexdigest() == item['sha256'], 'Input hash mismatch')
    if compressed:
        # A bounded read rejects oversized decompressed input before JSON parsing.
        with gzip.open(path, 'rb') as stream:
            decoded = stream.read(1024**3+1)
        need(len(decoded) <= 1024**3, 'Decompressed byte cap')
        return strict_json(decoded), len(raw)
    return strict_json(raw)


def check_chain(case, docs, history_sha, history_bytes):
    need(case in CASES, 'Undeclared development case')
    parent, accepted, complete = docs['parent'], docs['acceptance'], docs['batchComplete']
    need(parent['version'] == 'scan-disabled-mission-admission-v1', 'Parent version')
    items = [item for item in parent['cases'] if item['id'] == case]
    need(len(items) == 1, 'Missing or duplicated parent case')
    item = items[0]; spec = item['spec']
    expected = dict(index=0, panel='linear-fresh', studyId='scheduling-response-replication-v1',
                    caseRole='diagnostic', responseScale=1, worldIndex=0, replicate=3000,
                    field=case.removesuffix('-scan-disabled-n64'), method='quad-sniff-refine', policy='reference',
                    navDt=1/64, worldSeed=281301, sourceSeed=281501, startSeed=281701, controllerSeed=281901)
    need(same(spec, expected) and item['kind'] == 'candidate' and item['acquisitionMode'] == 'scan-disabled', 'Undeclared spec')
    need(accepted['accepted'] is True and accepted['manifestSha256'] == PARENT_SHA and
         accepted['fullPerformanceCampaignAdmitted'] is False and accepted['physicalValidation'] is False, 'Parent acceptance')
    need(complete['completed'] is True and complete['accepted'] is True, 'Incomplete batch')
    child, done, proc, audit_proc, audit = (docs[k] for k in ('childManifest', 'completion', 'process', 'auditProcess', 'audit'))
    need(child['version'] == parent['version'] and child['parentManifestSha256'] == PARENT_SHA, 'Child parent identity')
    need(child['caseId'] == done['caseId'] == audit['caseId'] == case and same(child['item'], item) and same(done['item'], item), 'Case identity mismatch')
    need(done['completed'] is True and done['developmentOnly'] is True and done['acquisitionMode'] == 'scan-disabled', 'Incomplete or non-development record')
    need(done['historySha256'] == history_sha and type(done['bytes']) is int and done['bytes'] == history_bytes, 'Completion history mismatch')
    need(done['replay']['passed'] is True and done['replay']['privateFieldQueries'] == 0 and done['replay']['scanDisabledTraceMatched'] is True, 'Public replay not accepted')
    for label, terminal, executable in (('mission', proc, 'outputs/si-scan-disabled-mission-v1.mjs'),
                                         ('audit', audit_proc, 'scripts/audit-si-scan-disabled-mission.py')):
        need(type(terminal['exitCode']) is int and terminal['exitCode'] == 0 and terminal['timedOut'] is False, label+' failed or timed out')
        cmd = terminal['command']
        need(type(cmd) is list and len(cmd) == 6 and cmd[1:] == [executable, '--root', PARENT, '--case', case], label+' command mismatch')
        need(sum(same(row, terminal) for row in complete['commands']) == 1, label+' absent from parent process receipts')
    need(audit['passed'] is True and audit['details']['passed'] is True and
         audit['historySha256'] == history_sha and audit['manifestSha256'] == PARENT_SHA and audit['physicalValidation'] is False,
         'Independent audit receipt mismatch')
    return spec


def project(record, spec, done):
    need(same(record['spec'], spec) and record['development'] is None, 'History spec/development mismatch')
    need(all(record[key] == value for key, value in VERSIONS.items()), 'Unsupported saved record contract')
    summary = record['summary']; config = record['config']; field = spec['field']
    need(summary['stage'] == done['stage'] and summary['completedAt'] == done['completedAt'], 'Terminal/completion mismatch')
    need(summary['acquisitionBudgetSeconds'] == 600 and 600 <= summary['completedAt'] <= 1200 and
         summary['assertedNoLeak'] is False and summary['physicalSourceConfirmed'] is False, 'Budget or unsupported physical claim')
    cfg = {key: config[key] for key in ('domainMeters', 'targetStatus')}
    if field == 'blank':
        need('sourcePositionOverride' not in config, 'Blank contains source coordinate')
    else:
        cfg['sourcePositionOverride'] = config['sourcePositionOverride']
    nomination = None if record['nomination'] is None else {'point': record['nomination']['point']}
    verification = None
    if record['verification'] is not None:
        full = record['verification']
        need(full['version'] == 'readout-exact-admission-v1', 'Verifier version')
        arms = []
        for arm in full['arms']:
            d = arm['decision']; candidate = d['candidate']
            if d['status'] == 'supported':
                candidate = {'geometry': {'peak': candidate['geometry']['peak']}}
            arms.append(dict(poseRadiusMetres=arm['poseRadiusMetres'], decision=dict(status=d['status'], candidate=candidate)))
        verification = dict(exactPoseOnly=full['exactPoseOnly'], arms=arms)
    projected = dict(field=field, config=cfg, nomination=nomination, verification=verification,
                     summary={key: summary[key] for key in ('stage', 'errors')})
    # Audit attestation enters only after the caller verifies the pinned chain.
    return terminal_metadata(**projected)


def extract(record, spec, done):
    meta = dict(auditPassed=True, **project(record, spec, done))
    return dict(metadata=meta, endpoint=endpoint(meta))
