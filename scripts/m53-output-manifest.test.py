"""Local regression for both observed service-side transfer marker states."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "output_manifest", Path(__file__).resolve().parents[1] / "aws/openfoam-transport/output_manifest.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ManifestTests(unittest.TestCase):
    def test_durable_files_only_across_transfer_states(self):
        with tempfile.TemporaryDirectory(prefix="m53-manifest-test-") as directory:
            root = Path(directory)
            nested = root / "case"
            nested.mkdir()
            data = nested / "m53-final.tsv"
            data.write_bytes(b"scientific evidence")
            (root / "runner.log").write_text("still being written")
            (root / "output-manifest.json").write_text("old manifest")
            expected = {"case/m53-final.tsv": hashlib.sha256(data.read_bytes()).hexdigest()}
            for suffix in (".sagemaker-uploading", ".sagemaker-uploaded"):
                marker = nested / (data.name + suffix)
                marker.write_text("service bookkeeping")
                self.assertEqual(module.collect_hashes(root), expected)
                marker.unlink()
            self.assertEqual(module.collect_hashes(root), expected)
            data.write_bytes(b"changed scientific evidence")
            self.assertNotEqual(module.collect_hashes(root), expected)


if __name__ == "__main__":
    unittest.main()
