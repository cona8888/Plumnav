"""Zero-engine regressions for safe managed upload metadata and exact payloads."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def module(name):
    path = Path(__file__).with_name(name + '.py')
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


v1 = module('verification_manifest_v1')
v2 = module('verification_manifest_v2')


class ManifestFixtures(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='plumenav-marker-fixture-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.expected = ['profile-stress.json', 'runs/case/mission.json.gz']
        for name in self.expected:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(('fixed-fixture:' + name).encode())

    def marker(self, base=None, suffix='.sagemaker-uploading', data=b''):
        path = self.root / ((base or self.expected[0]) + suffix)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_reproduce_v1_failure_and_v2_seal(self):
        self.marker()
        with self.assertRaisesRegex(ValueError, 'Unexpected payload'):
            v1.write_manifest(self.root, self.expected)
        result = v2.write_manifest(self.root, self.expected)
        self.assertEqual(result['payloads'], 2)
        self.assertTrue(v2.verify_manifest(self.root, self.expected, True)['passed'])
        self.assertNotIn('sagemaker', (self.root / v2.MANIFEST).read_text())

    def test_both_marker_states_for_every_payload(self):
        for base in self.expected:
            for suffix in v2.MARKERS:
                self.marker(base, suffix)
        v2.write_manifest(self.root, self.expected)
        self.assertEqual(len(v2.verify_manifest(self.root, self.expected, True)['ignoredLocalMarkers']), 4)

    def test_remote_inventory_never_ignores_markers(self):
        v2.write_manifest(self.root, self.expected)
        self.marker()
        with self.assertRaises(ValueError):
            v2.verify_manifest(self.root, self.expected)

    def test_nonempty_markers_rejected(self):
        for suffix in v2.MARKERS:
            with self.subTest(suffix=suffix):
                path = self.marker(suffix=suffix, data=b'not-empty')
                with self.assertRaises(ValueError):
                    v2.inventory(self.root, self.expected, True, False)
                path.unlink()

    def test_orphan_marker_rejected(self):
        self.marker('unknown.json')
        with self.assertRaises(ValueError):
            v2.write_manifest(self.root, self.expected)

    def test_missing_payload_not_hidden_by_marker(self):
        self.marker()
        (self.root / self.expected[0]).unlink()
        with self.assertRaisesRegex(ValueError, 'Missing payloads'):
            v2.write_manifest(self.root, self.expected)

    def test_unknown_payload_rejected(self):
        (self.root / 'unexpected').write_bytes(b'x')
        with self.assertRaises(ValueError):
            v2.write_manifest(self.root, self.expected)

    def test_unknown_empty_directory_rejected(self):
        (self.root / 'unknown').mkdir()
        with self.assertRaises(ValueError):
            v2.write_manifest(self.root, self.expected)

    def test_marker_directory_rejected(self):
        (self.root / (self.expected[0] + v2.MARKERS[0])).mkdir()
        with self.assertRaises(ValueError):
            v2.write_manifest(self.root, self.expected)

    def test_symlink_payload_and_marker_rejected(self):
        for suffix in ('', *v2.MARKERS):
            with self.subTest(suffix=suffix):
                path = self.root / (self.expected[0] + suffix)
                if path.exists():
                    path.unlink()
                path.symlink_to(self.root / self.expected[1])
                with self.assertRaises(ValueError):
                    v2.write_manifest(self.root, self.expected)
                path.unlink()
                if not suffix:
                    path.write_bytes(b'restored-fixture')

    def test_manifest_markers_only_after_manifest_exists(self):
        path = self.marker(v2.MANIFEST)
        with self.assertRaises(ValueError):
            v2.write_manifest(self.root, self.expected)
        path.unlink()
        v2.write_manifest(self.root, self.expected)
        for suffix in v2.MARKERS:
            self.marker(v2.MANIFEST, suffix)
        self.assertTrue(v2.verify_manifest(self.root, self.expected, True)['passed'])

    def test_nested_marker_suffix_rejected(self):
        self.marker(self.expected[0] + v2.MARKERS[0])
        with self.assertRaises(ValueError):
            v2.write_manifest(self.root, self.expected)

    def test_reserved_marker_names_rejected(self):
        for suffix in v2.MARKERS:
            with self.assertRaises(ValueError):
                v2.inventory(self.root, self.expected + [self.expected[0] + suffix], True, False)

    def test_disappearing_known_marker_is_safe(self):
        marker = self.marker()
        original = Path.lstat
        def disappearing(path):
            if path == marker:
                raise FileNotFoundError('uploader removed its metadata')
            return original(path)
        with patch.object(Path, 'lstat', disappearing):
            self.assertEqual(len(v2.inventory(self.root, self.expected, True, False)[0]), 2)

    def test_disappearing_payload_fails_closed(self):
        payload = self.root / self.expected[0]
        original = Path.lstat
        def disappearing(path):
            if path == payload:
                raise FileNotFoundError('payload missing')
            return original(path)
        with patch.object(Path, 'lstat', disappearing):
            with self.assertRaises(ValueError):
                v2.inventory(self.root, self.expected, True, False)

    def test_payload_mutation_between_inventories_rejected(self):
        original = v2.inventory
        calls = []
        def mutating(*args):
            result = original(*args)
            if not calls:
                (self.root / self.expected[0]).write_bytes(b'changed')
            calls.append(True)
            return result
        with patch.object(v2, 'inventory', mutating):
            with self.assertRaisesRegex(ValueError, 'Output changed'):
                v2.write_manifest(self.root, self.expected)
        self.assertFalse((self.root / v2.MANIFEST).exists())

    def test_duplicate_empty_unsafe_contracts_rejected(self):
        for names in ([], [self.expected[0]] * 2, ['../escape'], ['/absolute'], ['a\\b'], ['a\nb']):
            with self.subTest(names=names):
                with self.assertRaises(ValueError):
                    v2.inventory(self.root, names, True, False)

    def test_v1_strict_remote_verifier_accepts_identical_ledger_format(self):
        v2.write_manifest(self.root, self.expected)
        self.assertTrue(v1.verify_manifest(self.root, self.expected)['passed'])

    def test_changed_payload_after_seal_rejected(self):
        v2.write_manifest(self.root, self.expected)
        (self.root / self.expected[0]).write_bytes(b'changed')
        with self.assertRaises(ValueError):
            v2.verify_manifest(self.root, self.expected)

    def test_manifest_cannot_be_rewritten(self):
        v2.write_manifest(self.root, self.expected)
        with self.assertRaises(ValueError):
            v2.write_manifest(self.root, self.expected)


if __name__ == '__main__':
    unittest.main()
