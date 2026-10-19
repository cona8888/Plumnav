"""No AWS: nested download/launch-contract/transport fixtures."""
import copy
import importlib.util
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('nested_collector_fixture', ROOT / 'scripts/collect-mechanism-campaign-audit-backend-v1.py')
n = importlib.util.module_from_spec(spec); spec.loader.exec_module(n)
c, k = n.dependencies()
INDEX = c.strict_json((ROOT / 'research/results/si_mechanism_campaign_audit_index_v1_attempt01_2026-09-30/audit-index.json').read_bytes())
JOB = 'plumenav-mech-campaign-audit-v1-20261001-000001'


class NestedTests(unittest.TestCase):
    def intent(self):
        gate = 'a'*64; controller = 'b'*64
        return dict(version='mechanism-campaign-audit-backend-launch-intent-v1', kind='independent-audit-backend',
            account=k.ACCOUNT, region=k.REGION, producerJob=k.PRODUCER_JOB, producerIntentSha256=k.PRODUCER_INTENT_SHA,
            producerTerminalGateSha256=gate, producerLedgerSha256='c'*64, controllerSha256=controller,
            packageSha256=k.PACKAGE_SHA, releaseSha256=k.RELEASE_SHA, driverSha256=k.DRIVER_SHA,
            producerVerifierSha256=k.VERIFIER_SHA, inputHashes=dict(k.INPUTS, **{'producer-terminal-gate.json': gate}),
            spec=k.spec_for(JOB, gate), histories=2400, worlds=128, resolutionTriplets=240, newMissions=0,
            authorApprovedAdditionalBudgetUSD=200, allocatedAuditUSD=70, submitted=False, automaticRetryAllowed=False,
            scientificallyAccepted=False)

    def actual(self):
        return dict(k.spec_for(JOB, 'a'*64), ProcessingJobArn='arn:aws:sagemaker:us-east-1:380061838272:processing-job/' + JOB,
            ProcessingJobStatus='Completed', ProcessingStartTime='2026-10-01T00:01:00Z', ProcessingEndTime='2026-10-01T10:00:00Z')

    def test_clean_exact_future_launch_fixture(self):
        prefix = k.validate_actual(self.intent(), self.actual(), JOB, k.PREFIX + 'provenance/' + JOB + '/launch-intent.json', 'b'*64, c.matches)
        self.assertEqual(prefix, k.PREFIX + 'jobs/' + JOB + '/output/')

    def test_exact_audit_only_spec(self):
        d = self.actual(); cfg = d['ProcessingResources']['ClusterConfig']; env = d['Environment']
        self.assertEqual(cfg, dict(InstanceType='ml.m5.12xlarge', InstanceCount=1, VolumeSizeInGB=300))
        self.assertEqual(d['StoppingCondition']['MaxRuntimeInSeconds'], 86400)
        self.assertEqual(env['MECHANISM_SAVED_CAMPAIGN_AUDIT_APPROVED'], 'YES')
        for mode in ('CAMPAIGN', 'DEVELOPMENT', 'INSPECTION'):
            self.assertEqual(env['MECHANISM_' + mode + '_APPROVED'], 'NO')

    def test_reject_actual_nonterminal_or_failure(self):
        for key, value in [('ProcessingJobStatus', 'Failed'), ('FailureReason', 'error'), ('ProcessingStartTime', None),
                           ('ProcessingEndTime', None), ('ProcessingJobArn', 'different')]:
            a = self.actual(); a[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                k.validate_actual(self.intent(), a, JOB, k.PREFIX + 'provenance/' + JOB + '/launch-intent.json', 'b'*64, c.matches)

    def test_reject_source_scope_authority_and_retry_changes(self):
        for key, value in [('histories', 120), ('worlds', 64), ('resolutionTriplets', 0), ('newMissions', False),
                           ('scientificallyAccepted', True), ('automaticRetryAllowed', True), ('allocatedAuditUSD', 200),
                           ('packageSha256', '0'*64), ('driverSha256', '0'*64), ('controllerSha256', '0'*64),
                           ('producerJob', 'different')]:
            d = self.intent(); d[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                k.validate_intent(d, JOB, k.PREFIX + 'provenance/' + JOB + '/launch-intent.json', 'b'*64)

    def test_reject_extra_env_or_arguments(self):
        for change in (lambda a: a['Environment'].update(PYTHONPATH='/foreign'),
                       lambda a: a['Environment'].update(MECHANISM_CAMPAIGN_APPROVED='YES'),
                       lambda a: a['AppSpecification'].update(ContainerArguments=['--execute-approved-campaign'])):
            a = self.actual(); change(a)
            with self.assertRaises(ValueError):
                k.validate_actual(self.intent(), a, JOB, k.PREFIX + 'provenance/' + JOB + '/launch-intent.json', 'b'*64, c.matches)

    def test_reject_wrong_or_extra_input_pin(self):
        for action in ('wrong', 'extra'):
            d = self.intent()
            if action == 'wrong': d['inputHashes']['campaign.tar.gz'] = '0'*64
            else: d['inputHashes']['unknown'] = '0'*64
            with self.assertRaises(ValueError): k.validate_intent(d, JOB, k.PREFIX + 'provenance/' + JOB + '/launch-intent.json', 'b'*64)

    def test_full_nested_scope_matches_backend(self):
        spec = importlib.util.spec_from_file_location('nested_fixture_backend', ROOT / 'aws/mechanism-campaign-audit-backend-v1/bootstrap.py')
        backend = importlib.util.module_from_spec(spec); spec.loader.exec_module(backend)
        expected = k.expected_payloads(INDEX, c)
        self.assertEqual(expected, backend.expected_payloads(INDEX, c))
        self.assertEqual(len(expected), 14427)

    def test_reject_fake_smoke_membership(self):
        index = copy.deepcopy(INDEX); index['historyIds'] = index['historyIds'][:3]
        with self.assertRaises(ValueError): k.expected_payloads(index, c)

    def test_full_outer_and_nested_ledger_hash_logic_small_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            tree = Path(temp).resolve(); path = tree / 'LEDGER'
            (tree / 'body').write_bytes(b'fixture')
            digest = n.sha(tree / 'body'); path.write_text(digest + '  body\n')
            n.ledger(path, {'body'}, {'output/body': digest}, 'output/', c.safe)
            with self.assertRaises(ValueError): n.ledger(path, {'body'}, {'output/body': '0'*64}, 'output/', c.safe)

    def test_reject_duplicate_missing_and_unsafe_ledger(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'LEDGER'
            for text in ('a'*64 + '  body\n' + 'a'*64 + '  body\n', 'a'*64 + '  ../body\n', 'bad  body\n', ''):
                path.write_text(text)
                with self.assertRaises(ValueError): n.ledger(path, {'body'}, {'output/body': 'a'*64}, 'output/', c.safe)

    def test_terminal_tar_small_body_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); tree = root / 'download'; tree.mkdir(); (tree / 'output').mkdir()
            (tree / 'output/body').write_bytes(b'fixture')
            proof = n.terminal_tar(tree, root / 'terminal.tar', {'output/body'})
            self.assertEqual(proof['bodies'], 1); self.assertEqual(proof['sha256'], n.sha(root / 'terminal.tar'))
            with tarfile.open(root / 'terminal.tar') as archive:
                self.assertEqual(archive.getnames(), ['output/body'])

    def test_no_tar_inside_saved_tree_or_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); tree = root / 'download'; tree.mkdir(); (tree / 'body').write_bytes(b'fixture')
            with self.assertRaises(ValueError): n.terminal_tar(tree, tree / 'terminal.tar', {'body'})
            (root / 'existing.tar').write_bytes(b'preserve')
            with self.assertRaises(ValueError): n.terminal_tar(tree, root / 'existing.tar', {'body'})


if __name__ == '__main__':
    unittest.main()
