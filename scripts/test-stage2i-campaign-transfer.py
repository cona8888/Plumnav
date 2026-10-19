#!/usr/bin/env python3
"""Small offline tests of transfer mechanics; no scientific simulation or AWS."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('campaign_importer', HERE/'import-stage2i-campaign.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
closure_spec = importlib.util.spec_from_file_location('campaign_closure', HERE/'close-stage2i-campaign.py')
closure = importlib.util.module_from_spec(closure_spec); closure_spec.loader.exec_module(closure)


class TransferTests(unittest.TestCase):
    def run_join(self, folder, *, sha=None, count=2, size=6):
        data = folder/'chunks'; data.mkdir(exist_ok=True)
        (data/'stage2i-campaign-part-0.tar.chunk0').write_bytes(b'abc')
        (data/'stage2i-campaign-part-0.tar.chunk1').write_bytes(b'def')
        return subprocess.run([sys.executable, str(HERE/'join-stage2i-transfer.py'),
            '--chunks', str(data), '--part', '0', '--count', str(count), '--bytes', str(size),
            '--sha256', sha or hashlib.sha256(b'abcdef').hexdigest(), '--output', str(folder/'out')],
            capture_output=True, text=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE':'1'})

    def test_join_requires_complete_hash(self):
        with tempfile.TemporaryDirectory(prefix='stage2i-transfer-test-') as tmp:
            root = Path(tmp); result = self.run_join(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root/'out/stage2i-campaign-part-0.tar').read_bytes(), b'abcdef')

    def test_corrupt_transfer_never_promoted(self):
        with tempfile.TemporaryDirectory(prefix='stage2i-transfer-test-') as tmp:
            root = Path(tmp); result = self.run_join(root, sha='0'*64)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root/'out/stage2i-campaign-part-0.tar').exists())
            self.assertTrue((root/'out/stage2i-campaign-part-0.tar.partial').exists())

    def test_missing_chunk_never_promoted(self):
        with tempfile.TemporaryDirectory(prefix='stage2i-transfer-test-') as tmp:
            root = Path(tmp); result = self.run_join(root, count=3)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root/'out').exists())

    def test_byte_mismatch_rejected(self):
        with tempfile.TemporaryDirectory(prefix='stage2i-transfer-test-') as tmp:
            root = Path(tmp); result = self.run_join(root, size=7)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root/'out').exists())

    def test_existing_verified_archive_preserved(self):
        with tempfile.TemporaryDirectory(prefix='stage2i-transfer-test-') as tmp:
            root = Path(tmp); out = root/'out'; out.mkdir()
            path = out/'stage2i-campaign-part-0.tar'; path.write_bytes(b'preserve')
            result = self.run_join(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(path.read_bytes(), b'preserve')

    def test_paths(self):
        for name in ['output/worker-0/case-000.json.gz', 'provenance/launch.json']:
            self.assertEqual(str(module.safe_name(name)), name)
        for name in ['/output/x','output/../x','output//x','output/./x','else/x','output']:
            with self.subTest(name=name), self.assertRaises(AssertionError): module.safe_name(name)

    def test_frozen_noncontiguous_indices_preserved(self):
        closure.require_frozen_indices([0, 4, 923], [923, 0, 4])

    def test_renumbered_cases_rejected(self):
        with self.assertRaises(AssertionError):
            closure.require_frozen_indices([0, 4, 923], [0, 1, 2])

    def test_missing_or_duplicate_actual_case_rejected(self):
        for actual in [[0, 4], [0, 4, 4]]:
            with self.subTest(actual=actual), self.assertRaises(AssertionError):
                closure.require_frozen_indices([0, 4, 923], actual)

    def test_duplicate_frozen_case_rejected(self):
        with self.assertRaises(AssertionError):
            closure.require_frozen_indices([0, 4, 4], [0, 4, 4])


if __name__ == '__main__': unittest.main()
