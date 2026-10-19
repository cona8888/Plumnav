"""Zero-AWS/zero-history resource transfer and audit-routing fixtures."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

ROOT=Path(__file__).resolve().parents[1]


def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


collector=module('collector',ROOT/'scripts/collect-mechanism-resource-v2.py')
audit=module('audit_download',ROOT/'scripts/audit-mechanism-resource-v2-download.py')
EXECUTION=ROOT/'aws/build/PlumeNav_mechanism_resource_20260930_v2_attempt01/execution'
sys.path.insert(0,str(EXECUTION))
runner=module('sealed_resource_runner',EXECUTION/'run.py')


class TransferFixtures(unittest.TestCase):
    def test_science_policy_and_worker_unchanged(self):
        old=ROOT/'aws/build/PlumeNav_mechanism_resource_20260929_v1_attempt02'
        new=ROOT/'aws/build/PlumeNav_mechanism_resource_20260930_v2_attempt01'
        for name in ('science.tar.gz','policy.tar.gz','archive_guard.py','bootstrap.py','entrypoint.sh'):
            self.assertEqual((old/'input'/name).read_bytes(),(new/'input'/name).read_bytes())
        for name in ('context.py','audit.py','one.py','resource_meter.py','worker_v4.mjs','worker_v4.ts'):
            self.assertEqual((old/'execution'/name).read_bytes(),(new/'execution'/name).read_bytes())

    def test_exact_manifest_matches_sealed_runner(self):
        doc=json.loads((ROOT/'aws/build/si-mechanism-preflight-candidate-20260925-v3/metadata/development_manifest.json').read_text())
        registry=SimpleNamespace(cases={r['id']:r for r in doc['cases']})
        self.assertEqual(collector.expected_payloads(),runner.required_payloads(registry))
        self.assertEqual(len(collector.expected_payloads()),1448)

    def test_audit_visits_every_history_and_exact_comparison(self):
        self.assertEqual({p:len(audit.scope(p)) for p in ('baseline','candidate','stress-a','stress-b')},
            {'baseline':45,'candidate':45,'stress-a':15,'stress-b':15})
        self.assertEqual(len(audit.markers()),120)
        self.assertEqual(sum(len(audit.scope(p)) for p in ('candidate','stress-a','stress-b')),75)
        self.assertTrue(all('mechanism-development-3000-' in row for row in audit.markers()))

    def test_job_scope(self):
        collector.validate_job_name('plumenav-mech-resource-v2-20260929-222000')
        for name in ('plumenav-mech-awsfirst-v2-20260928-232116','plumenav-mech-resource-v1-20260929-231407','campaign','../job',
            'plumenav-mech-resource-v2-20260929-222000/extra'):
            with self.assertRaises(ValueError): collector.validate_job_name(name)

    def test_streaming_hash(self):
        body=b'no scientific history\n'*100
        reader=collector.HashingReader(io.BytesIO(body)); got=[]
        while chunk:=reader.read(37): got.append(chunk)
        self.assertEqual(b''.join(got),body)
        self.assertEqual(reader.count,len(body))
        self.assertEqual(reader.hash.hexdigest(),hashlib.sha256(body).hexdigest())

    def test_transfer_paths(self):
        self.assertEqual(audit.transfer.safe('output/complete.json'),'output/complete.json')
        for name in ('/output/a','output/../a','other/a','output/a\\b','output//a'):
            with self.assertRaises(ValueError): audit.transfer.safe(name)


if __name__=='__main__': unittest.main()
