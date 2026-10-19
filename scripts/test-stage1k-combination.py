#!/usr/bin/env python3
"""Additional rule-composition checks, not an empirical threshold-selection test."""
import copy
import itertools
import unittest
from unittest.mock import patch
from lib.si_stationary_dwell import evaluate


def old_result():
    return {'gates':dict(telemetry=True,clipped=False,complete=True,core=True,stable=True),
            'peak':dict(x=0.,y=0.),'rmse':.001,'eigenMax':-.1}


class CombinationTests(unittest.TestCase):
    def test_all_nine_state_combinations(self):
        for dwell,crossfit in itertools.product(['pass','reject','indeterminate'],repeat=2):
            with self.subTest(dwell=dwell,crossfit=crossfit),patch('lib.si_stationary_dwell.dwell_check',return_value={'state':dwell}),patch('lib.si_stationary_dwell.temporal_check',return_value={'state':crossfit}):
                result=evaluate([],old_result())
                expected='reject' if 'reject' in (dwell,crossfit) else 'indeterminate' if 'indeterminate' in (dwell,crossfit) else 'pass'
                self.assertEqual(result['temporalState'],expected)
                self.assertEqual(result['status']=='supported',expected=='pass')

    def test_non_temporal_gate_priority(self):
        for gate,value,reason in [('telemetry',False,'missing-channel-telemetry'),('clipped',True,'clipped-required-measurement'),('complete',False,'insufficient-samples'),('core',False,'insufficient-signal')]:
            old=old_result();old['gates'][gate]=value
            with self.subTest(gate=gate),patch('lib.si_stationary_dwell.dwell_check',return_value={'state':'reject'}),patch('lib.si_stationary_dwell.temporal_check',return_value={'state':'indeterminate'}):
                self.assertEqual(evaluate([],old)['reason'],reason)

    def test_spatial_gates_unchanged(self):
        for key,value,reason in [('rmse',.004,'spatial-model-mismatch'),('eigenMax',0.,'not-negative-definite'),('peak',dict(x=2.,y=0.),'maximum-outside-probed-region')]:
            old=old_result();old[key]=value
            with self.subTest(key=key),patch('lib.si_stationary_dwell.dwell_check',return_value={'state':'pass'}),patch('lib.si_stationary_dwell.temporal_check',return_value={'state':'pass'}):
                self.assertEqual(evaluate([],old)['reason'],reason)

    def test_real_dwell_rejection_resolves_unreliable_spatial_fit(self):
        visits=[{'closedAt':i*10+4,'samples':[dict(time=i*10+j,x=0.,y=0.,value=1.+j*.1) for j in range(5)]} for i in range(17)]
        result=evaluate(visits,old_result())
        self.assertEqual(result['dwell']['state'],'reject')
        self.assertEqual(result['crossfit']['state'],'indeterminate')
        self.assertEqual(result['reason'],'temporal-inconsistency')

    def test_original_decision_input_not_mutated(self):
        old=old_result();before=copy.deepcopy(old)
        with patch('lib.si_stationary_dwell.dwell_check',return_value={'state':'pass'}),patch('lib.si_stationary_dwell.temporal_check',return_value={'state':'pass'}):
            evaluate([],old)
        self.assertEqual(old,before)


if __name__=='__main__':
    unittest.main()
