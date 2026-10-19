"""Synthetic terminal-verifier components; no full-audit or AWS acceptance."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('verify',Path(__file__).with_name('verify-mechanism-resource-independent-audit-v2.py'))
v=importlib.util.module_from_spec(s);s.loader.exec_module(v)
s=importlib.util.spec_from_file_location('strict_comparator',v.POLICY/'mechanism_portability_candidate_v1.py')
cmp=importlib.util.module_from_spec(s);s.loader.exec_module(cmp)


class VerificationFixtures(unittest.TestCase):
    def setUp(self):
        self.value=dict(accepted=True,independentDownloadedAuditPassed=True,job=v.PRODUCER_JOB,
            archiveSha256=v.PRODUCER_TAR_SHA,sourceScriptSha256=v.IMPORTER_SHA,
            outputObjects=1449,outputBytes=123,exactComparisons=75,productionAdmitted=False,
            performanceEvidence=False,newMissions=0,reservedWorldsExecuted=0,awsCalls=0,
            independentAudits=[dict(phase=p,caseId=cid,historySha256='a'*64,passed=True)
                               for p,cid in sorted(v.audit_identities())])

    def test_full_120_identity_allocation(self):
        rows=v.check_verification(self.value,123)
        self.assertEqual(len(rows),120)
        self.assertEqual({p:sum(key[0]==p for key in rows) for p in ('baseline','candidate','stress-a','stress-b')},
                         dict(baseline=45,candidate=45,**{'stress-a':15,'stress-b':15}))

    def test_duplicate_or_missing_coverage_rejected(self):
        self.value['independentAudits'][1]=self.value['independentAudits'][0]
        with self.assertRaisesRegex(ValueError,'120-history'):v.check_verification(self.value,123)

    def test_rejected_original_audit_never_promoted(self):
        self.value['accepted']=False
        with self.assertRaisesRegex(ValueError,'scope'):v.check_verification(self.value,123)

    def test_wrong_rule_or_evidence_rejected(self):
        for key,value in (('sourceScriptSha256','b'*64),('exactComparisons',74),('reservedWorldsExecuted',1),
                          ('productionAdmitted',True),('archiveSha256','b'*64),('outputBytes',124)):
            d=copy.deepcopy(self.value);d[key]=value
            with self.assertRaisesRegex(ValueError,'scope'):v.check_verification(d,123)

    def test_actual_verifier_dependencies_unchanged(self):
        for name,h in v.PINS.items():self.assertEqual(v.sha(ROOT/name),h)

    def test_real_saved_producer_tar_is_not_independent_audit_output(self):
        archive=ROOT/'research/results/si_mechanism_resource_v2_transfer_attempt01_2026-09-30/plumenav-mech-resource-v2-20260930-050952-terminal.tar'
        self.assertTrue(archive.is_file(),'Preserved producer evidence required for this fixture')
        s=importlib.util.spec_from_file_location('collector_fixture',ROOT/'scripts/collect-mechanism-resource-independent-audit-v2.py')
        collector=importlib.util.module_from_spec(s);s.loader.exec_module(collector)
        with self.assertRaisesRegex(ValueError,'Exact transfer TAR membership'):
            v.inspect_tar(archive,v.expected_members(collector.expected_payloads()))


class TransportFixtures(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.tree=self.root/'tree';self.tree.mkdir()
        data={'output/value.json':b'{"value":1}'}
        hashes={n:hashlib.sha256(raw).hexdigest() for n,raw in data.items()}
        data['provenance/collection-hashes.json']=json.dumps(dict(hashes=hashes)).encode()
        self.wanted=set(data);self.archive=self.root/'saved.tar'
        with tarfile.open(self.archive,'x') as t:
            for name,raw in data.items():
                info=tarfile.TarInfo(name);info.size=len(raw);t.addfile(info,io.BytesIO(raw))
                path=self.tree/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
        self.sha=v.sha(self.archive)

    def test_every_body_bound_to_saved_tar(self):
        h=v.verify_transport(self.tree,self.archive,self.wanted,self.sha)
        self.assertEqual(set(h),{'output/value.json'})

    def test_wrong_archive_hash_rejected(self):
        with self.assertRaisesRegex(ValueError,'archive hash'):
            v.verify_transport(self.tree,self.archive,self.wanted,'b'*64)

    def test_changed_saved_body_rejected(self):
        (self.tree/'output/value.json').write_bytes(b'{"value":2}')
        with self.assertRaisesRegex(ValueError,'body differs'):
            v.verify_transport(self.tree,self.archive,self.wanted,self.sha)

    def test_extra_file_rejected(self):
        (self.tree/'output/extra').write_bytes(b'')
        with self.assertRaisesRegex(ValueError,'tree membership'):
            v.verify_transport(self.tree,self.archive,self.wanted,self.sha)

    def test_symlink_body_rejected(self):
        target=self.tree/'output/value.json';target.rename(self.root/'value.saved')
        target.symlink_to(self.root/'value.saved')
        with self.assertRaisesRegex(ValueError,'Symlinked'):
            v.verify_transport(self.tree,self.archive,self.wanted,self.sha)

    def test_tar_duplicate_and_link_rejected(self):
        for kind in ('duplicate','symlink'):
            path=self.root/(kind+'.tar')
            with tarfile.open(path,'x') as t:
                m=tarfile.TarInfo('output/value.json');m.size=0
                if kind=='symlink':m.type=tarfile.SYMTYPE;m.linkname='/etc/passwd'
                t.addfile(m,io.BytesIO(b''))
                if kind=='duplicate':t.addfile(m,io.BytesIO(b''))
            with self.assertRaises(ValueError):v.inspect_tar(path,{'output/value.json'})


class PairFixtures(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.p=self.root/'producer';self.i=self.root/'independent'
        delivery=json.loads((v.SCIENCE/'delivery.json').read_text())
        dev=json.loads((v.SCIENCE/delivery['manifest']['path']).read_text())
        self.case=dev['cases'][0];self.cid=self.case['id'];self.phase='baseline'
        history=self.p/'runs/baseline/cases'/self.cid/'mission.json.gz'
        history.parent.mkdir(parents=True);history.write_bytes(b'Synthetic binding fixture, not a numerically audited raw history')
        self.h=v.sha(history)
        field=self.case['spec']['field']
        meta=dict(auditPassed=True,field=field,stage='no-eligible-nomination',nominationPresent=False,
            nominalStatus=None,reportedPointPresent=False,sourceErrorMetres=None)
        self.folders=[self.p/'runs/baseline/audits',self.i/'independent-audit/runs/baseline/audits']
        for folder in self.folders:
            folder.mkdir(parents=True)
            array=folder/(self.cid+'-arrays.npz');np.savez_compressed(array,positions=np.full((17,2),.5),scalar=np.zeros(2))
            d=dict(details=dict(passed=True,errors=dict(residual=0.)),guard=dict(fixture=True),
                compact=dict(spec=self.case['spec']),extracted=dict(metadata=meta,endpoint=v.endpoint(meta)),
                historySha256=self.h,arraysSha256=v.sha(array),referenceComparison=None)
            dp=folder/(self.cid+'-diagnostics.json');dp.write_text(json.dumps(d))
            r=dict(passed=True,detailsPassed=True,caseId=self.cid,case=self.case,
                historySha256=self.h,manifestSha256='666126c63b3d9e4cd6686320ed8c6a49a643bd1783ac8e09aaa408cc6db49946',
                diagnosticsSha256=v.sha(dp),arraysSha256=v.sha(array),referenceComparison=None)
            (folder/(self.cid+'.json')).write_text(json.dumps(r))

    def pair(self):
        return v.check_pair(self.p,self.i,self.phase,self.cid,self.case,dict(historySha256=self.h),cmp.compare)

    def change_diagnostic(self,fn):
        folder=self.folders[1];dp=folder/(self.cid+'-diagnostics.json');d=v.load(dp);fn(d)
        dp.write_text(json.dumps(d));rp=folder/(self.cid+'.json');r=v.load(rp)
        r['diagnosticsSha256']=v.sha(dp);rp.write_text(json.dumps(r))

    def test_pair_all_body_and_case_bindings(self):
        result=self.pair();self.assertTrue(result['passed']);self.assertEqual(result['historySha256'],self.h)

    def test_rounding_difference_still_rejected_after_rehash(self):
        self.change_diagnostic(lambda d:d['details']['errors'].update(residual=1e-19))
        with self.assertRaisesRegex(ValueError,'diagnostics differ'):self.pair()

    def test_signed_zero_difference_rejected(self):
        self.change_diagnostic(lambda d:d['details']['errors'].update(residual=-0.))
        with self.assertRaisesRegex(ValueError,'diagnostics differ'):self.pair()

    def test_endpoint_change_rejected(self):
        self.change_diagnostic(lambda d:d['extracted']['endpoint'].update(success=True))
        with self.assertRaisesRegex(ValueError,'endpoint identity'):self.pair()

    def test_wrong_case_receipt_rejected(self):
        rp=self.folders[1]/(self.cid+'.json');r=v.load(rp);r['caseId']='other';rp.write_text(json.dumps(r))
        with self.assertRaisesRegex(ValueError,'case-history'):self.pair()

    def test_array_change_even_after_correct_rehash_rejected(self):
        folder=self.folders[1];ap=folder/(self.cid+'-arrays.npz')
        np.savez_compressed(ap,positions=np.full((17,2),.5),scalar=np.array([0.,1.]))
        self.change_diagnostic(lambda d:d.update(arraysSha256=v.sha(ap)))
        rp=folder/(self.cid+'.json');r=v.load(rp);r['arraysSha256']=v.sha(ap);rp.write_text(json.dumps(r))
        with self.assertRaisesRegex(ValueError,'arrays differ'):self.pair()


if __name__=='__main__':unittest.main()
