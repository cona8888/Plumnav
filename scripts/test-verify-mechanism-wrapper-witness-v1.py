"""Terminal verifier correctness fixtures; no AWS calls or numerical missions."""
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
import zipfile
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('witness_terminal',Path(__file__).with_name('verify-mechanism-wrapper-witness-v1.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
ACCEPTED=ROOT/'research/results/si_mechanism_resource_independent_audit_v2_terminal_acceptance_attempt01_2026-09-30'
PACKAGE=ROOT/'aws/build/si-mechanism-campaign-sealed-v3-attempt01-20260930'


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.dir=Path(self.tmp.name)

    def runtime(self):
        return dict(python='3.12.13',numpy='1.26.4',scipy='1.16.3',node='v20.19.6',architecture='x86_64',cpus=48,
            threadSettings={k:'1' for k in ('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS')},
            threadpoolInfo=[dict(num_threads=1)],executionWrapper=dict(bootstrapSha256=m.BOOTSTRAP_SHA,
            bundleSha256='b'*64,releaseSha256='a'*64,executionMode='development'))

    def done(self):
        return dict(completed=True,executionMode='development',histories=3,worlds=1,reservedWorldsExecuted=0,
            allProducerFullAuditsPassed=True,refinementTripletsAudited=False,scientificallyAccepted=False,
            independentDownloadedAuditRequired=True,manifestSha256=m.DEV_SHA,releaseSha256='a'*64)

    def test_actual_dependency_pins(self):self.assertEqual(len(m.source_dependencies()),3)

    def test_exact_transfer_membership_53_bodies(self):
        helper,collector,_=m.source_dependencies()
        routing=m.load(PACKAGE/'project/aws/mechanism-campaign-v1/audit-index.json')
        self.assertEqual(len(m.expected_members(collector.expected_payloads(routing,'wrapper-witness'))),53)

    def test_pinned_runtime_fixture(self):m.runtime_and_completion(self.runtime(),self.done(),'a'*64,'b'*64)

    def test_arm_runtime_rejected(self):
        r=self.runtime();r['architecture']='arm64'
        with self.assertRaises(ValueError):m.runtime_and_completion(r,self.done(),'a'*64,'b'*64)

    def test_wrong_numpy_rejected(self):
        r=self.runtime();r['numpy']='2.3.4'
        with self.assertRaises(ValueError):m.runtime_and_completion(r,self.done(),'a'*64,'b'*64)

    def test_oversubscribed_threads_rejected(self):
        r=self.runtime();r['threadpoolInfo'][0]['num_threads']=2
        with self.assertRaises(ValueError):m.runtime_and_completion(r,self.done(),'a'*64,'b'*64)

    def test_wrong_mounted_bootstrap_rejected(self):
        r=self.runtime();r['executionWrapper']['bootstrapSha256']='f'*64
        with self.assertRaises(ValueError):m.runtime_and_completion(r,self.done(),'a'*64,'b'*64)

    def test_campaign_mode_rejected(self):
        r=self.runtime();r['executionWrapper']['executionMode']='campaign'
        with self.assertRaises(ValueError):m.runtime_and_completion(r,self.done(),'a'*64,'b'*64)

    def test_reserved_world_rejected(self):
        d=self.done();d['reservedWorldsExecuted']=1
        with self.assertRaises(ValueError):m.runtime_and_completion(self.runtime(),d,'a'*64,'b'*64)

    def test_bool_count_rejected(self):
        for key in ('histories','worlds','reservedWorldsExecuted'):
            d=self.done();d[key]=True
            with self.assertRaises(ValueError):m.runtime_and_completion(self.runtime(),d,'a'*64,'b'*64)

    def test_science_claim_rejected(self):
        d=self.done();d['scientificallyAccepted']=True
        with self.assertRaises(ValueError):m.runtime_and_completion(self.runtime(),d,'a'*64,'b'*64)

    def test_no_triplet_claim(self):
        d=self.done();d['refinementTripletsAudited']=True
        with self.assertRaises(ValueError):m.runtime_and_completion(self.runtime(),d,'a'*64,'b'*64)

    def test_array_float_fixture(self):
        path=self.dir/'arrays.npz';np.savez(path,positions=np.zeros((2,2)),scalar=np.ones(2))
        self.assertEqual(set(m.arrays(path)),{'positions','scalar'})

    def test_array_nonfinite_rejected(self):
        path=self.dir/'arrays.npz';np.savez(path,positions=np.array([[float('nan'),0.]]),scalar=np.ones(1))
        with self.assertRaises(ValueError):m.arrays(path)

    def test_array_extra_member_rejected(self):
        path=self.dir/'arrays.npz';np.savez(path,positions=np.zeros((2,2)),scalar=np.ones(2),extra=np.ones(1))
        with self.assertRaises(ValueError):m.arrays(path)

    def test_array_object_rejected(self):
        path=self.dir/'arrays.npz';np.savez(path,positions=np.array([object()],dtype=object),scalar=np.ones(1))
        with self.assertRaises(ValueError):m.arrays(path)

    def test_strict_history_fixture(self):
        path=self.dir/'history.gz';path.write_bytes(gzip.compress(b'{"value":1}'))
        self.assertEqual(m.strict_history(path),{'value':1})

    def test_duplicate_history_key_rejected(self):
        path=self.dir/'history.gz';path.write_bytes(gzip.compress(b'{"value":1,"value":2}'))
        with self.assertRaises(ValueError):m.strict_history(path)

    def test_nonfinite_history_rejected(self):
        path=self.dir/'history.gz';path.write_bytes(gzip.compress(b'{"value":NaN}'))
        with self.assertRaises(ValueError):m.strict_history(path)

    def test_actual_failed_mac_reference_refused_before_output(self):
        failed=ROOT/'research/results/si_mechanism_resource_v2_download_audit_attempt01_2026-09-30/verification.json'
        args=types.SimpleNamespace(resource_accepted=failed,resource_terminal=ACCEPTED/'terminal-verification.json',
            resource_terminal_sha256=m.sha(ACCEPTED/'terminal-verification.json'),destination=self.dir/'no-output')
        with self.assertRaises(ValueError):m.verify(args)
        self.assertFalse(args.destination.exists())

    def test_actual_sealed_release_resource_admission(self):
        release=m.load(PACKAGE/'project/metadata/campaign-release.json')
        resources=m.admitted_release_from_archive(PACKAGE/'input/campaign.tar.gz',release,
            m.load(ACCEPTED/'accepted-resource-verification.json'),m.load(ACCEPTED/'terminal-verification.json'))
        self.assertEqual(resources['workers'],24)

    def test_different_actual_reference_rejected(self):
        release=m.load(PACKAGE/'project/metadata/campaign-release.json')
        a=m.load(ACCEPTED/'accepted-resource-verification.json');a['accepted']=False
        with self.assertRaises(ValueError):m.admitted_release_from_archive(PACKAGE/'input/campaign.tar.gz',release,a,
            m.load(ACCEPTED/'terminal-verification.json'))

    def test_no_paid_or_numeric_execution(self):
        source=Path(m.__file__).read_text()
        for forbidden in ('boto3','create_processing_job(', 'put_object(', 'subprocess.', 'full_audit('):
            self.assertNotIn(forbidden,source)


if __name__=='__main__':unittest.main()
