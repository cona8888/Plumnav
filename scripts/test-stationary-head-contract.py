#!/usr/bin/env python3
import copy,gzip,json,math,unittest
from pathlib import Path
import numpy as np
from lib.si_stationary_head_contract import evaluate,check_contract
from lib.si_bounded_pose_v4 import evaluate as v4
from lib.si_reported_pose import transform


def declared_stationary(visits):
    return dict(version='continuous-stationary-head-v1',basis='prescribed-numerical-constraint',scope='continuous-head-centre-and-orientation',
                windows=[dict(visit=i,start=v['arrivedAt'],end=v['closedAt'],translationDiameterMetres=0.,orientationSpanRadians=0.) for i,v in enumerate(visits)])


class StationaryContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root=Path('research/evidence/si_head_motion_development_v2_2026-09-16')
        cls.stationary=json.loads(gzip.decompress((root/'stationary.json.gz').read_bytes()))
        cls.moving=json.loads(gzip.decompress((root/'moving.json.gz').read_bytes()))

    def setUp(self):
        self.visits=copy.deepcopy(self.stationary['headVisits']);self.contract=declared_stationary(self.visits)

    def test_missing_information_fails_closed(self):
        self.assertEqual(evaluate(self.visits,0.)['reason'],'continuous-motion-information-unavailable')

    def test_admitted_exact_output_unchanged(self):
        result=evaluate(self.visits,0.,motion_contract=self.contract)
        self.assertTrue(result['admitted']);self.assertEqual(result['status'],'supported')
        self.assertEqual(result['candidate'],v4(self.visits,0.,observation_model='fixed-orientation-local-quadratic',dwell_heading_span_radians=0.))

    def test_admitted_jitter_does_not_imply_physical_motion(self):
        obs=transform(self.visits,dict(model='readout-jitter',amplitudeMetres=.001),31)['visits']
        result=evaluate(obs,.001,motion_contract=self.contract)
        self.assertTrue(result['admitted'])
        self.assertEqual(result['candidate'],v4(obs,.001,observation_model='fixed-orientation-local-quadratic',dwell_heading_span_radians=0.))

    def test_gas_clock_only_coverage_rejected(self):
        self.contract['windows'][0]['start']=self.visits[0]['samples'][0]['time']
        self.assertEqual(check_contract(self.visits,self.contract),'incomplete-continuous-motion-coverage')

    def test_nonzero_motion_not_tuned_to_small_tolerance(self):
        for key in ['translationDiameterMetres','orientationSpanRadians']:
            for value in [1e-15,.02,math.pi/6]:
                c=copy.deepcopy(self.contract);c['windows'][0][key]=value
                self.assertEqual(check_contract(self.visits,c),'continuous-stationarity-not-established')

    def test_invalid_bounds_rejected(self):
        for value in [None,float('nan'),float('inf'),-.01,True,'0']:
            c=copy.deepcopy(self.contract);c['windows'][0]['translationDiameterMetres']=value
            self.assertEqual(check_contract(self.visits,c),'invalid-continuous-motion-bound')

    def test_missing_reordered_or_invalid_windows(self):
        for operation in ['missing','reordered','end']:
            c=copy.deepcopy(self.contract)
            if operation=='missing':c['windows'].pop()
            elif operation=='reordered':c['windows'][0],c['windows'][1]=c['windows'][1],c['windows'][0]
            else:c['windows'][0]['end']=float('nan')
            self.assertEqual(check_contract(self.visits,c),'incomplete-continuous-motion-coverage')

    def test_stop_command_and_claimed_hardware_not_accepted_bases(self):
        for basis in ['stop-command','1Hz-pose-samples','hardware-certificate']:
            c=copy.deepcopy(self.contract);c['basis']=basis
            self.assertEqual(check_contract(self.visits,c),'unsupported-continuous-motion-contract')

    def test_stationary_development_trajectory_over_whole_dwell(self):
        tr=np.array(self.stationary['trace'])
        for v in self.visits:
            rows=tr[(tr[:,0]>=v['arrivedAt'])&(tr[:,0]<=v['closedAt'])]
            self.assertLess(float(np.max(np.ptp(rows[:,2:8],axis=0))),1e-12)

    def test_aliasing_does_not_establish_stationarity(self):
        visits=self.moving['headVisits'];tr=np.array(self.moving['trace'])
        retained=tr[[round(s['time']/.0625) for v in visits for s in v['samples']]]
        self.assertLess(float(np.max(abs(retained[:,5:7]))),1e-12)
        self.assertGreater(float(np.max(np.linalg.norm(tr[:,5:7],axis=1))),.0099)
        result=evaluate(visits,0.)
        self.assertFalse(result['admitted']);self.assertEqual(result['status'],'abstained')

    def test_truthful_moving_contract_rejected(self):
        visits=self.moving['headVisits'];c=declared_stationary(visits)
        for w in c['windows']:w['translationDiameterMetres']=.02
        self.assertEqual(evaluate(visits,0.,motion_contract=c)['reason'],'continuous-stationarity-not-established')

    def test_false_zero_premise_cannot_be_detected_from_contract(self):
        visits=self.moving['headVisits']
        # Negative capability test: the wrapper is not an observer of hidden truth.
        # Such a falsely labelled run must be rejected by the experiment audit.
        self.assertTrue(evaluate(visits,0.,motion_contract=declared_stationary(visits))['admitted'])


if __name__=='__main__':unittest.main()
