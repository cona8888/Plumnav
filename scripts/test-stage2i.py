import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from lib.si_response_reporting_fixture import REPLICATES, ReportingFixture, canonical, validate, transform
from lib.si_reporting_fixture_audit import transform as independent_transform
from lib.si_response_statistics import summarize
from lib.si_scheduling_statistics import ARMS, BINARY, CONTINUOUS


def fixture_data():
    vectors=dict(direction=[1.,0.],visits=[[0.,0.] for _ in range(17)],samples=[[[.3,.4] for _ in range(5)] for _ in range(17)])
    return dict(version='fixed-reporting-fixture-v1',offsetMetres=.1,amplitudesMetres=[0.,.001],replicates={str(r):copy.deepcopy(vectors) for r in REPLICATES},
                generator=dict(sourceSha256='a'*64,planSha256='b'*64,python='test',platform='test',uniformDrawsPerReplicate=205,seedOffset=1300101))


def records():
    out=[]
    for w in range(32):
        for field in ['si-continuous','si-pulse','blank']:
            for method,policy in ARMS:
                for scale in [1,2]:
                    out.append(dict(spec=dict(index=len(out),studyId='scheduling-response-replication-v1',caseRole='primary',worldIndex=w,field=field,method=method,policy=policy,responseScale=scale,navDt=1/64),metrics={**{k:False for k in BINARY},**{k:600. for k in CONTINUOUS}},summary=dict(errors=[])))
    return out


class ResponseTests(unittest.TestCase):
    def test_fixture_inventory(self):
        self.assertEqual(len(REPLICATES),49)
        validate(fixture_data())
    def test_fixture_missing_replicate(self):
        x=fixture_data();x['replicates'].pop('600731')
        with self.assertRaises(ValueError):validate(x)
    def test_fixture_invalid_vector(self):
        x=fixture_data();x['replicates']['600700']['samples'][0][0]=[2.,0.]
        with self.assertRaises(ValueError):validate(x)
    def test_fixture_hash_and_arithmetic(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'fixture.json';body=canonical(fixture_data());path.write_bytes(body)
            fixture=ReportingFixture(path,hashlib.sha256(body).hexdigest())
            with self.assertRaises(ValueError):ReportingFixture(path,'0'*64)
            with self.assertRaises(ValueError):fixture.vectors(600799)
            visits=[dict(target=dict(x=0.,y=0.),samples=[dict(x=.123,y=-.3,time=i*5+j,value=.4) for j in range(5)]) for i in range(17)]
            alternative=dict(model='readout-jitter',amplitudeMetres=.001)
            self.assertEqual(transform(visits,alternative,600731,fixture),independent_transform(visits,alternative,600731,fixture))
    def test_copy_only_changes_replicate_inventory(self):
        old=Path('scripts/lib/si_reporting_fixture.py').read_text()
        expected=old.replace('REPLICATES = [600300, *range(600400, 600416)]','REPLICATES = [600300, *range(600400, 600416), *range(600700, 600732)]')
        self.assertEqual(expected,Path('scripts/lib/si_response_reporting_fixture.py').read_text())
    def test_exact_matrix_and_zero_uncertainty(self):
        x=summarize(records(),[1,2])
        self.assertEqual(x['primaryMissions'],768)
        self.assertEqual(len(x['arms']),24)
        self.assertGreater(x['arms'][0]['binary']['encounter']['wilson95'][1],0)
        self.assertTrue(x['schedulingContrasts'][0]['metrics']['encounter']['empiricalIntervalDegenerate'])
    def test_missing_case_rejected(self):
        with self.assertRaises(AssertionError):summarize(records()[:-1],[1,2])
    def test_duplicate_rejected(self):
        x=records();x[-1]=x[0]
        with self.assertRaises(AssertionError):summarize(x,[1,2])
    def test_wrong_resolution_rejected(self):
        x=records();x[0]['spec']['navDt']=1/32
        with self.assertRaises(AssertionError):summarize(x,[1,2])
    def test_nonboolean_rejected(self):
        x=records();x[0]['metrics']['encounter']=1
        with self.assertRaises(AssertionError):summarize(x,[1,2])
    def test_nonfinite_rejected(self):
        x=records();x[0]['metrics']['airLitres']=float('nan')
        with self.assertRaises(AssertionError):summarize(x,[1,2])
    def test_witnesses_do_not_change_statistics(self):
        x=records();w=copy.deepcopy(x[0]);w['spec']['caseRole']='resolution-witness'
        self.assertEqual(summarize(x,[1,2]),summarize(x+[w],[1,2]))
    def test_local_maximum_is_not_release_success(self):
        x=records();x[0]['metrics']['supportedExact']=True
        x[0]['summary']['errors']=[dict(poseRadiusMetres=0,reportedPoint=dict(x=0,y=0),sourceErrorMetres=.164)]
        r=summarize(x,[1,2])['arms'][0]
        self.assertEqual(r['binary']['supportedExact']['successes'],1)
        self.assertEqual(r['binary']['supportedReleaseWithinPointOne']['successes'],0)
    def test_fallback_matrix(self):
        x=summarize([r for r in records() if r['spec']['responseScale']==1],[1])
        self.assertEqual(x['primaryMissions'],384);self.assertEqual(x['responseContrasts'],[])


if __name__=='__main__':unittest.main()
