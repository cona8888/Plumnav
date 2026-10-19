#!/usr/bin/env python3
import copy
import gzip
import importlib.util
import json
import unittest
from pathlib import Path
from lib.si_bounded_pose_v4 import evaluate
from lib.si_integration_audit import audit

spec=importlib.util.spec_from_file_location('bridge','scripts/si-integration-bridge.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)


class IntegrationBridgeTests(unittest.TestCase):
    def setUp(self):
        r=json.loads(gzip.decompress(Path('research/evidence/si_head_motion_development_v2_2026-09-16/stationary.json.gz').read_bytes()))
        self.visits=r['headVisits']
        self.contract=dict(version='continuous-stationary-head-v1',basis='prescribed-numerical-constraint',scope='continuous-head-centre-and-orientation',windows=[dict(visit=i,start=v['arrivedAt'],end=v['closedAt'],translationDiameterMetres=0,orientationSpanRadians=0) for i,v in enumerate(self.visits)])

    def test_frozen_v4_parity_and_metadata(self):
        before=copy.deepcopy(self.visits)
        out=bridge.handle(dict(operation='verify',visits=self.visits,motionContract=self.contract,reportingReplicate=600031))
        for arm in out['arms']:
            obs=arm['observation']['visits']
            self.assertEqual(arm['decision']['candidate'],evaluate(obs,arm['poseRadiusMetres'],observation_model='fixed-orientation-local-quadratic',dwell_heading_span_radians=0.))
            self.assertEqual([v['target'] for v in obs],[v['target'] for v in before])
            for a,b in zip(obs,before):
                self.assertEqual(a['arrivedAt'],b['arrivedAt']);self.assertEqual(a['closedAt'],b['closedAt'])
                for x,y in zip(a['samples'],b['samples']):
                    for k in ['time','value','hit','clipped','telemetryComplete']:self.assertEqual(x[k],y[k])
        self.assertEqual(self.visits,before)

    def test_missing_contract_cannot_support(self):
        out=bridge.handle(dict(operation='verify',visits=self.visits,motionContract=None,reportingReplicate=600031))
        self.assertTrue(all(not a['decision']['admitted'] for a in out['arms']))

    def test_unknown_operation_rejected(self):
        with self.assertRaises(ValueError):bridge.handle(dict(operation='source-truth'))

    def development(self):
        return json.loads(gzip.decompress(Path('research/evidence/si_integration_development_v2_2026-09-16/case-1.json.gz').read_bytes()))

    def test_independent_blank_history_passes(self):
        self.assertTrue(audit(self.development())['passed'])

    def test_altered_body_path_rejected(self):
        r=self.development();r['navigation'][10]['position']['x']+=.01
        with self.assertRaises(AssertionError):audit(r)

    def test_native_rule_cannot_become_research_outcome(self):
        r=self.development();r['navigation'][10]['decision']['nativeTerminated']=True
        with self.assertRaises(AssertionError):audit(r)

    def test_private_noise_contamination_rejected(self):
        r=self.development();r['trace'][64][20]+=.01
        with self.assertRaises(AssertionError):audit(r)


if __name__=='__main__':unittest.main()
