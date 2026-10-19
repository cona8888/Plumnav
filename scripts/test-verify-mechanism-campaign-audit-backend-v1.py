"""Zero-mission acceptance-contract fixtures, not actual campaign acceptance."""
from array import array
import copy
import hashlib
import importlib.util
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('full_terminal_fixture', ROOT / 'scripts/verify-mechanism-campaign-audit-backend-v1.py')
v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)


class TerminalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p, cls.n, cls.c, cls.k, cls.b, cls.endpoint = v.dependencies()
        cls.index = cls.p.load(ROOT / 'research/results/si_mechanism_campaign_audit_index_v1_attempt01_2026-09-30/audit-index.json')

    def process(self, cid=None):
        cid = cid or self.index['historyIds'][0]
        science = '/opt/ml/processing/audit-work/plumenav-saved-audit-fixture/science'
        prefix = str(Path(science).parent)
        command = ['/opt/conda/bin/python', '-B', science + '/aws/mechanism-campaign-v1/audit.py',
            '--science', science, '--manifest', science + '/metadata/prospective_manifest_portable_v1.json',
            '--release', science + '/metadata/campaign-release.json', '--release-sha256', self.p.RELEASE_SHA,
            '--worker', science + '/aws/mechanism-campaign-v1/worker_v4.mjs', '--run', prefix + '/producer/output/run',
            '--case', cid, '--audit-output', '/opt/ml/processing/output/independent/audits']
        terminal = dict(command=command, exitCode=0, timedOut=False, cancelled=False)
        resource = dict(terminal, elapsedSeconds=100., samples=101, sampledTreePeakRssBytes=100000000,
                        intervalSeconds=1, absolutePeakBound=False)
        return terminal, resource

    def assembly(self, failed=False):
        triplets = []
        for i, route in enumerate(self.index['resolutionTriplets']):
            value = {k: route[k] for k in ('worldKey', 'arm', 'field', 'caseIds')}
            value.update(numerical=dict(passed=not (failed and i == 0)), endpointGate=dict(passed=True))
            triplets.append(value)
        return dict(version='mechanism-campaign-assembly-v1', histories=2400, worlds=128, primaryHistories=1920,
            refinementHistories=480, triplets=triplets, failedTriplets=[triplets[0]['caseIds']] if failed else [],
            componentPassed=not failed, statistics=None if failed else {},
            scope={k: False for k in ('scientificallyAccepted', 'terminalProvenanceVerified', 'independentFullAuditExecutionVerified',
                'physicalValidation', 'hardwareValidation', 'urbanValidation', 'aerodynamicSniffing', 'automaticWinnerSelection', 'validatedAbsenceOfLeak')})

    def statistics(self):
        keys = [r['worldKey'] for r in self.index['worldBlocks']]
        states = {}
        arms = []
        for field in ('si-continuous', 'si-pulse', 'blank'):
            for arm in ('RW', 'GW', 'RL', 'GL', 'NS'):
                categories = {}
                count = 0
                for i, block in enumerate(self.index['worldBlocks']):
                    cid = block['primary'][field][arm]
                    if field == 'blank':
                        state = dict(success=False, category='blank-no-nomination', blankControls=dict(falseNomination=False, inspectionCompleted=False, falseReport=False))
                    else:
                        ok = ((i + ('RW','GW','RL','GL','NS').index(arm)) % 3 == 0)
                        state = dict(success=ok, category='supported' if ok else 'unresolved')
                        count += ok
                    states[cid] = state; categories[state['category']] = categories.get(state['category'], 0) + 1
                row = dict(field=field, arm=arm, n=128, categories=categories, localisationApplicable=field != 'blank',
                           successes=count if field != 'blank' else None, proportion=count/128 if field != 'blank' else None)
                if field == 'blank':
                    for category in ('blank-no-nomination', 'blank-inspection-incomplete', 'blank-verifier-abstained', 'blank-supported-report'): categories.setdefault(category, 0)
                    row['blankControls'] = {c: dict(count=0, denominator=128, proportion=0.) for c in ('falseNomination', 'inspectionCompleted', 'falseReport')}
                arms.append(row)
        vectors = []
        for block in self.index['worldBlocks']:
            vector = []
            for field in ('si-continuous','si-pulse'):
                y = {arm: int(states[cid]['success']) for arm, cid in block['primary'][field].items()}
                vector += [(y['GL']-y['RL'])-(y['GW']-y['RW']), y['GL']-y['NS']]
            vectors.append(vector)
        # Explicit fixture draws test reconstruction, not PCG64 authenticity.
        draws = [list(range(128)) for _ in range(10000)]
        means = [[sum(v[j] for v in vectors)/128 for j in range(4)] for _ in draws]
        data = array('I', draws[0]);
        if sys.byteorder != 'little': data.byteswap()
        digest = hashlib.sha256(data.tobytes()*10000).hexdigest()
        primary = [dict(contrast=name, worldContrasts=[r[j] for r in vectors], mean=sum(r[j] for r in vectors)/128)
                   for j,name in enumerate(('continuous:I','continuous:D','pulsed:I','pulsed:D'))]
        value = dict(version='paired-availability-statistics-v2', independentWorlds=128, worldOrder=keys, primary=primary, arms=arms,
            bootstrap=dict(method='PCG64-whole-world', seed=711397807, drawCount=10000, quantileMethod='linear',
                indexEncoding='row-major little-endian uint32', numpyVersion='1.26.4', drawIndices=draws,
                contrastSampleMeans=means, indexSha256=digest))
        return value, states

    def test_source_dependencies_unchanged(self):
        for name, digest in v.PINS.items(): self.assertEqual(v.sha(ROOT/name), digest)

    def test_all_2400_exact_independent_process_fixture_commands(self):
        for cid in self.index['historyIds']:
            v.audit_process(cid, *self.process(cid), self.p)

    def test_reject_process_command_scope_source_and_case_change(self):
        for pos, replacement in [(0, 'node'), (2, '/foreign/audit.py'), (-1, '/wrong-output'), (16, 'different-case')]:
            t, r = self.process(); t = copy.deepcopy(t); r = copy.deepcopy(r)
            t['command'][pos] = r['command'][pos] = replacement
            with self.subTest(pos=pos), self.assertRaises(ValueError): v.audit_process(self.index['historyIds'][0], t, r, self.p)

    def test_reject_timeout_failure_or_missing_resource_samples(self):
        for key,value in [('exitCode', 1), ('timedOut', True), ('samples', 0), ('cancelled', True)]:
            t,r = self.process(); r[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): v.audit_process(self.index['historyIds'][0], t, r, self.p)

    def test_exact_full_refinement_map(self):
        self.assertEqual(v.assembly_gate(self.assembly(), self.index), [])

    def test_adverse_triplet_preserved_and_statistics_withheld(self):
        result = self.assembly(True)
        self.assertEqual(v.assembly_gate(result, self.index), [self.index['resolutionTriplets'][0]['caseIds']])
        result['statistics'] = {}
        with self.assertRaises(ValueError): v.assembly_gate(result, self.index)

    def test_reject_triplet_omission_or_substitution(self):
        for action in ('omit', 'replace', 'hide-failure', 'false-validation'):
            result = self.assembly(action == 'hide-failure')
            if action == 'omit': result['triplets'].pop()
            elif action == 'replace': result['triplets'][0]['caseIds'] = ['different']*3
            elif action == 'hide-failure': result['failedTriplets'] = []
            else: result['scope']['hardwareValidation'] = True
            with self.assertRaises(ValueError): v.assembly_gate(result, self.index)

    def test_all_exact_discrete_world_and_bootstrap_means_fixture(self):
        stats, states = self.statistics()
        v.discrete_statistics(stats, self.index, states)

    def test_reject_world_drop_changed_primary_or_absence_claim(self):
        stats, states = self.statistics()
        for mutate in (lambda s: s.update(independentWorlds=64), lambda s: s['primary'][0].update(mean=99),
                       lambda s: s['arms'][-1].update(successes=128), lambda s: s['bootstrap'].update(seed=42),
                       lambda s: s['bootstrap']['contrastSampleMeans'][0].__setitem__(0, 99)):
            test = copy.deepcopy(stats); mutate(test)
            with self.assertRaises(ValueError): v.discrete_statistics(test, self.index, states)

    def test_tar_inspection_full_scope_membership_small_data_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp)/'terminal.tar'; (Path(temp)/'body').write_bytes(b'fixture')
            with tarfile.open(file,'w:') as archive: archive.add(Path(temp)/'body',arcname='output/body')
            self.assertEqual(v.inspect_tar(file, {'output/body'}, self.p.safe), 7)
            with self.assertRaises(ValueError): v.inspect_tar(file, {'output/body','extra'}, self.p.safe)

    def test_real_development_tar_rejected_for_campaign_terminal_scope(self):
        file = ROOT/'research/results/si_mechanism_wrapper_witness_v1_transfer_attempt01_2026-09-30/plumenav-mech-wrapper-witness-v1-20260930-181307-terminal.tar'
        names = self.k.expected_payloads(self.index,self.c)|{self.c.LEDGER}
        wanted = {'output/'+n for n in names}|{'provenance/'+n for n in self.k.PROVENANCE}
        with self.assertRaises(ValueError): v.inspect_tar(file,wanted,self.p.safe)


if __name__ == '__main__': unittest.main()
