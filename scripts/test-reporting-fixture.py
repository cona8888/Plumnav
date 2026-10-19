import copy
import hashlib
import math
import random
import tempfile
import unittest
from pathlib import Path
from lib.si_reporting_fixture import ReportingFixture, REPLICATES, canonical, transform, validate
from lib.si_reporting_fixture_audit import transform as audit_transform, check_observation
from lib.si_reported_pose import unit_errors, transform as original_transform

FIXTURE=Path('research/inputs/si_reporting_fixture_v1_2026-09-18/fixture.json')
SHA='c97ffc0f79bc407a91250781dec2cf41788c5478fef47c6373a135e816721f02'


def visits(coordinate=.123456789):
    return [dict(target=dict(x=i/100,y=-i/100),arrivedAt=20*i,closedAt=20*i+12,
        samples=[dict(time=20*i+8+j,x=coordinate+i/100,y=-coordinate-j/100,
            value=.2+j/1000,hit=True,clipped=False,telemetryComplete=True) for j in range(5)]) for i in range(17)]


def independent_vectors(replicate):
    rng=random.Random(1300101+replicate)
    draws=[rng.random() for _ in range(205)]
    angles=[2*math.pi*u for u in draws[2::2]]
    radii=[math.sqrt(u) for u in draws[1::2]]
    disks=[[r*math.cos(a),r*math.sin(a)] for r,a in zip(radii,angles)]
    return dict(direction=[math.cos(2*math.pi*draws[0]),math.sin(2*math.pi*draws[0])],
        visits=disks[:17],samples=[disks[17+5*i:22+5*i] for i in range(17)])


class ReportingFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.fixture=ReportingFixture(FIXTURE,SHA)

    def test_all_seed_generations(self):
        for r in REPLICATES:
            with self.subTest(replicate=r):
                self.assertEqual(self.fixture.vectors(r),unit_errors(r))
                self.assertEqual(self.fixture.vectors(r),independent_vectors(r))

    def test_known_seed_values(self):
        v=self.fixture.vectors(600300)
        self.assertEqual(v['direction'][1],-.7234738857861294)
        self.assertEqual(v['visits'][12][0],.7147933803173133)
        self.assertEqual(v['samples'][13][3][0],.5843409175756582)

    def test_every_seed_arm_and_arithmetic_fixture(self):
        for r in REPLICATES:
            for radius in [0.,.001]:
                for coordinate in [0.,-0.,1e-300,-1e-300,.123456789,-.123456789,1e15,-1e15]:
                    with self.subTest(replicate=r,radius=radius,coordinate=coordinate):
                        source=visits(coordinate);before=copy.deepcopy(source)
                        alt=dict(model='exact' if radius==0 else 'readout-jitter',amplitudeMetres=radius)
                        actual=transform(source,alt,r,self.fixture)
                        self.assertEqual(actual,audit_transform(source,alt,r,self.fixture))
                        old=original_transform(source,alt,r)
                        for v,o in zip(old['visits'],source): v['target']=o['target']
                        self.assertEqual(actual,old)
                        self.assertEqual(source,before)

    def test_wrong_hash(self):
        with self.assertRaises(ValueError): ReportingFixture(FIXTURE,'0'*64)

    def test_unknown_and_boolean_seed(self):
        for r in [600301,600416,True,600300.]:
            with self.subTest(seed=r),self.assertRaises(ValueError): self.fixture.vectors(r)

    def test_getter_cannot_mutate_fixture(self):
        v=self.fixture.vectors(600300);v['samples'][0][0][0]=999
        self.assertNotEqual(self.fixture.vectors(600300)['samples'][0][0][0],999)

    def test_invalid_amplitudes(self):
        for radius in [-.001,.002,float('nan'),float('inf'),True]:
            with self.subTest(radius=radius),self.assertRaises(ValueError):
                transform(visits(),dict(model='readout-jitter',amplitudeMetres=radius),600300,self.fixture)

    def test_invalid_model(self):
        with self.assertRaises(ValueError):transform(visits(),dict(model='visit-error',amplitudeMetres=.001),600300,self.fixture)

    def test_missing_windows_or_readouts(self):
        for missing in ['window','sample']:
            v=visits();v.pop() if missing=='window' else v[0]['samples'].pop()
            with self.subTest(missing=missing),self.assertRaises(ValueError):
                transform(v,dict(model='exact',amplitudeMetres=0.),600300,self.fixture)

    def test_reordered_windows_or_samples(self):
        for field in ['window','sample']:
            v=visits();v.reverse() if field=='window' else v[0]['samples'].reverse()
            with self.subTest(field=field),self.assertRaises(ValueError):
                transform(v,dict(model='exact',amplitudeMetres=0.),600300,self.fixture)

    def test_nonfinite_samples(self):
        v=visits();v[0]['samples'][0]['x']=float('nan')
        with self.assertRaises(ValueError):transform(v,dict(model='exact',amplitudeMetres=0.),600300,self.fixture)

    def test_changed_readings_timing_flags_and_coordinates_rejected(self):
        v=visits();alt=dict(model='readout-jitter',amplitudeMetres=.001)
        original=transform(v,alt,600300,self.fixture)
        for field,value in [('x',.9),('y',.9),('time',99),('value',.3),('hit',False),('clipped',True),('telemetryComplete',False)]:
            changed=copy.deepcopy(original);changed['visits'][0]['samples'][0][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):check_observation(v,alt,600300,self.fixture,changed)

    def test_changed_target_rejected(self):
        v=visits();alt=dict(model='exact',amplitudeMetres=0.)
        changed=transform(v,alt,600300,self.fixture);changed['visits'][0]['target']['x']=999
        with self.assertRaises(ValueError):check_observation(v,alt,600300,self.fixture,changed)

    def test_wrong_seed_reconstruction_rejected(self):
        v=visits();alt=dict(model='readout-jitter',amplitudeMetres=.001)
        changed=transform(v,alt,600400,self.fixture)
        with self.assertRaises(ValueError):check_observation(v,alt,600300,self.fixture,changed)

    def test_corrupt_or_permuted_fixture_rejected_by_pinned_hash(self):
        for swap in [False,True]:
            d=copy.deepcopy(self.fixture._data)
            if swap:d['replicates']['600300']['samples'][0].reverse()
            else:d['replicates']['600300']['samples'][0][0][0]=0.
            with tempfile.TemporaryDirectory() as tmp:
                p=Path(tmp)/'fixture.json';p.write_bytes(canonical(d))
                with self.subTest(swap=swap),self.assertRaises(ValueError):ReportingFixture(p,SHA)

    def test_shape_seed_and_vector_validation(self):
        for mode in ['seed','shape','nan','outside','direction']:
            d=copy.deepcopy(self.fixture._data);v=d['replicates']['600300']
            if mode=='seed':d['replicates'].pop('600300')
            elif mode=='shape':v['samples'][0].pop()
            elif mode=='nan':v['samples'][0][0][0]=float('nan')
            elif mode=='outside':v['samples'][0][0]=[1.,1.]
            else:v['direction']=[0.,0.]
            with self.subTest(mode=mode),self.assertRaises(ValueError):validate(d)


if __name__=='__main__':unittest.main()
