"""Independent terminal acceptance of the downloaded all-history x86 audit.

Capacity-only v2 accepts the source-pinned auditor-only collector v2, with its
1 GiB payload cap and 1 GiB download reserve. Every scientific, membership,
launch, source/runtime, body, history, triplet and statistics gate is unchanged.
The v1 source and its capacity-rejected attempt remain preserved.

No AWS calls, missions or Mac numerical replay. Authenticate every downloaded
body and actual auditor/producer launch chain, bind all 2400 independently
re-executed full audits to the downloaded raw-body proof, inspect every retained
resolution triplet and independently reconstruct discrete primary contrasts.
Failure of any inherited triplet withholds primary inference; no cases are
dropped and all adverse results remain in the output. No hardware validation.
"""
import argparse
from array import array
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PINS = {
    'scripts/verify-mechanism-campaign-producer-v1.py': '9cbf88f4b037a4aa1a5712143488f62df3d798ffca18439b77f7110a6912cb64',
    'scripts/collect-mechanism-campaign-audit-backend-v2.py': '5a1e206215c7d5a1cfd3fa1bff268285311fa9c62460848d1fe2ea60993bb1e0',
    'scripts/lib/si_campaign_audit_backend_contract_v1.py': '3a6afbf4ac4e804448bdf7b0d65fcf56525a3524e20b704c2f5ae8e498518822',
    'aws/mechanism-campaign-audit-backend-v1/bootstrap.py': 'd6efccff3e2f00b2e9be570bf7337febc803c4355233e26590852f15211bc0ca',
    'scripts/lib/si_release_endpoint_v1.py': 'fe5f8dd86f1bb9ab78b793603ad9d6abce3b60312380f04ada386e5e939f9ecf',
    'scripts/lib/si_release_endpoint_v2.py': '614cbd7780faa657cb8ea9be64586278ccfb952afa9d619bb1fb90d3c0dc6df8',
}


def need(ok, why):
    if not ok: raise ValueError(why)


def sha(path):
    with Path(path).open('rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def dependencies():
    for name, digest in PINS.items():
        path = ROOT / name
        need(not any(p.is_symlink() for p in (path, *path.parents)) and sha(path) == digest, 'Changed terminal verifier dependency: ' + name)
    producer = module('terminal_producer_preflight', ROOT / 'scripts/verify-mechanism-campaign-producer-v1.py')
    nested = module('terminal_nested_collector', ROOT / 'scripts/collect-mechanism-campaign-audit-backend-v2.py')
    collector, contract = nested.dependencies()
    backend = module('terminal_audit_backend', ROOT / 'aws/mechanism-campaign-audit-backend-v1/bootstrap.py')
    from lib.si_release_endpoint_v2 import endpoint
    return producer, nested, collector, contract, backend, endpoint


def inspect_tar(path, wanted, safe):
    with tarfile.open(path, 'r:') as archive:
        rows = archive.getmembers(); names = [safe(r.name) for r in rows]
        need(len(names) == len(set(names)) and set(names) == wanted
             and all(r.isfile() and 0 <= r.size < 8 * 1024**3 for r in rows), 'Exact regular terminal TAR membership')
        total = sum(r.size for r in rows)
        need(total < 8 * 1024**3, 'Measured local terminal expansion cap')
        return total


def transport(tree, archive, archive_sha, payloads, producer, nested, contract):
    wanted = {'output/' + n for n in payloads | {'PAYLOAD_SHA256SUMS_V1'}} | {'provenance/' + n for n in contract.PROVENANCE}
    need(sha(archive) == archive_sha, 'Terminal transport archive SHA changed')
    inspect_tar(archive, wanted, producer.safe)
    hashes = producer.tree_hashes(tree, wanted)
    with tarfile.open(archive, 'r:') as tar:
        for row in tar.getmembers():
            file = producer.regular(tree, row.name)
            with tar.extractfile(row) as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            need(file.stat().st_size == row.size and hashes[row.name] == digest, 'Downloaded body differs from terminal TAR')
    pins = producer.load(tree / 'provenance/collection-hashes.json')['hashes']
    need(set(pins) == wanted - {'provenance/collection-hashes.json', 'provenance/transfer-complete.json'}
         and all(hashes[n] == h for n, h in pins.items()), 'Complete auditor collection-body hash coverage')
    nested.ledger(tree / 'output/PAYLOAD_SHA256SUMS_V1', payloads, hashes, 'output/', producer.safe)
    return hashes, wanted


def inventory(tree, job, prefix, payloads, hashes, producer, contract):
    value = producer.load(tree / 'provenance/s3-index.json'); rows = value['objects']
    names = payloads | {'PAYLOAD_SHA256SUMS_V1'}
    need(value['job'] == job and value['bucket'] == contract.BUCKET and value['prefix'] == prefix
         and len(rows) == len(names) and {r['relative'] for r in rows} == names, 'Exact auditor private terminal inventory')
    total = 0
    for row in rows:
        file = producer.regular(tree, 'output/' + row['relative'])
        need(type(row['bytes']) is int and row['bytes'] == file.stat().st_size and row['etag'], 'Auditor body length/ETag evidence')
        total += row['bytes']
    marker = producer.load(tree / 'provenance/transfer-complete.json')
    need(marker['version'] == 'mechanism-campaign-audit-backend-transfer-v1' and marker['transportVerified'] is True
         and marker['job'] == job and marker['producerJob'] == contract.PRODUCER_JOB and marker['histories'] == 2400
         and marker['outputObjects'] == 14428 and marker['outputBytes'] == total
         and marker['collectorSha256'] == PINS['scripts/collect-mechanism-campaign-audit-backend-v2.py']
         and marker['contractSha256'] == PINS['scripts/lib/si_campaign_audit_backend_contract_v1.py']
         and marker['independentlyScientificallyAccepted'] is False, 'Auditor transport scope/source binding')
    return total


def launch_chain(tree, job, intent_sha, controller_sha, producer, collector, contract):
    provenance = {n: producer.load(tree / 'provenance' / n) for n in contract.PROVENANCE}
    need(sha(tree / 'provenance/launch-intent.json') == intent_sha, 'Actual auditor immutable intent SHA')
    d = provenance['launch-intent.json']; actual = provenance['describe-processing-job.json']
    key = contract.PREFIX + 'provenance/' + job + '/launch-intent.json'
    prefix = contract.validate_actual(d, actual, job, key, controller_sha, collector.matches)
    attempt = provenance['submission-attempt.json']; marker = provenance['transfer-complete.json']
    need(attempt['job'] == job and attempt['intentSha256'] == intent_sha and attempt['automaticRetryAllowed'] is False
         and provenance['launch-response.json']['ProcessingJobArn'] == actual['ProcessingJobArn']
         and collector.matches(d['spec'], provenance['job-describe-initial.json'])
         and marker['intentSha256'] == intent_sha and marker['controllerSha256'] == controller_sha, 'Exact auditor submit-once launch chain')
    start = datetime.fromisoformat(str(actual['ProcessingStartTime']).replace('Z', '+00:00'))
    end = datetime.fromisoformat(str(actual['ProcessingEndTime']).replace('Z', '+00:00'))
    need(start.tzinfo is not None and end.tzinfo is not None and end > start, 'Auditor actual managed terminal timing')
    logs = provenance['cloudwatch.json']
    need(re.fullmatch(re.escape(job) + r'/algo-1-[0-9]+', logs['logStream']), 'Auditor exact single CloudWatch stream')
    messages = [r['message'] for r in logs['events']]
    for message in ('FULL_SAVED_CAMPAIGN_COLLECTION_STARTED_NO_NEW_MISSIONS', 'FULL_SAVED_CAMPAIGN_PRODUCER_PREFLIGHT_STARTED',
                    'ALL_2400_SAVED_HISTORY_X86_AUDITS_STARTED_NO_NEW_MISSIONS',
                    'FULL_SAVED_CAMPAIGN_AUDIT_COMPLETE_INDEPENDENT_TERMINAL_DOWNLOAD_REQUIRED'):
        need(messages.count(message) == 1, 'Actual collector/preflight/all-history audit terminal markers required')
    need(not any(re.search(r'Traceback \(most recent call last\)|Segmentation fault', m) for m in messages), 'Auditor fatal log evidence')
    return d, prefix


def producer_proof(out, intent, index, cases, release, producer, collector, controller, contract):
    proof = producer.load(out / 'producer-provenance.json')
    need(proof['version'] == 'mechanism-campaign-producer-provenance-v1' and proof['producerProvenanceVerified'] is True
         and proof['job'] == contract.PRODUCER_JOB and proof['intentSha256'] == contract.PRODUCER_INTENT_SHA
         and proof['bundleSha256'] == contract.INPUTS['campaign.tar.gz'] and proof['releaseSha256'] == contract.RELEASE_SHA
         and proof['wrapperAdmissionSha256'] == contract.INPUTS['wrapper-admission.json']
         and proof['manifestSha256'] == producer.MANIFEST_SHA and proof['auditIndexSha256'] == producer.INDEX_SHA
         and proof['producerLedgerSha256'] == intent['producerLedgerSha256'] and proof['histories'] == 2400
         and proof['worlds'] == 128 and proof['requiredResolutionTriplets'] == 240 and proof['outputObjects'] == 28808
         and proof['sourceScriptSha256'] == contract.VERIFIER_SHA and proof['dependencyHashes'] == producer.PINS
         and proof['independentFullAuditsExecuted'] == 0 and proof['refinementTripletsAudited'] == 0
         and proof['newMissions'] == 0 and proof['awsCalls'] == 0 and proof['numericalAcceptance'] is False
         and proof['scientificallyAccepted'] is False and proof['physicalValidation'] is False
         and proof['independentX86NumericalAndTerminalAuditStillRequired'] is True, 'Full saved producer proof scope/source/ledger chain')
    prov = out / 'producer-provenance'
    need(set(proof['provenanceHashes']) == contract.PROVENANCE
         and all(sha(producer.regular(prov, n)) == h for n, h in proof['provenanceHashes'].items())
         and sha(prov / 'launch-intent.json') == contract.PRODUCER_INTENT_SHA
         and sha(prov / 'collection-hashes.json') == proof['collectionHashesSha256'], 'Copied full producer provenance bodies')
    values = {n: producer.load(prov / n) for n in contract.PROVENANCE}
    prefix = producer.launch_chain(values, controller, collector)
    producer_payloads = collector.expected_payloads(index, 'producer')
    expected_hashes = {'output/' + n for n in producer_payloads | {collector.LEDGER}}
    expected_hashes |= {'provenance/' + n for n in contract.PROVENANCE - {'collection-hashes.json', 'transfer-complete.json'}}
    body_pins = values['collection-hashes.json']['hashes']
    need(set(body_pins) == expected_hashes and all(contract.valid_sha(h) for h in body_pins.values())
         and body_pins['output/' + collector.LEDGER] == intent['producerLedgerSha256']
         and all(body_pins['provenance/' + n] == sha(prov / n) for n in contract.PROVENANCE - {'collection-hashes.json', 'transfer-complete.json'}),
         'All original raw producer body pins and API provenance coverage')
    saved_index = values['s3-index.json']; rows = saved_index['objects']
    need(saved_index['job'] == contract.PRODUCER_JOB and saved_index['bucket'] == contract.BUCKET and saved_index['prefix'] == prefix
         and len(rows) == 28808 and {r['relative'] for r in rows} == producer_payloads | {collector.LEDGER}
         and all(type(r['bytes']) is int and r['bytes'] >= 0 and r['etag'] for r in rows)
         and sum(r['bytes'] for r in rows) == proof['outputBytes'], 'Full raw producer inventory/size source proof')
    marker = values['transfer-complete.json']
    need(marker['transportVerified'] is True and marker['outputObjects'] == 28808 and marker['outputBytes'] == proof['outputBytes']
         and marker['intentSha256'] == contract.PRODUCER_INTENT_SHA and marker['collectorSha256'] == producer.COLLECTOR_SHA
         and marker['fullNumericalAuditPerformed'] is False and marker['scientificallyAccepted'] is False, 'Actual full raw download marker')
    producer.log_markers(values['cloudwatch.json'], cases)
    verified = proof['verifiedCases']
    need(len(verified) == 2400 and [r['caseId'] for r in verified] == index['historyIds'], 'Every producer case, ordered without replacement')
    by_id = {}
    for row in verified:
        cid = row['caseId']; case = cases[cid]
        need(row['worldKey'] == case['worldKey'] and row['arm'] == case['arm']
             and row['historyRelative'] == 'run/cases/' + cid + '/mission.json.gz'
             and row['historySha256'] == body_pins['output/' + row['historyRelative']]
             and row['producerReceiptSha256'] == body_pins['output/run/audits/' + cid + '.json']
             and row['producerDiagnosticsSha256'] == body_pins['output/run/audits/' + cid + '-diagnostics.json']
             and row['producerArraysSha256'] == body_pins['output/run/audits/' + cid + '-arrays.npz'], 'Every raw history/producer derivative full-body binding')
        by_id[cid] = row
    return proof, by_id


def audit_process(cid, terminal, resource, producer):
    producer.clean_process(resource, sampled=True)
    need(type(terminal['exitCode']) is int and terminal['exitCode'] == 0 and terminal['timedOut'] is False
         and terminal['cancelled'] is False and terminal['command'] == resource['command'], 'Independent audit process/resource binding')
    command = terminal['command']
    need(type(command) is list and command[:2] == ['/opt/conda/bin/python', '-B'] and len(command) == 19, 'Independent audit command contract')
    need(type(command[2]) is str and len(Path(command[2]).parents) >= 3, 'Canonical independent audit source path')
    science = str(Path(command[2]).parents[2]); prefix = str(Path(science).parent)
    need(re.fullmatch(r'/opt/ml/processing/audit-work/plumenav-saved-audit-[a-z0-9_]+', prefix)
         and science == prefix + '/science', 'Owned private audit work/source location')
    expected = ['/opt/conda/bin/python', '-B', science + '/aws/mechanism-campaign-v1/audit.py',
        '--science', science, '--manifest', science + '/metadata/prospective_manifest_portable_v1.json',
        '--release', science + '/metadata/campaign-release.json', '--release-sha256', producer.RELEASE_SHA,
        '--worker', science + '/aws/mechanism-campaign-v1/worker_v4.mjs', '--run', prefix + '/producer/output/run',
        '--case', cid, '--audit-output', '/opt/ml/processing/output/independent/audits']
    need(command == expected, 'Actual unchanged full-history audit command/source/case')


def audit_case(out, cid, case, proof, bindings, producer, endpoint):
    independent = out / 'independent'; prefix = 'audits/' + cid
    receipt_file = producer.regular(independent, prefix + '.json')
    diagnostic_file = producer.regular(independent, prefix + '-diagnostics.json')
    array_file = producer.regular(independent, prefix + '-arrays.npz')
    receipt = producer.load(receipt_file); diagnostic = producer.load(diagnostic_file)
    need(receipt['passed'] is True and receipt['detailsPassed'] is True and receipt['caseId'] == cid
         and producer.same(receipt['case'], case) and receipt['executionMode'] == 'campaign'
         and receipt['manifestSha256'] == producer.MANIFEST_SHA and receipt['releaseSha256'] == producer.RELEASE_SHA
         and receipt['historySha256'] == diagnostic['historySha256'] == proof['historySha256']
         and receipt['diagnosticsSha256'] == sha(diagnostic_file) == proof['producerDiagnosticsSha256']
         and receipt['arraysSha256'] == diagnostic['arraysSha256'] == sha(array_file) == proof['producerArraysSha256']
         and receipt['scientificallyAccepted'] is False and receipt['physicalValidation'] is False
         and receipt['independentDownloadedAuditRequired'] is True and diagnostic['details']['passed'] is True,
         'All independently re-executed full diagnostics/arrays exactly bind to raw producer bodies')
    need(producer.same(bindings, dict(historySha256=proof['historySha256'],
         producer=dict(receiptSha256=proof['producerReceiptSha256'], diagnosticsSha256=proof['producerDiagnosticsSha256'], arraysSha256=proof['producerArraysSha256']),
         independent=dict(receiptSha256=sha(receipt_file), diagnosticsSha256=sha(diagnostic_file), arraysSha256=sha(array_file)))),
         'All-case assembly binding index/body correspondence')
    need(diagnostic['compact']['spec'] == case['spec'] and diagnostic['extracted']['metadata']['field'] == case['spec']['field'],
         'Independent compact metadata case identity')
    state = endpoint(diagnostic['extracted']['metadata'])
    need(producer.same(state, diagnostic['extracted']['endpoint']), 'Independent discrete endpoint reconstruction')
    terminal = producer.load(producer.regular(independent, 'terminals/' + cid + '.json'))
    resource = producer.load(producer.regular(independent, 'resources/' + cid + '.json'))
    audit_process(cid, terminal, resource, producer)
    return state


def assembly_gate(result, index):
    need(result['version'] == 'mechanism-campaign-assembly-v1' and result['histories'] == 2400 and result['worlds'] == 128
         and result['primaryHistories'] == 1920 and result['refinementHistories'] == 480
         and type(result['componentPassed']) is bool and len(result['triplets']) == 240, 'Complete frozen analysis assembly')
    failed = []
    for route, value in zip(index['resolutionTriplets'], result['triplets']):
        need(all(value[k] == route[k] for k in ('worldKey', 'arm', 'field', 'caseIds'))
             and type(value['numerical']['passed']) is bool and type(value['endpointGate']['passed']) is bool,
             'Every fixed resolution triplet without omission/replacement')
        if not (value['numerical']['passed'] and value['endpointGate']['passed']): failed.append(value['caseIds'])
    need(result['failedTriplets'] == failed and result['componentPassed'] is (not failed), 'Exact retained adverse resolution map')
    need((result['statistics'] is None) is bool(failed), 'Do not calculate inferential statistics after failed refinement')
    scope = result['scope']
    for key in ('scientificallyAccepted', 'terminalProvenanceVerified', 'independentFullAuditExecutionVerified', 'physicalValidation',
                'hardwareValidation', 'urbanValidation', 'aerodynamicSniffing', 'automaticWinnerSelection', 'validatedAbsenceOfLeak'):
        need(scope[key] is False, 'Derived component falsely grants validation/acceptance')
    return failed


def discrete_statistics(stats, index, states):
    keys = [r['worldKey'] for r in index['worldBlocks']]
    need(stats['version'] == 'paired-availability-statistics-v2' and stats['independentWorlds'] == 128
         and stats['worldOrder'] == keys, 'Exact paired independent-world statistical population')
    vectors = []
    for block in index['worldBlocks']:
        vector = []
        for field in ('si-continuous', 'si-pulse'):
            y = {arm: int(states[cid]['success']) for arm, cid in block['primary'][field].items()}
            vector += [(y['GL'] - y['RL']) - (y['GW'] - y['RW']), y['GL'] - y['NS']]
        vectors.append(vector)
    need(len(stats['primary']) == 4, 'Complete prospectively fixed primary family')
    contrasts = ('continuous:I', 'continuous:D', 'pulsed:I', 'pulsed:D')
    for j, row in enumerate(stats['primary']):
        values = [r[j] for r in vectors]
        need(row['contrast'] == contrasts[j] and row['worldContrasts'] == values and row['mean'] == sum(values) / 128,
             'Independent exact integer paired contrast reconstruction')
    bootstrap = stats['bootstrap']; draws = bootstrap['drawIndices']; means = bootstrap['contrastSampleMeans']
    need(bootstrap['method'] == 'PCG64-whole-world' and bootstrap['seed'] == 711397807 and bootstrap['drawCount'] == 10000
         and bootstrap['quantileMethod'] == 'linear' and bootstrap['indexEncoding'] == 'row-major little-endian uint32'
         and bootstrap['numpyVersion'] == '1.26.4' and len(draws) == len(means) == 10000, 'Frozen x86 resampling provenance/all draws')
    h = hashlib.sha256()
    for draw, values in zip(draws, means):
        need(len(draw) == 128 and all(type(i) is int and 0 <= i < 128 for i in draw)
             and len(values) == 4, 'Every complete world-block bootstrap draw')
        data = array('I', draw)
        need(data.itemsize == 4, '32-bit transport encoding required')
        if sys.byteorder != 'little': data.byteswap()
        h.update(data.tobytes())
        need(values == [sum(vectors[i][j] for i in draw) / 128 for j in range(4)], 'Every exact paired bootstrap mean')
    need(h.hexdigest() == bootstrap['indexSha256'], 'All prospective draw index bytes checksum')
    need(len(stats['arms']) == 15 and len({(r['field'], r['arm']) for r in stats['arms']}) == 15, 'Every arm/field summary required')
    for row in stats['arms']:
        field, arm = row['field'], row['arm']
        selected = [states[b['primary'][field][arm]] for b in index['worldBlocks']]
        categories = {}
        for state in selected: categories[state['category']] = categories.get(state['category'], 0) + 1
        if field == 'blank':
            for category in ('blank-no-nomination', 'blank-inspection-incomplete', 'blank-verifier-abstained', 'blank-supported-report'):
                categories.setdefault(category, 0)
        need(row['n'] == 128 and row['categories'] == categories, 'All unresolved/adverse category counts retained')
        if field == 'blank':
            need(row['localisationApplicable'] is False and row['successes'] is None and row['proportion'] is None,
                 'No blank localisation-success endpoint')
            for control in ('falseNomination', 'inspectionCompleted', 'falseReport'):
                count = sum(s['blankControls'][control] for s in selected)
                need(row['blankControls'][control] == dict(count=count, denominator=128, proportion=count/128), 'Every blank false-action count')
        else:
            count = sum(s['success'] for s in selected)
            need(row['localisationApplicable'] is True and row['successes'] == count and row['proportion'] == count/128,
                 'All emitting successes/unresolved denominator binding')


def verify_tree(tree, archive, archive_sha, job, intent_sha, controller_sha, bundle, admission):
    producer, nested, collector, contract, backend, endpoint = dependencies()
    _, source_controller, source_bootstrap = producer.dependencies()
    document, index, release, cases, worlds = producer.sealed(bundle, admission, source_controller, source_bootstrap)
    payloads = contract.expected_payloads(index, collector)
    hashes, wanted = transport(tree, archive, archive_sha, payloads, producer, nested, contract)
    intent, prefix = launch_chain(tree, job, intent_sha, controller_sha, producer, collector, contract)
    output_bytes = inventory(tree, job, prefix, payloads, hashes, producer, contract)
    out = tree / 'output'; independent = out / 'independent'
    nested.ledger(independent / collector.LEDGER, collector.expected_payloads(index, 'independent-audit'), hashes, 'output/independent/', producer.safe)
    need(producer.load(out / 'payload-index.json') == dict(version='mechanism-campaign-audit-backend-output-v1', payloads=sorted(payloads)), 'Actual exact backend payload index')
    backend.validate_plan(producer.load(out / 'plan.json'))
    gate_value = producer.load(out / 'producer-terminal-gate.json')
    need(backend.gate(gate_value) == intent['producerLedgerSha256']
         and sha(out / 'producer-terminal-gate.json') == intent['producerTerminalGateSha256'], 'Actual observed producer terminal gate')
    sources = producer.load(out / 'source-pins.json')
    package_zip = ROOT / 'aws/build/PlumeNav_mechanism_campaign_saved_audit_20260930_v1_attempt01.zip'
    need(sha(package_zip) == contract.PACKAGE_SHA, 'Actual frozen audit source transport package')
    with zipfile.ZipFile(package_zip) as archive: package = producer.strict_json(archive.read('PACKAGE.json'))
    need(package['inputHashes'] == contract.INPUTS, 'Frozen audit source package input pins')
    need(sources == dict(overlaySha256=contract.INPUTS['overlay.tar.gz'], overlayBodyHashes=package['overlayBodyHashes'],
         bootstrapSha256=contract.INPUTS['bootstrap.py'], bundleSha256=contract.INPUTS['campaign.tar.gz'],
         wrapperAdmissionSha256=contract.INPUTS['wrapper-admission.json'], terminalGateSha256=intent['producerTerminalGateSha256']), 'Actual audit overlay/science/source proof')
    for directory in (out, independent):
        rt = producer.load(directory / 'runtime.json')
        need(producer.same({k: rt[k] for k in producer.RUNTIME}, producer.RUNTIME)
             and all(rt['threadSettings'][k] == '1' for k in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'))
             and bool(rt['threadpoolInfo']) and all(p['num_threads'] == 1 for p in rt['threadpoolInfo']), 'Pinned actual auditor x86/thread runtime')
    start = producer.load(out / 'start.json'); saved_start = producer.load(independent / 'start.json')
    need(start['producerJob'] == contract.PRODUCER_JOB and start['producerIntentSha256'] == contract.PRODUCER_INTENT_SHA
         and start['producerLedgerSha256'] == saved_start['producerLedgerSha256'] == intent['producerLedgerSha256']
         and start['producerTerminalGateSha256'] == intent['producerTerminalGateSha256']
         and start['bundleSha256'] == contract.INPUTS['campaign.tar.gz'] and start['releaseSha256'] == saved_start['releaseSha256'] == contract.RELEASE_SHA
         and start['overlaySha256'] == contract.INPUTS['overlay.tar.gz'] and start['bootstrapSha256'] == contract.INPUTS['bootstrap.py']
         and start['driverSha256'] == saved_start['sourceScriptSha256'] == contract.DRIVER_SHA
         and start['producerVerifierSha256'] == contract.VERIFIER_SHA and saved_start['manifestSha256'] == producer.MANIFEST_SHA
         and start['histories'] == saved_start['histories'] == 2400 and start['worlds'] == 128 and start['resolutionTriplets'] == 240
         and start['newMissions'] == saved_start['newMissions'] == 0
         and start['scientificallyAccepted'] is False and saved_start['scientificallyAccepted'] is False
         and saved_start['terminalProvenanceVerified'] is False, 'Actual backend/unchanged driver execution-source-start chain')
    proof, by_id = producer_proof(out, intent, index, cases, release, producer, collector, source_controller, contract)
    case_index = producer.load(independent / 'case-index.json')
    need(case_index['version'] == 'mechanism-campaign-independent-case-index-v1' and case_index['histories'] == 2400
         and set(case_index['cases']) == set(cases), 'All independently executed case bindings required')
    states = {cid: audit_case(out, cid, cases[cid], by_id[cid], case_index['cases'][cid], producer, endpoint) for cid in index['historyIds']}
    log = producer.regular(out, 'logs/independent-audit-driver.log').read_text()
    markers = [line[len('CAMPAIGN_CASE_COMPLETED '):] for line in log.splitlines() if line.startswith('CAMPAIGN_CASE_COMPLETED ')]
    need(len(markers) == len(set(markers)) == 2400 and set(markers) == set(cases)
         and log.splitlines().count('CAMPAIGN_INDEPENDENT_AUDITS_COMPLETE_TERMINAL_PROVENANCE_STILL_REQUIRED') == 1
         and 'Traceback (most recent call last)' not in log, 'Actual re-execution of every full-history independent audit')
    collection_log = (out / 'logs/collection.log').read_text().splitlines()
    need([line for line in collection_log if line.startswith('COLLECTED_OBJECTS ')] == ['COLLECTED_OBJECTS ' + str(i) for i in range(200, 28801, 200)]
         and sum(line.startswith('FULL_CAMPAIGN_TRANSFER_VERIFIED_NUMERICAL_AUDIT_STILL_REQUIRED ') for line in collection_log) == 1,
         'Actual full raw download progress/terminal execution')
    preflight_log = (out / 'logs/producer-preflight.log').read_text().splitlines()
    need(preflight_log == ['PRODUCER_PROVENANCE_VERIFIED_ALL_2400_NUMERICAL_AUDITS_STILL_REQUIRED /opt/ml/processing/output/producer-provenance.json'], 'Actual trusted full producer preflight execution')
    result = producer.load(independent / 'assembly.json'); failed = assembly_gate(result, index)
    if not failed: discrete_statistics(result['statistics'], index, states)
    done = producer.load(independent / 'complete.json'); outer = producer.load(out / 'complete.json')
    for value in (done, outer):
        need(value['completed'] is True and value['independentFullAuditsExecuted'] == 2400 and value['refinementTripletsAudited'] == 240
             and value['componentPassed'] is (not failed) and value['failedTriplets'] == failed and value['newMissions'] == 0
             and value['producerLedgerSha256'] == intent['producerLedgerSha256']
             and value['terminalProvenanceVerified'] is False and value['scientificallyAccepted'] is False, 'Actual all-history/triplet terminal coverage; retain all adverse results')
    need(done['manifestSha256'] == producer.MANIFEST_SHA and done['releaseSha256'] == contract.RELEASE_SHA and done['awsCalls'] == 0
         and outer['producerProvenanceSha256'] == sha(out / 'producer-provenance.json') and outer['driverSha256'] == contract.DRIVER_SHA
         and outer['independentLedgerSha256'] == sha(independent / collector.LEDGER) and 0 < outer['elapsedSeconds'] <= 85000,
         'Final numerical/producer-proof/outer resource-source chain')
    producer.resource_profile(producer.load(independent / 'resource-profile.json'), release['resources'])
    need(hashes == producer.tree_hashes(tree, wanted), 'Downloaded auditor evidence changed during independent terminal acceptance')
    return dict(version='mechanism-campaign-independent-terminal-acceptance-v1', terminalProvenanceAccepted=True,
        independentAllHistoryExecutionAccepted=True, primaryInferentialClaimsAdmitted=not failed, scientificallyAccepted=not failed,
        auditorJob=job, auditorIntentSha256=intent_sha, auditorControllerSha256=controller_sha,
        producerJob=contract.PRODUCER_JOB, producerIntentSha256=contract.PRODUCER_INTENT_SHA,
        producerLedgerSha256=intent['producerLedgerSha256'], producerCollectionHashesSha256=proof['collectionHashesSha256'],
        producerProvenanceSha256=sha(out / 'producer-provenance.json'), archiveSha256=archive_sha,
        independentLedgerSha256=sha(independent / collector.LEDGER), terminalLedgerSha256=sha(out / collector.LEDGER),
        assemblySha256=sha(independent / 'assembly.json'), manifestSha256=producer.MANIFEST_SHA,
        releaseSha256=contract.RELEASE_SHA, histories=2400, worlds=128, resolutionTriplets=240,
        outputObjects=14428, outputBytes=output_bytes, failedTriplets=failed, adverseResultsPreserved=True,
        exactDiscreteStatisticsReconstructionPassed=not failed, marginalIntervalsBoundToUnchangedX86Execution=True,
        sourceScriptSha256=sha(Path(__file__)), dependencyHashes=PINS, newMissions=0, awsCalls=0,
        physicalValidation=False, hardwareValidation=False, urbanValidation=False, aerodynamicSniffing=False,
        universalWinnerClaim=False, validatedAbsenceOfRealLeak=False, acceptedAtUtc=datetime.now(timezone.utc).isoformat())


def main():
    p = argparse.ArgumentParser()
    for name in ('archive', 'bundle', 'wrapper-admission', 'destination'):
        p.add_argument('--' + name, type=Path, required=True)
    for name in ('archive-sha256', 'job', 'intent-sha256', 'controller-sha256'):
        p.add_argument('--' + name, required=True)
    a = p.parse_args(); producer, nested, collector, contract, backend, endpoint = dependencies()
    for digest in (a.archive_sha256, a.intent_sha256, a.controller_sha256): need(contract.valid_sha(digest), 'Observed immutable terminal pins required')
    _, controller, bootstrap = producer.dependencies()
    _, index, _, _, _ = producer.sealed(a.bundle, a.wrapper_admission, controller, bootstrap)
    payloads = contract.expected_payloads(index, collector)
    wanted = {'output/' + n for n in payloads | {collector.LEDGER}} | {'provenance/' + n for n in contract.PROVENANCE}
    total = inspect_tar(a.archive, wanted, producer.safe)
    need(sha(a.archive) == a.archive_sha256, 'Original downloaded audit TAR SHA')
    out = a.destination.absolute()
    need(not out.exists() and out.parent.is_dir() and out.resolve().is_relative_to(ROOT)
         and not any(path.is_symlink() for path in (out, *out.parents))
         and shutil.disk_usage(out.parent).free >= total + 1024**3, 'Fresh adequate separate workspace terminal acceptance destination')
    out.mkdir(); tree = out / 'download'; tree.mkdir()
    try:
        with tarfile.open(a.archive, 'r:') as archive: archive.extractall(tree, filter='data')
        result = verify_tree(tree, a.archive, a.archive_sha256, a.job, a.intent_sha256, a.controller_sha256, a.bundle, a.wrapper_admission)
        with (out / 'terminal-acceptance.json').open('x') as stream: json.dump(result, stream, indent=2, sort_keys=True, allow_nan=False); stream.write('\n')
        print(json.dumps(result, indent=2, allow_nan=False))
    except BaseException as error:
        with (out / 'terminal-rejection.json').open('x') as stream:
            json.dump(dict(accepted=False, error=type(error).__name__ + ': ' + str(error), adverseEvidencePreserved=True,
                newMissions=0, awsCalls=0, scientificallyAccepted=False), stream, indent=2, allow_nan=False)
            stream.write('\n')
        raise


if __name__ == '__main__': main()
