"""Synthetic transfer-security tests, never science or AWS execution."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('collector','aws/download_stage2i_smoke.py')
collector=importlib.util.module_from_spec(spec);spec.loader.exec_module(collector)


class TransferTests(unittest.TestCase):
    def test_collector_scope(self):
        self.assertEqual(collector.safe_relative(collector.PREFIX+'output/worker-0/case-000.json.gz'),'worker-0/case-000.json.gz')
        for key in ['other/output/x',collector.PREFIX+'output/../outside',collector.PREFIX+'output//outside',collector.PREFIX+'output/']:
            with self.assertRaises(AssertionError):collector.safe_relative(key)

    def exercise(self, mutation=None):
        payload=b'fixture-not-scientific-data'
        digest=hashlib.sha256(payload).hexdigest()
        files={'output/payload':payload,'output/SHA256SUMS':f'{digest}  payload\n'.encode()}
        objects=[dict(relative=k.removeprefix('output/'),bytes=len(v)) for k,v in files.items()]
        index=dict(job=collector.JOB,objects=objects)
        if mutation=='wrong-job':index['job']='another-job'
        if mutation=='wrong-size':index['objects'][0]['bytes']+=1
        files['provenance/s3-index.json']=json.dumps(index).encode()
        if mutation=='extra-payload':files['output/unmanifested']=b'x'
        if mutation=='bad-payload':files['output/payload']=b'corrupted'
        if mutation=='traversal':files['output/../../outside']=b'x'
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);archive=root/'input.tar'
            with tarfile.open(archive,'w') as t:
                for name,body in files.items():
                    i=tarfile.TarInfo(name);i.size=len(body);t.addfile(i,io.BytesIO(body))
                if mutation=='symlink':
                    i=tarfile.TarInfo('output/link');i.type=tarfile.SYMTYPE;i.linkname='../outside';t.addfile(i)
            checksum=hashlib.sha256(archive.read_bytes()).hexdigest()
            if mutation=='bad-archive-hash':checksum='0'*64
            result=subprocess.run([sys.executable,'scripts/import-stage2i-smoke.py','--archive',str(archive),
                '--sha256',checksum,'--destination',str(root/'import')],capture_output=True,text=True)
            self.assertFalse((root/'outside').exists())
            return result

    def test_valid_transfer(self):
        r=self.exercise();self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(json.loads(r.stdout)['objectCount'],2)

    def test_invalid_transfers(self):
        for m in ['wrong-job','wrong-size','extra-payload','bad-payload','traversal','symlink','bad-archive-hash']:
            with self.subTest(m=m):self.assertNotEqual(self.exercise(m).returncode,0)


if __name__=='__main__':unittest.main()
