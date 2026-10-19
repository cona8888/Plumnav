"""Zero-mission contract fixtures; never attest live campaign acceptance."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('producer_provenance', ROOT / 'scripts/verify-mechanism-campaign-producer-v1.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.collector, cls.controller, cls.bootstrap = v.dependencies()
        cls.bundle = ROOT / 'aws/build/si-mechanism-campaign-sealed-v3-attempt01-20260930/input/campaign.tar.gz'
        cls.admission = ROOT / 'research/results/si_mechanism_wrapper_witness_v1_terminal_acceptance_attempt01_2026-09-30/wrapper-admission.json'
        cls.document, cls.index, cls.release, cls.cases, cls.worlds = v.sealed(
            cls.bundle, cls.admission, cls.controller, cls.bootstrap)

    def intent(self):
        c = self.controller
        return dict(version='mechanism-campaign-launch-intent-v1', kind='producer', account=c.ACCOUNT, region=c.REGION,
            approvalReference=c.APPROVAL, authorApprovedAdditionalBudgetUSD=200, campaignPlanningAllocationUSD=70,
            auditPlanningAllocationUSD=70, otherUsageAndReserveUSD=60, submitted=False, automaticRetryAllowed=False,
            scientificallyAccepted=False, histories=2400, worlds=128, resolutionTriplets=240,
            inputHashes=dict(c.INPUTS, **{'wrapper-admission.json': v.ADMISSION_SHA}),
            bundleSha256=c.BUNDLE_SHA, releaseSha256=c.RELEASE_SHA, bootstrapSha256=c.INPUTS['bootstrap.py'],
            entrypointSha256=c.INPUTS['entrypoint.sh'], manifestSha256=c.MANIFEST_SHA, auditIndexSha256=c.INDEX_SHA,
            resourceVerificationSha256=c.RESOURCE_SHA, resourceTerminalSha256=c.TERMINAL_SHA,
            witnessJob=c.WITNESS_JOB, witnessIntentSha256=c.WITNESS_INTENT_SHA, wrapperAdmissionSha256=v.ADMISSION_SHA,
            controllerSha256=v.PINS['aws/mechanism_campaign_control_v1.py'], spec=c.spec_for(v.JOB, v.ADMISSION_SHA))

    def provenance(self):
        d = self.intent()
        actual = dict(copy.deepcopy(d['spec']), ProcessingJobStatus='Completed', ProcessingStartTime='2026-10-01T01:00:00+00:00',
                      ProcessingEndTime='2026-10-01T10:00:00+00:00',
                      ProcessingJobArn='arn:aws:sagemaker:us-east-1:380061838272:processing-job/' + v.JOB)
        return {'launch-intent.json': d, 'describe-processing-job.json': actual,
                'submission-attempt.json': dict(job=v.JOB, intentSha256=v.INTENT_SHA, automaticRetryAllowed=False),
                'launch-response.json': dict(ProcessingJobArn=actual['ProcessingJobArn']),
                'job-describe-initial.json': copy.deepcopy(actual)}

    def runtime(self):
        return dict(v.RUNTIME, threadSettings={k: '1' for k in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS')},
            threadpoolInfo=[dict(num_threads=1)], executionWrapper=dict(bootstrapSha256=self.controller.INPUTS['bootstrap.py'],
            bundleSha256=v.BUNDLE_SHA, releaseSha256=v.RELEASE_SHA, executionMode='campaign'))

    def start_done(self):
        start = dict(executionMode='campaign', histories=2400, worlds=128, reservedWorldsExecuted=128,
                     manifestSha256=v.MANIFEST_SHA, releaseSha256=v.RELEASE_SHA, scientificallyAccepted=False)
        return start, dict(start, completed=True, allProducerFullAuditsPassed=True, refinementTripletsAudited=False,
                           independentDownloadedAuditRequired=True)

    def case_fixture(self, cid=None):
        cid = cid or self.index['historyIds'][0]
        case = self.cases[cid]; world = self.worlds[case['worldKey']]
        root = '/tmp/plumenav-campaign-fixture123/project'; run = '/opt/ml/processing/output/run'
        common = ['--science', root, '--manifest', root + '/metadata/prospective_manifest_portable_v1.json',
            '--release', root + '/metadata/campaign-release.json', '--release-sha256', v.RELEASE_SHA,
            '--worker', root + '/aws/mechanism-campaign-v1/worker_v4.mjs']
        task = dict(command=['/opt/conda/bin/python', '-B', root + '/aws/mechanism-campaign-v1/one.py'] + common + [
            '--run', run, '--case', cid, '--mode', 'campaign'], exitCode=0, timedOut=False, cancelled=False,
            elapsedSeconds=200.0, samples=201, sampledTreePeakRssBytes=1000000000, intervalSeconds=1, absolutePeakBound=False)
        commands = v.commands(cid, task)
        processes = {r: dict(command=commands[r], exitCode=0, timedOut=False, elapsedSeconds=100.) for r in commands}
        child = dict(version='mechanism-worker-case-v4', executionMode='campaign', case=copy.deepcopy(case), world=copy.deepcopy(world),
                     parentManifestSha256=v.MANIFEST_SHA)
        hashes = dict(history='a'*64, receipt='b'*64, diagnostics='c'*64, arrays='d'*64)
        done = dict(completed=True, caseId=cid, case=copy.deepcopy(case), parentManifestSha256=v.MANIFEST_SHA,
            developmentOnly=False, performanceCampaign=True, independentlyAudited=False, historySha256=hashes['history'], bytes=1234,
            replay=dict(passed=True, privateFieldQueries=0, schedulingTraceMatched=True))
        receipt = dict(passed=True, detailsPassed=True, caseId=cid, case=copy.deepcopy(case), manifestSha256=v.MANIFEST_SHA,
            executionMode='campaign', releaseSha256=v.RELEASE_SHA, historySha256=hashes['history'], diagnosticsSha256=hashes['diagnostics'],
            arraysSha256=hashes['arrays'], scientificallyAccepted=False, independentDownloadedAuditRequired=True, physicalValidation=False)
        diagnostic = dict(historySha256=hashes['history'], arraysSha256=hashes['arrays'], details=dict(passed=True))
        return [cid, case, world, child, done, receipt, diagnostic, processes, task, hashes, 1234]

    def test_real_sealed_source_zero_mission(self):
        self.assertEqual(len(self.cases), 2400)
        self.assertEqual(len(self.worlds), 128)
        self.assertEqual(len(self.index['resolutionTriplets']), 240)
        self.assertEqual(v.sha(self.bundle), v.BUNDLE_SHA)
        self.assertEqual(v.sha(self.admission), v.ADMISSION_SHA)

    def test_complete_payload_contract(self):
        payloads = self.collector.expected_payloads(self.index, 'producer')
        wanted = v.expected_members(payloads)
        self.assertEqual(len(payloads), 28807)
        self.assertEqual(len(wanted), 28817)
        for cid in self.cases:
            self.assertIn('output/run/cases/' + cid + '/mission.json.gz', wanted)

    def test_clean_launch_fixture(self):
        self.assertEqual(v.launch_chain(self.provenance(), self.controller, self.collector),
                         self.controller.PREFIX + 'jobs/' + v.JOB + '/output/')

    def test_reject_nonterminal_and_failure(self):
        for key, value in [('ProcessingJobStatus', 'InProgress'), ('FailureReason', 'failure'),
                           ('ProcessingStartTime', None), ('ProcessingEndTime', None)]:
            p = self.provenance(); p['describe-processing-job.json'][key] = value
            with self.subTest(key=key), self.assertRaises((ValueError, TypeError)):
                v.launch_chain(p, self.controller, self.collector)

    def test_reject_actual_resource_and_source_changes(self):
        for mutate in (lambda p: p['ProcessingResources']['ClusterConfig'].update(VolumeSizeInGB=100),
                       lambda p: p['AppSpecification'].update(ImageUri='untrusted'),
                       lambda p: p['Environment'].update(OMP_NUM_THREADS='2'),
                       lambda p: p['Environment'].update(MECHANISM_DEVELOPMENT_APPROVED='YES')):
            p = self.provenance(); mutate(p['describe-processing-job.json'])
            with self.assertRaises(ValueError): v.launch_chain(p, self.controller, self.collector)

    def test_reject_submission_or_admission_substitution(self):
        for mutate in (lambda p: p['submission-attempt.json'].update(intentSha256='0'*64),
                       lambda p: p['submission-attempt.json'].update(automaticRetryAllowed=True),
                       lambda p: p['launch-intent.json'].update(wrapperAdmissionSha256='0'*64),
                       lambda p: p['launch-response.json'].update(ProcessingJobArn='different'),
                       lambda p: p['launch-intent.json'].update(controllerSha256='0'*64)):
            p = self.provenance(); mutate(p)
            with self.assertRaises(ValueError): v.launch_chain(p, self.controller, self.collector)

    def test_reject_reversed_or_naive_aws_times(self):
        for end in ['2026-09-30T01:00:00+00:00', '2026-10-01T10:00:00']:
            p = self.provenance(); p['describe-processing-job.json']['ProcessingEndTime'] = end
            with self.assertRaises(ValueError): v.launch_chain(p, self.controller, self.collector)

    def test_actual_runtime_scope_contract(self):
        start, done = self.start_done()
        v.runtime_and_completion(self.runtime(), start, done, self.controller)

    def test_reject_runtime_variants(self):
        for mutate in (lambda r: r.update(architecture='arm64'), lambda r: r.update(numpy='2.3.4'),
                       lambda r: r.update(cpus=True), lambda r: r.update(threadpoolInfo=[]),
                       lambda r: r['threadpoolInfo'][0].update(num_threads=2),
                       lambda r: r['executionWrapper'].update(executionMode='development')):
            rt = self.runtime(); mutate(rt)
            with self.assertRaises(ValueError): v.runtime_and_completion(rt, *self.start_done(), self.controller)

    def test_reject_partial_or_inflated_scope(self):
        for key, value in [('histories', 2399), ('worlds', 64), ('reservedWorldsExecuted', True),
                           ('refinementTripletsAudited', True), ('scientificallyAccepted', True),
                           ('independentDownloadedAuditRequired', False), ('completed', False)]:
            start, done = self.start_done(); done[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                v.runtime_and_completion(self.runtime(), start, done, self.controller)

    def test_all_2400_case_metadata_fixture_bindings(self):
        for cid in self.index['historyIds']:
            v.case_bindings(*self.case_fixture(cid))

    def test_reject_case_world_manifest_and_body_swaps(self):
        for number, key, value in [(3, 'world', {}), (3, 'parentManifestSha256', '0'*64), (3, 'executionMode', 'development'),
                                  (4, 'caseId', 'wrong'), (4, 'historySha256', '0'*64), (4, 'bytes', 0),
                                  (5, 'diagnosticsSha256', '0'*64), (5, 'arraysSha256', '0'*64),
                                  (6, 'historySha256', '0'*64)]:
            f = self.case_fixture(); f[number][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): v.case_bindings(*f)

    def test_reject_private_field_queries_or_invalid_scope(self):
        for mutate in (lambda d: d['replay'].update(privateFieldQueries=1),
                       lambda d: d['replay'].update(privateFieldQueries=False),
                       lambda d: d['replay'].update(schedulingTraceMatched=False),
                       lambda d: d.update(developmentOnly=True), lambda d: d.update(independentlyAudited=True)):
            f = self.case_fixture(); mutate(f[4])
            with self.assertRaises(ValueError): v.case_bindings(*f)

    def test_reject_process_and_resource_failures(self):
        for key, value in [('exitCode', True), ('exitCode', 1), ('timedOut', True), ('cancelled', True),
                           ('samples', 0), ('sampledTreePeakRssBytes', 0), ('elapsedSeconds', float('inf'))]:
            f = self.case_fixture(); f[8][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): v.case_bindings(*f)

    def test_reject_mission_or_auditor_command_changes(self):
        for role in ('mission', 'audit'):
            for pos, value in [(0, '/wrong/interpreter'), (-1, '/wrong/path')]:
                f = self.case_fixture(); f[7][role]['command'][pos] = value
                with self.assertRaises(ValueError): v.case_bindings(*f)
        f = self.case_fixture(); f[8]['command'][-1] = 'development'
        with self.assertRaises(ValueError): v.case_bindings(*f)

    def test_reject_false_numerical_or_physical_claim(self):
        for key in ('scientificallyAccepted', 'physicalValidation'):
            f = self.case_fixture(); f[5][key] = True
            with self.assertRaises(ValueError): v.case_bindings(*f)

    def logs(self):
        return dict(logStream=v.JOB + '/algo-1-12345', events=[dict(message='CAMPAIGN_CASE_COMPLETED ' + cid)
            for cid in self.cases] + [dict(message='CAMPAIGN_NUMERICAL_COMPLETE_INDEPENDENT_AUDIT_REQUIRED')])

    def test_all_terminal_log_markers_fixture(self):
        v.log_markers(self.logs(), self.cases)

    def test_reject_missing_duplicate_extra_and_fatal_markers(self):
        for kind in ('missing', 'duplicate', 'extra', 'fatal', 'missing-terminal', 'development'):
            logs = self.logs()
            if kind == 'missing': logs['events'].pop(0)
            elif kind == 'duplicate': logs['events'].append(logs['events'][0])
            elif kind == 'extra': logs['events'].append(dict(message='CAMPAIGN_CASE_COMPLETED alien'))
            elif kind == 'fatal': logs['events'].append(dict(message='Traceback (most recent call last):'))
            elif kind == 'missing-terminal': logs['events'].pop()
            else: logs['events'].append(dict(message='WRAPPER_DEVELOPMENT_COMPLETE_INDEPENDENT_AUDIT_REQUIRED'))
            with self.subTest(kind=kind), self.assertRaises(ValueError): v.log_markers(logs, self.cases)

    def test_reject_unsafe_paths(self):
        for name in ('../x', '/x', 'a//b', 'a\\b', '', 'a\nb', 'a/./b'):
            with self.subTest(name=name), self.assertRaises(ValueError): v.safe(name)

    def test_small_tree_full_hashing_and_no_extra_members(self):
        with tempfile.TemporaryDirectory() as temp:
            tree = Path(temp).resolve(); (tree / 'output').mkdir(); file = tree / 'output/test'
            file.write_bytes(b'fixture')
            self.assertEqual(v.tree_hashes(tree, {'output/test'}), {'output/test': v.sha(file)})
            (tree / 'extra').mkdir()
            with self.assertRaises(ValueError): v.tree_hashes(tree, {'output/test'})

    def test_reject_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            tree = Path(temp).resolve(); (tree / 'output').mkdir(); body = tree / 'output/body'
            body.write_bytes(b'fixture'); (tree / 'output/link').symlink_to(body)
            with self.assertRaises(ValueError): v.tree_hashes(tree, {'output/body', 'output/link'})

    def test_reject_duplicate_or_nonfinite_json(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}', b'{"x":1e309}'):
            with self.assertRaises(ValueError): v.strict_json(raw)

    def test_real_development_download_cannot_be_campaign(self):
        tree = ROOT / 'research/results/si_mechanism_wrapper_witness_v1_terminal_acceptance_attempt01_2026-09-30/download'
        with self.assertRaisesRegex(ValueError, 'immutable intent body'):
            v.verify_download(tree, self.document, self.index, self.release, self.cases, self.worlds, self.collector, self.controller)

    def profile(self):
        r = self.release['resources']
        return dict(workers=24, histories=2400, monitorError=None, samples=100, sampledPeakRssBytes=1000000000,
                    minimumObservedFreeMemoryBytes=r['minimumFreeMemoryBytes'], minimumObservedFreeDiskBytes=r['minimumFreeDiskBytes'],
                    elapsedSeconds=10000, sampleIntervalSeconds=.5, absolutePeakBound=False)

    def test_aggregate_resource_profile_fixture(self):
        v.resource_profile(self.profile(), self.release['resources'])
        for key, value in [('workers', 8), ('histories', 120), ('samples', 0), ('monitorError', 'error'),
                           ('minimumObservedFreeDiskBytes', 0), ('elapsedSeconds', 90000), ('absolutePeakBound', True)]:
            p = self.profile(); p[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): v.resource_profile(p, self.release['resources'])


if __name__ == '__main__':
    unittest.main()
