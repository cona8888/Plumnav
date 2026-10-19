import hashlib
import tempfile
import unittest
from pathlib import Path
from lib.processing_output_manifest import verify_output_manifest, EMPTY_SHA256


class OutputManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'case.json').write_bytes(b'raw evidence')
        self.digest = hashlib.sha256(b'raw evidence').hexdigest()
        self.rows = [(self.digest, 'case.json')]

    def verify(self, allow=True):
        (self.root / 'SHA256SUMS').write_text(''.join(f'{h}  {n}\n' for h, n in self.rows))
        return verify_output_manifest(self.root, allow_empty_upload_markers=allow)

    def test_exact_payload(self):
        self.assertEqual(self.verify(False)['checkedFiles'], 1)

    def test_explicit_empty_marker_exception(self):
        self.rows.append((EMPTY_SHA256, 'case.json.sagemaker-uploaded'))
        self.assertEqual(len(self.verify()['omittedEmptyUploadMarkers']), 1)

    def test_default_remains_strict(self):
        self.rows.append((EMPTY_SHA256, 'case.json.sagemaker-uploaded'))
        with self.assertRaises(ValueError): self.verify(False)

    def test_missing_payload_rejected(self):
        (self.root / 'case.json').unlink()
        self.rows.append((EMPTY_SHA256, 'case.json.sagemaker-uploaded'))
        with self.assertRaises(ValueError): self.verify()

    def test_corrupt_payload_rejected(self):
        (self.root / 'case.json').write_bytes(b'changed')
        with self.assertRaises(ValueError): self.verify()

    def test_nonempty_marker_rejected(self):
        self.rows.append((self.digest, 'case.json.sagemaker-uploaded'))
        with self.assertRaises(ValueError): self.verify()

    def test_uploading_marker_rejected(self):
        self.rows.append((EMPTY_SHA256, 'case.json.sagemaker-uploading'))
        with self.assertRaises(ValueError): self.verify()

    def test_orphan_marker_rejected(self):
        self.rows.append((EMPTY_SHA256, 'other.json.sagemaker-uploaded'))
        with self.assertRaises(ValueError): self.verify()

    def test_extra_file_rejected(self):
        (self.root / 'extra.json').write_bytes(b'')
        with self.assertRaises(ValueError): self.verify()

    def test_duplicate_rejected(self):
        self.rows.append(self.rows[0])
        with self.assertRaises(ValueError): self.verify()

    def test_unsafe_paths_rejected(self):
        for name in ['../case.json', '/case.json', './case.json', 'a//case.json', '']:
            with self.subTest(name=name):
                self.rows = [(self.digest, 'case.json'), (EMPTY_SHA256, name)]
                with self.assertRaises(ValueError): self.verify()

    def test_symlink_rejected(self):
        (self.root / 'link').symlink_to(self.root / 'case.json')
        with self.assertRaises(ValueError): self.verify()

    def test_empty_manifest_rejected(self):
        self.rows = []
        with self.assertRaises(ValueError): self.verify()

    def test_present_marker_is_hashed(self):
        self.rows.append((EMPTY_SHA256, 'case.json.sagemaker-uploaded'))
        (self.root / 'case.json.sagemaker-uploaded').write_bytes(b'')
        self.assertEqual(self.verify(False)['checkedFiles'], 2)


if __name__ == '__main__':
    unittest.main()
