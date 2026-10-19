"""Adversarial verification fixtures only: no simulated missions or AWS calls."""
import copy
import json
import math
from pathlib import Path
import tempfile
import unittest

from mechanism_portability_candidate_v1 import (
    VERSION, MAX_ULPS, compare, compare_audits, compare_reference_guard,
    field_kind, write_comparison_receipt,
)
from verification_manifest_v1 import MANIFEST, write_manifest, verify_manifest


def walk(x, n):
    for _ in range(n):
        x = math.nextafter(x, math.inf)
    return x


def fixture(value=.5):
    return dict(controls=[dict(time=0., position=dict(x=.2, y=.3), heading=.4,
                distance=.5, measurement=dict(concentration=value, valid=True,
                hit=False, localInletReadings=[dict(concentration=value,
                saturated=False, effectiveOffset=dict(x=.001, y=.002))]),
                decision=dict(direction=dict(x=.7, y=.8), speedScale=1.))],
                spec=dict(worldSeed=281301), trace=[[0.] + [.5] * 23],
                summary=dict(stage='no-eligible-nomination', completedAt=600.,
                             pathLengthMetres=1.), schedulingTrace=[dict(queries=1)])


class NumericalTests(unittest.TestCase):
    def changed(self, change, value=.5):
        a = fixture(value)
        b = copy.deepcopy(a)
        change(b)
        return compare(a, b, VERSION)

    def test_default_strict_and_boundary(self):
        a = fixture(); b = fixture(walk(.5, MAX_ULPS))
        self.assertFalse(compare(a, b)['passed'])
        self.assertTrue(compare(a, b, VERSION)['passed'])
        self.assertFalse(compare(a, fixture(walk(.5, MAX_ULPS + 1)), VERSION)['passed'])

    def test_absolute_cap_binds(self):
        # One ULP at a huge value exceeds the unit-specific absolute ceiling.
        self.assertFalse(compare(fixture(1e10), fixture(walk(1e10, 1)), VERSION)['passed'])

    def test_zero_sign_and_subnormal(self):
        for a, b in ((0., -0.), (0., math.ulp(0.)), (-.5, .5)):
            with self.subTest(a=a, b=b):
                self.assertFalse(compare(fixture(a), fixture(b), VERSION)['passed'])
        tiny = math.ulp(0.)
        self.assertTrue(compare(fixture(tiny), fixture(2 * tiny), VERSION)['passed'])

    def test_non_finite_even_self_comparison(self):
        for v in (math.inf, -math.inf, math.nan):
            self.assertFalse(compare(fixture(v), fixture(v), VERSION)['passed'])

    def test_types_are_exact(self):
        for v in (True, 1, '0.5', None):
            self.assertFalse(compare(fixture(.5), fixture(v), VERSION)['passed'])

    def test_discrete_and_decision_changes_rejected(self):
        changes = [
            lambda x: x['spec'].update(worldSeed=281302),
            lambda x: x['controls'][0]['measurement'].update(valid=False),
            lambda x: x['controls'][0]['measurement'].update(hit=True),
            lambda x: x['controls'][0]['measurement']['localInletReadings'][0].update(saturated=True),
            lambda x: x['controls'][0].update(time=math.ulp(0.)),
            lambda x: x['controls'][0]['decision'].update(speedScale=walk(1., 1)),
            lambda x: x['controls'][0]['decision']['direction'].update(x=walk(.7, 1)),
            lambda x: x['summary'].update(pathLengthMetres=walk(1., 1)),
            lambda x: x['schedulingTrace'][0].update(queries=2),
            lambda x: x['trace'][0].__setitem__(0, math.ulp(0.)),
            lambda x: x['controls'][0]['measurement'].update(unknownField=.5),
            lambda x: x['controls'].pop(),
        ]
        for i, change in enumerate(changes):
            with self.subTest(mutation=i):
                self.assertFalse(self.changed(change)['passed'])

    def test_reordering_and_unknown_numeric_fields(self):
        a = dict(observations=[dict(time=1., concentration=.5), dict(time=2., concentration=.6)])
        b = dict(observations=list(reversed(a['observations'])))
        self.assertFalse(compare(a, b, VERSION)['passed'])
        self.assertFalse(compare(dict(unrecognised=.5), dict(unrecognised=walk(.5, 1)), VERSION)['passed'])

    def test_field_units_and_substantive_change(self):
        self.assertEqual(field_kind(('trace', 0, 12)), 'concentration')
        self.assertEqual(field_kind(('trace', 0, 4)), 'position')
        self.assertEqual(field_kind(('controls', 0, 'measurement', 'wind', 'x')), 'wind')
        self.assertIsNone(field_kind(('config', 'sensorNoise')))
        self.assertFalse(self.changed(lambda x: x['controls'][0]['measurement'].update(concentration=.5000001))['passed'])
        self.assertFalse(self.changed(lambda x: x['controls'][0]['position'].update(x=.200001))['passed'])

    def test_audit_residual_bounds_not_blanket_allclose(self):
        a = dict(passed=True, traceRows=10, errors=dict(response=1e-16))
        b = dict(a, errors=dict(response=2e-16))
        limits = dict(response=1e-9)
        self.assertFalse(compare_audits(a, b, limits)['passed'])
        self.assertTrue(compare_audits(a, b, limits, VERSION)['passed'])
        for bad in (dict(b, passed=False), dict(b, traceRows=11),
                    dict(b, errors=dict(response=math.nextafter(1e-9, math.inf))),
                    dict(b, errors=dict(response=-1e-18)),
                    dict(b, errors=dict(response=math.nan)),
                    dict(b, errors=dict(response=True)),
                    dict(b, errors=dict(unknown=0.)), dict(b, errors=None)):
            self.assertFalse(compare_audits(a, bad, limits, VERSION)['passed'])

    def test_rejection_receipt_written_before_failure(self):
        with tempfile.TemporaryDirectory(prefix='plumenav-receipt-fixture-') as tmp:
            p = Path(tmp) / 'comparison.json'
            details = dict(passed=True, errors=dict(response=0.))
            r = write_comparison_receipt(p, fixture(), fixture(.6), details,
                    details, dict(response=1e-9), dict(success=False), dict(success=True), VERSION)
            self.assertFalse(r['candidateChecksPassed'])
            self.assertEqual(json.loads(p.read_text())['actualAuditDetails'], details)
            self.assertFalse(r['accepted'])
            with self.assertRaises(FileExistsError):
                write_comparison_receipt(p, {}, {}, details, details, {}, {}, {})


    def test_reused_reference_guard_requires_original_binding(self):
        guard = dict(baseSha256='a', derivedSha256='b')
        bound = dict(guard=None, reusedScientificAudit=True, newScientificAudit=False,
                     caseId='NS', history=dict(sha256='history'), details=dict(passed=True))
        old = dict(guard=guard, passed=True, wholeReferenceMatched=True, caseId='NS',
                   historySha256='history', details=dict(passed=True))
        self.assertTrue(compare_reference_guard(bound, guard, old)['passed'])
        self.assertFalse(compare_reference_guard(bound, guard)['passed'])
        for bad in (dict(old, caseId='RW'), dict(old, historySha256='changed'),
                    dict(old, guard=None), dict(old, details=dict(passed=False)),
                    dict(old, passed=False), dict(old, wholeReferenceMatched=False)):
            self.assertFalse(compare_reference_guard(bound, guard, bad)['passed'])
        self.assertFalse(compare_reference_guard(bound, dict(guard, baseSha256='changed'), old)['passed'])
        self.assertFalse(compare_reference_guard(dict(bound, reusedScientificAudit=False), guard, old)['passed'])


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='plumenav-manifest-fixture-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'cases').mkdir()
        (self.root / 'cases/mission.json').write_text('{"complete": true}\n')
        (self.root / 'done.json').write_text('{}\n')
        self.expected = ['cases/mission.json', 'done.json']

    def test_local_sidecar_and_download_without_sidecar(self):
        marker = self.root / 'cases/mission.json.sagemaker-uploaded'
        marker.touch()
        r = write_manifest(self.root, self.expected)
        self.assertEqual(r['payloads'], 2)
        self.assertNotIn('.sagemaker-uploaded', (self.root / MANIFEST).read_text())
        self.assertTrue(verify_manifest(self.root, self.expected, True)['passed'])
        with self.assertRaises(ValueError):
            verify_manifest(self.root, self.expected)  # remote mode stays strict
        marker.unlink()  # Only a temporary test fixture, never a real marker.
        self.assertTrue(verify_manifest(self.root, self.expected)['passed'])
        with self.assertRaises(ValueError):
            write_manifest(self.root, self.expected)

    def test_changed_missing_extra_payloads(self):
        write_manifest(self.root, self.expected)
        (self.root / 'done.json').write_text('{"changed":true}')
        with self.assertRaises(ValueError):
            verify_manifest(self.root, self.expected)
        (self.root / 'done.json').unlink()
        with self.assertRaises(ValueError):
            verify_manifest(self.root, self.expected)
        (self.root / 'extra.json').write_text('{}')
        with self.assertRaises(ValueError):
            verify_manifest(self.root, self.expected)

    def test_bad_markers(self):
        for name, data in (('orphan.sagemaker-uploaded', ''),
                           ('done.json.sagemaker-uploaded', 'not empty'),
                           ('done.json.sagemaker-uploaded.sagemaker-uploaded', '')):
            with self.subTest(name=name):
                p = self.root / name; p.write_text(data)
                with self.assertRaises(ValueError):
                    write_manifest(self.root, self.expected)
                p.unlink()

    def test_links_and_unknown_directories(self):
        link = self.root / 'link'; link.symlink_to(self.root / 'done.json')
        with self.assertRaises(ValueError):
            write_manifest(self.root, self.expected)
        link.unlink()
        (self.root / 'unlisted').mkdir()
        with self.assertRaises(ValueError):
            write_manifest(self.root, self.expected)

    def test_manifest_corruption_and_unsafe_inventory(self):
        for inventory in (self.expected + [self.expected[0]], ['../done.json'],
                          ['/done.json'], ['cases//mission.json'], ['bad\nname'], [],
                          self.expected + [MANIFEST], ['x.sagemaker-uploaded']):
            with self.assertRaises(ValueError):
                write_manifest(self.root, inventory)
        write_manifest(self.root, self.expected)
        text = (self.root / MANIFEST).read_text()
        for corrupt in (text + text, text.replace('done.json', '../done.json'),
                        text.replace('  ', ' ', 1), text.splitlines()[0] + '\n'):
            (self.root / MANIFEST).write_text(corrupt)
            with self.assertRaises(ValueError):
                verify_manifest(self.root, self.expected)


if __name__ == '__main__':
    unittest.main(verbosity=2)
