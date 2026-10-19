"""Full downloaded producer provenance preflight, NOT numerical acceptance.

Authenticate the terminal AWS launch and every downloaded body, then bind all
2400 saved cases to the frozen prospective source. No AWS calls, trajectories,
gzip replay, NumPy calculations or numerical tolerance changes. The unchanged
x86 saved-history auditor must still execute all full numerical audits and all
240 resolution triplets, followed by a separate terminal audit acceptance.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
from pathlib import Path, PurePosixPath
import re
import tarfile

ROOT = Path(__file__).resolve().parents[1]
JOB = 'plumenav-mech-campaign-v1-20260930-184421'
INTENT_SHA = '7070543875aac1eba845c9503ad1d99bf395ad09f41711b654bf3c3131cbdf80'
ADMISSION_SHA = 'b5782d5dc5a0b0c519890aeeaeaf24566e0c4679ff3a2a1e05c56e5b6eac971b'
BUNDLE_SHA = '8b4094ef09910a19277574d703220e59839da063795e4369487d55c1bcfe53be'
RELEASE_SHA = 'a0416da9dc4c66c61eacf513945c426a13325e87893ccff0a73ccc151a0fca30'
MANIFEST_SHA = '625706ed07b9be7415f81d214272348d1f5757cb32833f14cf4272aecddb7e6d'
INDEX_SHA = 'de17dcd5e156970f16944104286e825952f4eaebd9f5de66203e873e8c5cc2d8'
COLLECTOR_SHA = '3032d0431737c349d732dc4b6a2cfc1bece7107ee1c3bb91de155c0d7f3f3eb6'
PROVENANCE = {'describe-processing-job.json', 's3-index.json', 'launch-intent.json',
              'submission-attempt.json', 'launch-response.json', 'job-describe-initial.json',
              'cloudwatch.json', 'collection-hashes.json', 'transfer-complete.json'}
PINS = {
    'scripts/collect-mechanism-campaign-v1.py': COLLECTOR_SHA,
    'aws/mechanism_campaign_control_v1.py': 'f91035e7c6fa019bb5225a2a462c8830e70e573548cbb59ea324501299b00b67',
    'aws/mechanism-campaign-bootstrap-v2/bootstrap.py': '45249c20ef1007ff29fdf700231ee44b19aed51ea9437dbd4f76cf175ed483a5',
}
RUNTIME = dict(python='3.12.13', numpy='1.26.4', scipy='1.16.3', node='v20.19.6', architecture='x86_64', cpus=48)


def need(ok, why):
    if not ok:
        raise ValueError(why)


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def strict_json(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            need(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    def constant(value):
        raise ValueError('Nonfinite JSON: ' + value)
    def floating(value):
        result = float(value)
        need(math.isfinite(result), 'Overflow/nonfinite JSON number')
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant, parse_float=floating)


def load(path):
    return strict_json(Path(path).read_bytes())


def same(a, b):
    # JSON canonicalisation keeps boolean/integer identity distinct.
    return json.dumps(a, sort_keys=True, allow_nan=False) == json.dumps(b, sort_keys=True, allow_nan=False)


def safe(name):
    need(type(name) is str and bool(name), 'Empty/nonstring path')
    p = PurePosixPath(name)
    need(str(p) == name and not p.is_absolute() and '..' not in p.parts and '\\' not in name
         and not any(ord(c) < 32 for c in name), 'Unsafe relative path')
    return name


def regular(tree, name):
    path = tree / safe(name)
    need(not any(p.is_symlink() for p in (path, *path.parents)) and path.is_file(), 'Nonregular body: ' + name)
    return path


def dependencies(root=ROOT):
    result = []
    for i, (name, digest) in enumerate(PINS.items()):
        path = regular(root, name)
        need(sha(path) == digest, 'Changed provenance verification source: ' + name)
        spec = importlib.util.spec_from_file_location('campaign_provenance_' + str(i), path)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        result.append(m)
    return tuple(result)


def sealed(bundle, admission, controller, bootstrap):
    bootstrap.validate_archive(bundle, BUNDLE_SHA, RELEASE_SHA)
    need(sha(admission) == ADMISSION_SHA, 'Actual downloaded wrapper admission changed')
    controller.admission(admission.read_bytes(), ADMISSION_SHA)
    with tarfile.open(bundle, 'r:gz') as archive:
        def body(name, digest):
            raw = archive.extractfile(name).read()
            need(hashlib.sha256(raw).hexdigest() == digest, 'Sealed routing/release changed')
            return strict_json(raw)
        document = body('metadata/prospective_manifest_portable_v1.json', MANIFEST_SHA)
        index = body('aws/mechanism-campaign-v1/audit-index.json', INDEX_SHA)
        release = body('metadata/campaign-release.json', RELEASE_SHA)
    cases = {r['id']: r for r in document['cases']}
    worlds = {r['key']: r for r in document['worlds']}
    need(len(cases) == len(document['cases']) == 2400 and len(worlds) == len(document['worlds']) == 128
         and set(index['historyIds']) == set(cases), 'Exact frozen full-campaign routing')
    return document, index, release, cases, worlds


def expected_members(payloads):
    return {'output/' + n for n in payloads | {'PAYLOAD_SHA256SUMS_V1'}} | {'provenance/' + n for n in PROVENANCE}


def tree_hashes(tree, wanted):
    need(tree.is_dir() and not any(p.is_symlink() for p in (tree, *tree.parents)), 'Nonsymlink downloaded tree required')
    dirs = {str(PurePosixPath(n).parent) for n in wanted}
    dirs |= {str(p) for n in wanted for p in PurePosixPath(n).parents if str(p) != '.'}
    actual = set()
    for path in tree.rglob('*'):
        name = safe(path.relative_to(tree).as_posix())
        need(not path.is_symlink(), 'Symlink in downloaded tree')
        if path.is_dir():
            need(name in dirs, 'Unexpected downloaded directory: ' + name)
        else:
            need(path.is_file(), 'Nonregular downloaded object')
            actual.add(name)
    need(actual == wanted, 'Missing, extra or substituted downloaded bodies')
    return {n: sha(regular(tree, n)) for n in sorted(wanted)}


def transport(tree, payloads, prefix, collector):
    wanted = expected_members(payloads)
    hashes = tree_hashes(tree, wanted)
    bound = load(tree / 'provenance/collection-hashes.json')['hashes']
    excluded = {'provenance/collection-hashes.json', 'provenance/transfer-complete.json'}
    need(set(bound) == wanted - excluded and all(hashes[n] == h for n, h in bound.items()), 'Full collection body hash coverage')
    ledger = {}
    for line in regular(tree, 'output/PAYLOAD_SHA256SUMS_V1').read_text().splitlines():
        h, name = line.split('  ', 1)
        safe(name)
        need(name not in ledger and re.fullmatch('[0-9a-f]{64}', h), 'Invalid/duplicate producer ledger row')
        ledger[name] = h
    need(set(ledger) == payloads and all(hashes['output/' + n] == h for n, h in ledger.items()), 'Exact full downloaded producer ledger')
    inventory = load(tree / 'provenance/s3-index.json')
    need(inventory['job'] == JOB and inventory['bucket'] == collector.BUCKET and inventory['prefix'] == prefix,
         'Actual private terminal inventory identity')
    rows = inventory['objects']
    names = payloads | {collector.LEDGER}
    need(len(rows) == len(names) and {r['relative'] for r in rows} == names, 'Exact terminal inventory membership')
    size = 0
    for r in rows:
        path = regular(tree, 'output/' + r['relative'])
        need(type(r['bytes']) is int and r['bytes'] == path.stat().st_size and type(r['etag']) is str and r['etag'],
             'Body length/ETag terminal binding')
        size += r['bytes']
    marker = load(tree / 'provenance/transfer-complete.json')
    need(marker['version'] == 'mechanism-campaign-transfer-v1' and marker['transportVerified'] is True
         and marker['kind'] == 'producer' and marker['job'] == JOB and type(marker['histories']) is int
         and marker['histories'] == 2400 and marker['outputObjects'] == 28808 and marker['outputBytes'] == size
         and marker['intentSha256'] == INTENT_SHA and marker['releaseSha256'] == RELEASE_SHA
         and marker['collectorSha256'] == COLLECTOR_SHA and marker['fullNumericalAuditPerformed'] is False
         and marker['scientificallyAccepted'] is False, 'Full collector scope/source/terminal binding')
    return hashes, size


def launch_chain(provenance, controller, collector):
    intent = provenance['launch-intent.json']
    key = controller.PREFIX + 'provenance/' + JOB + '/launch-intent.json'
    need(controller.validate_intent(intent, key) == JOB and intent['wrapperAdmissionSha256'] == ADMISSION_SHA
         and intent['controllerSha256'] == PINS['aws/mechanism_campaign_control_v1.py'], 'Exact admitted producer controller/intent')
    actual = provenance['describe-processing-job.json']
    prefix = collector.validate_launch(intent, actual, JOB, 'producer', RELEASE_SHA)
    need(same(intent['spec'], controller.spec_for(JOB, ADMISSION_SHA)), 'Exact source/resource/env spec')
    attempt = provenance['submission-attempt.json']
    need(attempt['job'] == JOB and attempt['intentSha256'] == INTENT_SHA and attempt['automaticRetryAllowed'] is False
         and provenance['launch-response.json']['ProcessingJobArn'] == actual['ProcessingJobArn']
         and collector.matches(intent['spec'], provenance['job-describe-initial.json']), 'Submit-once response/describe chain')
    start = datetime.fromisoformat(str(actual['ProcessingStartTime']).replace('Z', '+00:00'))
    end = datetime.fromisoformat(str(actual['ProcessingEndTime']).replace('Z', '+00:00'))
    need(start.tzinfo is not None and end.tzinfo is not None and end > start, 'Actual terminal timing required')
    return prefix


def runtime_and_completion(runtime, start, done, controller):
    need(same({k: runtime[k] for k in RUNTIME}, RUNTIME)
         and all(runtime['threadSettings'][k] == '1' for k in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'))
         and type(runtime['threadpoolInfo']) is list and bool(runtime['threadpoolInfo'])
         and all(type(p['num_threads']) is int and p['num_threads'] == 1 for p in runtime['threadpoolInfo']), 'Pinned actual x86/thread runtime')
    need(runtime['executionWrapper'] == dict(bootstrapSha256=controller.INPUTS['bootstrap.py'], bundleSha256=BUNDLE_SHA,
         releaseSha256=RELEASE_SHA, executionMode='campaign'), 'Executed mounted source wrapper')
    for row in (start, done):
        need(row['executionMode'] == 'campaign' and type(row['histories']) is int and row['histories'] == 2400
             and type(row['worlds']) is int and row['worlds'] == 128 and type(row['reservedWorldsExecuted']) is int
             and row['reservedWorldsExecuted'] == 128 and row['manifestSha256'] == MANIFEST_SHA
             and row['releaseSha256'] == RELEASE_SHA and row['scientificallyAccepted'] is False, 'Full campaign mode/scope/source')
    need(done['completed'] is True and done['allProducerFullAuditsPassed'] is True
         and done['refinementTripletsAudited'] is False and done['independentDownloadedAuditRequired'] is True,
         'Producer completion is not independent scientific acceptance')


def log_markers(logs, case_ids):
    need(re.fullmatch(re.escape(JOB) + r'/algo-1-[0-9]+', logs['logStream']), 'Actual single job log stream')
    messages = [r['message'] for r in logs['events']]
    markers = [m[len('CAMPAIGN_CASE_COMPLETED '):] for m in messages if m.startswith('CAMPAIGN_CASE_COMPLETED ')]
    need(len(markers) == len(set(markers)) == 2400 and set(markers) == set(case_ids)
         and messages.count('CAMPAIGN_NUMERICAL_COMPLETE_INDEPENDENT_AUDIT_REQUIRED') == 1,
         'Every worker and exactly one terminal marker required')
    need(not any(re.search(r'Traceback \(most recent call last\)|Segmentation fault|CAMPAIGN_FAILED|WRAPPER_DEVELOPMENT_COMPLETE', m)
                 for m in messages), 'Fatal/development log evidence')


def clean_process(row, sampled=False):
    need(type(row['exitCode']) is int and row['exitCode'] == 0 and row['timedOut'] is False,
         'Worker process did not finish cleanly')
    need(type(row['elapsedSeconds']) in (int, float) and math.isfinite(row['elapsedSeconds']) and row['elapsedSeconds'] > 0,
         'Worker elapsed time required')
    if sampled:
        need(row['cancelled'] is False and type(row['samples']) is int and row['samples'] > 0
             and type(row['sampledTreePeakRssBytes']) is int and row['sampledTreePeakRssBytes'] > 0
             and row['intervalSeconds'] == 1 and row['absolutePeakBound'] is False, 'Task resource samples/guard scope')


def commands(cid, task):
    command = task['command']
    need(type(command) is list and len(command) > 3 and command[:2] == ['/opt/conda/bin/python', '-B'], 'Actual task interpreter')
    root = str(PurePosixPath(command[2]).parents[2])
    need(re.fullmatch(r'/tmp/plumenav-campaign-[a-z0-9_]+/project', root), 'Owned extracted source location')
    manifest = root + '/metadata/prospective_manifest_portable_v1.json'
    release = root + '/metadata/campaign-release.json'
    worker = root + '/aws/mechanism-campaign-v1/worker_v4.mjs'
    run = '/opt/ml/processing/output/run'
    common = ['--science', root, '--manifest', manifest, '--release', release, '--release-sha256', RELEASE_SHA,
              '--worker', worker]
    wanted_task = ['/opt/conda/bin/python', '-B', root + '/aws/mechanism-campaign-v1/one.py'] + common + [
        '--run', run, '--case', cid, '--mode', 'campaign']
    need(command == wanted_task, 'Actual source/case/mode task command')
    return {
        'mission': ['node', worker, '--manifest', manifest, '--sha256', MANIFEST_SHA, '--mode', 'campaign',
                    '--release', release, '--release-sha256', RELEASE_SHA, '--case', cid, '--output', run + '/cases/' + cid],
        'audit': ['/opt/conda/bin/python', '-B', root + '/aws/mechanism-campaign-v1/audit.py'] + common + [
            '--mode', 'campaign', '--run', run, '--case', cid, '--audit-output', run + '/audits'],
    }


def case_bindings(cid, case, world, child, done, receipt, diagnostic, processes, task, body_hashes, history_bytes):
    clean_process(task, sampled=True)
    expected = commands(cid, task)
    for role in ('mission', 'audit'):
        clean_process(processes[role])
        need(processes[role]['command'] == expected[role], 'Mission/auditor source command binding')
    need(child['version'] == 'mechanism-worker-case-v4' and child['executionMode'] == 'campaign'
         and same(child['case'], case) and same(child['world'], world) and child['parentManifestSha256'] == MANIFEST_SHA,
         'Child prospective case/world/mode identity')
    need(done['completed'] is True and done['caseId'] == cid and same(done['case'], case)
         and done['parentManifestSha256'] == MANIFEST_SHA and done['developmentOnly'] is False
         and done['performanceCampaign'] is True and done['independentlyAudited'] is False
         and done['historySha256'] == body_hashes['history'] and type(done['bytes']) is int and done['bytes'] == history_bytes,
         'Saved full history identity/body/producer-only completion')
    need(done['replay']['passed'] is True and type(done['replay']['privateFieldQueries']) is int
         and done['replay']['privateFieldQueries'] == 0 and done['replay']['schedulingTraceMatched'] is True,
         'Source-blind replay evidence')
    need(receipt['passed'] is True and receipt['detailsPassed'] is True and receipt['caseId'] == cid
         and same(receipt['case'], case) and receipt['manifestSha256'] == MANIFEST_SHA
         and receipt['executionMode'] == 'campaign' and receipt['releaseSha256'] == RELEASE_SHA
         and receipt['historySha256'] == diagnostic['historySha256'] == body_hashes['history']
         and receipt['diagnosticsSha256'] == body_hashes['diagnostics']
         and receipt['arraysSha256'] == diagnostic['arraysSha256'] == body_hashes['arrays']
         and receipt['scientificallyAccepted'] is False and receipt['independentDownloadedAuditRequired'] is True
         and receipt['physicalValidation'] is False and diagnostic['details']['passed'] is True,
         'Producer full-audit derivative/body/source bindings')


def resource_profile(profile, resources):
    need(profile['workers'] == resources['workers'] and profile['histories'] == 2400
         and profile['monitorError'] is None and type(profile['samples']) is int and profile['samples'] > 0
         and 0 < profile['sampledPeakRssBytes'] <= resources['rssGuardBytes']
         and profile['minimumObservedFreeMemoryBytes'] >= resources['minimumFreeMemoryBytes']
         and profile['minimumObservedFreeDiskBytes'] >= resources['minimumFreeDiskBytes']
         and 0 < profile['elapsedSeconds'] <= resources['internalRuntimeSeconds']
         and profile['sampleIntervalSeconds'] == .5 and profile['absolutePeakBound'] is False,
         'Sampled aggregate resource/runtime guards')


def verify_download(tree, document, index, release, cases, worlds, collector, controller):
    provenance = {n: load(regular(tree, 'provenance/' + n)) for n in PROVENANCE}
    need(sha(regular(tree, 'provenance/launch-intent.json')) == INTENT_SHA, 'Actual immutable intent body changed')
    prefix = launch_chain(provenance, controller, collector)
    payloads = collector.expected_payloads(index, 'producer')
    hashes, size = transport(tree, payloads, prefix, collector)
    out = tree / 'output'
    runtime_and_completion(load(out / 'runtime.json'), load(out / 'start.json'), load(out / 'complete.json'), controller)
    need(same(load(out / 'release.json'), release) and same(load(out / 'audit-index.json'), index)
         and load(out / 'payload-index.json') == dict(version='mechanism-campaign-output-v1', payloads=sorted(payloads)),
         'Exact saved release/routing/payload contract')
    log_markers(provenance['cloudwatch.json'], cases)
    resource_profile(load(out / 'resource-profile.json'), release['resources'])
    rows = []
    for cid in index['historyIds']:
        def file(suffix):
            return regular(out, suffix)
        case = cases[cid]
        folder = 'run/cases/' + cid + '/'
        history = folder + 'mission.json.gz'
        receipt = 'run/audits/' + cid + '.json'
        diagnostic = 'run/audits/' + cid + '-diagnostics.json'
        arrays = 'run/audits/' + cid + '-arrays.npz'
        pins = {k: hashes['output/' + n] for k, n in dict(history=history, receipt=receipt, diagnostics=diagnostic, arrays=arrays).items()}
        case_bindings(cid, case, worlds[case['worldKey']], load(file(folder + 'manifest.json')), load(file(folder + 'complete.json')),
            load(file(receipt)), load(file(diagnostic)), {r: load(file('run/terminals/' + cid + '-' + r + '.json')) for r in ('mission', 'audit')},
            load(file('run/resources/' + cid + '.json')), pins, file(history).stat().st_size)
        rows.append(dict(caseId=cid, worldKey=case['worldKey'], arm=case['arm'], historyRelative=history,
                         historySha256=pins['history'], producerReceiptSha256=pins['receipt'],
                         producerDiagnosticsSha256=pins['diagnostics'], producerArraysSha256=pins['arrays']))
    need(hashes == tree_hashes(tree, expected_members(payloads)), 'Saved producer changed during provenance preflight')
    return dict(version='mechanism-campaign-producer-provenance-v1', producerProvenanceVerified=True,
        job=JOB, intentSha256=INTENT_SHA, bundleSha256=BUNDLE_SHA, releaseSha256=RELEASE_SHA,
        wrapperAdmissionSha256=ADMISSION_SHA, manifestSha256=MANIFEST_SHA, auditIndexSha256=INDEX_SHA,
        producerLedgerSha256=hashes['output/PAYLOAD_SHA256SUMS_V1'],
        collectionHashesSha256=hashes['provenance/collection-hashes.json'], outputObjects=28808, outputBytes=size,
        histories=2400, worlds=128, requiredResolutionTriplets=240, verifiedCases=rows,
        provenanceHashes={n: hashes['provenance/' + n] for n in sorted(PROVENANCE)},
        sourceScriptSha256=sha(Path(__file__)), dependencyHashes=PINS,
        independentFullAuditsExecuted=0, refinementTripletsAudited=0, newMissions=0, awsCalls=0,
        numericalAcceptance=False, scientificallyAccepted=False, physicalValidation=False,
        independentX86NumericalAndTerminalAuditStillRequired=True, verifiedAtUtc=datetime.now(timezone.utc).isoformat())


def main():
    parser = argparse.ArgumentParser()
    for name in ('download', 'bundle', 'wrapper-admission', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    a = parser.parse_args()
    collector, controller, bootstrap = dependencies()
    document, index, release, cases, worlds = sealed(a.bundle, a.wrapper_admission, controller, bootstrap)
    # Verify before writing a positive proof. Failure never alters input evidence.
    result = verify_download(a.download, document, index, release, cases, worlds, collector, controller)
    output = a.output.absolute()
    need(not output.exists() and output.parent.is_dir() and not any(p.is_symlink() for p in (output, *output.parents))
         and not output.resolve().is_relative_to(a.download.resolve()), 'Fresh separate provenance proof required')
    with output.open('x') as stream:
        json.dump(result, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write('\n')
    print('PRODUCER_PROVENANCE_VERIFIED_ALL_2400_NUMERICAL_AUDITS_STILL_REQUIRED ' + str(output), flush=True)


if __name__ == '__main__':
    main()
