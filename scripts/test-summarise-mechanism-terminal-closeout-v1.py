"""Synthetic exporter fixtures only; never campaign evidence or acceptance."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).with_name('summarise-mechanism-terminal-closeout-v1.py')
spec = importlib.util.spec_from_file_location('closeout_exporter_fixture', SOURCE)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportFixtures(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='synthetic-closeout-test-', dir=exporter.ROOT / 'research/results')
        self.root = Path(self.tmp.name)
        self.assembly_path = self.root / 'download/output/independent/assembly.json'
        self.assembly_path.parent.mkdir(parents=True)
        arms = []
        for field in ('si-continuous', 'si-pulse', 'blank'):
            for index, arm in enumerate(('RW', 'GW', 'RL', 'GL', 'NS')):
                arms.append(dict(field=field, arm=arm, proportion=index / 8 if field != 'blank' else None,
                                 fixtureOnly=True))
        self.assembly = dict(componentPassed=True, failedTriplets=[], statistics=dict(
            independentWorlds=128, primary=[dict(fixtureOnly=True, index=i) for i in range(4)],
            arms=arms, bootstrap=dict(seed=7, drawIndices=[[0]], contrastSampleMeans=[[0]], fixtureOnly=True)))
        self.assembly_path.write_text(json.dumps(self.assembly))
        self.receipt = dict(scientificallyAccepted=True, terminalProvenanceAccepted=True,
            independentAllHistoryExecutionAccepted=True, primaryInferentialClaimsAdmitted=True,
            exactDiscreteStatisticsReconstructionPassed=True, histories=2400, worlds=128,
            resolutionTriplets=240, failedTriplets=[], sourceScriptSha256=exporter.VERIFIER_SHA,
            assemblySha256=exporter.sha(self.assembly_path), archiveSha256='synthetic-fixture-only',
            auditorJob='synthetic-fixture-only', producerJob='synthetic-fixture-only',
            manifestSha256='synthetic-fixture-only', releaseSha256='synthetic-fixture-only')
        for key in ('physicalValidation', 'hardwareValidation', 'urbanValidation',
                    'aerodynamicSniffing', 'universalWinnerClaim', 'validatedAbsenceOfRealLeak'):
            self.receipt[key] = False
        self.save_receipt()

    def tearDown(self):
        self.tmp.cleanup()

    def save_receipt(self):
        (self.root / 'terminal-acceptance.json').write_text(json.dumps(self.receipt))

    def test_exact_frozen_rows_preserved(self):
        before = copy.deepcopy(self.assembly)
        result = exporter.make_handoff(self.root)
        self.assertEqual(result['primaryEffects'], before['statistics']['primary'])
        self.assertEqual(result['armFieldOutcomes'], before['statistics']['arms'])
        self.assertEqual(result['bootstrap'], dict(seed=7, fixtureOnly=True))
        self.assertEqual(result['descriptiveSchedulingContrasts'][0]['liveSchedulingRiskDifference'], 1 / 8)
        self.assertEqual(result['descriptiveSchedulingContrasts'][0]['withheldSchedulingRiskDifference'], 1 / 8)
        self.assertEqual(self.assembly, before)
        self.assertEqual(result['newMissions'], 0)
        self.assertFalse(result['manuscriptChanged'])

    def test_unaccepted_receipt_rejected(self):
        self.receipt['scientificallyAccepted'] = False
        self.save_receipt()
        with self.assertRaises(ValueError):
            exporter.make_handoff(self.root)

    def test_wrong_verifier_rejected(self):
        self.receipt['sourceScriptSha256'] = 'not-the-approved-verifier'
        self.save_receipt()
        with self.assertRaises(ValueError):
            exporter.make_handoff(self.root)

    def test_mutated_assembly_rejected(self):
        self.assembly_path.write_text('{}')
        with self.assertRaises(ValueError):
            exporter.make_handoff(self.root)

    def test_failed_refinement_rejected(self):
        self.receipt['failedTriplets'] = ['synthetic-adverse-fixture']
        self.save_receipt()
        with self.assertRaises(ValueError):
            exporter.make_handoff(self.root)

    def test_broader_validation_rejected(self):
        self.receipt['hardwareValidation'] = True
        self.save_receipt()
        with self.assertRaises(ValueError):
            exporter.make_handoff(self.root)

    def test_incomplete_population_rejected(self):
        self.assembly['statistics']['arms'].pop()
        self.assembly_path.write_text(json.dumps(self.assembly))
        self.receipt['assemblySha256'] = exporter.sha(self.assembly_path)
        self.save_receipt()
        with self.assertRaises(ValueError):
            exporter.make_handoff(self.root)


if __name__ == '__main__':
    unittest.main()
