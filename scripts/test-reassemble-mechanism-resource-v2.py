import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('transport', Path(__file__).with_name('reassemble-mechanism-resource-v2.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.parts = []
        for index, body in enumerate((b'abc', b'defg', b'h')):
            name = str(index)
            (self.root / name).write_bytes(body)
            self.parts.append((name, len(body), hashlib.sha256(body).hexdigest()))
        self.expected = hashlib.sha256(b'abcdefgh').hexdigest()

    def call(self, parts=None, digest=None):
        return transport.reassemble(self.root, self.root/'joined', self.parts if parts is None else parts,
                                    self.expected if digest is None else digest, 8)

    def test_exact_order_and_originals(self):
        self.assertTrue(self.call()['transportVerified'])
        self.assertEqual((self.root/'joined').read_bytes(), b'abcdefgh')
        self.assertTrue(all((self.root/p[0]).exists() for p in self.parts))

    def test_body_mismatch(self):
        (self.root/'1').write_bytes(b'xxxx')
        with self.assertRaises(ValueError): self.call()
        self.assertFalse((self.root/'joined').exists())

    def test_missing_part(self):
        (self.root/'2').unlink()
        with self.assertRaises(ValueError): self.call()

    def test_wrong_order(self):
        with self.assertRaises(ValueError): self.call(list(reversed(self.parts)))
        self.assertTrue((self.root/'joined').exists())

    def test_never_overwrite(self):
        (self.root/'joined').write_bytes(b'preserve')
        with self.assertRaises(ValueError): self.call()
        self.assertEqual((self.root/'joined').read_bytes(), b'preserve')

    def test_reject_symlink(self):
        (self.root/'0').rename(self.root/'original')
        (self.root/'0').symlink_to(self.root/'original')
        with self.assertRaises(ValueError): self.call()


if __name__ == '__main__': unittest.main()
