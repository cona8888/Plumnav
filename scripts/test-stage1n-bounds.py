#!/usr/bin/env python3
import copy
import gzip
import json
import math
from pathlib import Path
import unittest
import numpy as np
from lib.si_bounded_pose_v4 import rows,fit_envelope,evaluate as candidate,bounded_crossfit,bounded_dwell,whitened_row_bounds,gradient_map


def evaluate(visits,radius,**kwargs):
    return candidate(visits,radius,**{'observation_model':'fixed-orientation-local-quadratic','dwell_heading_span_radians':0.,**kwargs})


def fixture():
    xy=[[0.,0.]]
    for i in range(8):xy.extend([[math.cos(i*math.pi/4),math.sin(i*math.pi/4)],[0.,0.]])
    return [{'closedAt':i*20+4,'samples':[dict(x=x,y=y,time=i*20+j,value=.8-.05*(x*x+y*y),hit=True,clipped=False,telemetryComplete=True) for j in range(5)]} for i,(x,y) in enumerate(xy)]


class BoundTests(unittest.TestCase):
    def test_exact_quadratic(self):
        result=evaluate(fixture(),0.)
        self.assertEqual(result['status'],'supported');self.assertLess(result['relativePeakRadiusMetres'],1e-12)

    def test_small_jitter_admitted_without_true_pose(self):
        v=fixture();rng=np.random.default_rng(17)
        for visit in v:
            for s in visit['samples']:
                angle=rng.uniform(0,2*math.pi);s['x']+=.001*math.cos(angle);s['y']+=.001*math.sin(angle)
        self.assertEqual(evaluate(v,.0001)['status'],'supported')

    def test_unknown_bounds_and_heading_contract_fail_closed(self):
        for bound in [None,-1,float('nan'),float('inf')]:self.assertEqual(evaluate(fixture(),bound)['status'],'abstained')
        self.assertEqual(evaluate(fixture(),0.,observation_model='unknown-orientation')['status'],'abstained')
        self.assertEqual(candidate(fixture(),0.)['status'],'abstained')
        for heading in [None,.01,float('nan')]:self.assertEqual(evaluate(fixture(),0.,dwell_heading_span_radians=heading)['status'],'abstained')

    def test_rank_collapse_is_indeterminate(self):
        m=fit_envelope([[0,0]]*17,np.ones(17),.1);self.assertFalse(m['admitted'])

    def test_blank_and_clipping_priority(self):
        v=fixture()
        for visit in v:
            for s in visit['samples']:s['value']=0.;s['hit']=False
        self.assertEqual(evaluate(v,.001)['reason'],'insufficient-signal')
        v=fixture();v[0]['samples'][0]['clipped']=True
        self.assertEqual(evaluate(v,.001)['reason'],'clipped-required-measurement')

    def test_counterexample_ridge_is_not_supported(self):
        p=Path('research/results/si_reported_pose_pilot_2026-09-16/variants/physical-020.json.gz')
        r=json.loads(gzip.decompress(p.read_bytes()))['variants'][24]
        self.assertEqual(r['v2']['status'],'supported')
        result=evaluate(r['visits'],.01)
        self.assertEqual(result['status'],'abstained')

    def test_bounds_enclose_refitted_quadratics(self):
        rng=np.random.default_rng(81871)
        for _ in range(20):
            xy=np.array([[s['samples'][0][k] for k in ('x','y')] for s in fixture()])+rng.normal(0,.1,(17,2))
            beta=np.array([.8,.01,-.02,-.12,.003,-.10]);y=rows(xy)@beta+rng.uniform(-.0005,.0005,17)
            radius=rng.uniform(.0001,.01,17);m=fit_envelope(xy,y,radius);self.assertTrue(m['admitted'])
            for _ in range(25):
                angle=rng.uniform(0,2*np.pi,17);rad=radius*np.sqrt(rng.uniform(0,1,17))
                changed=xy+np.column_stack([rad*np.cos(angle),rad*np.sin(angle)])
                a=rows(changed);b=np.linalg.lstsq(a,y,rcond=None)[0];h=np.array([[b[3],b[4]],[b[4],b[5]]])
                self.assertLessEqual(np.linalg.norm(b-np.array(m['coefficients'])),m['coefficientRadius']+1e-12)
                self.assertLessEqual(np.sqrt(np.mean((a@b-y)**2)),m['rmseUpper']+1e-12)
                self.assertLessEqual(np.linalg.eigvalsh(h)[-1],m['eigenMaxUpper']+1e-12)
                if m['peakRadius'] is not None:
                    peak=-np.linalg.solve(h,b[1:3]);self.assertLessEqual(np.linalg.norm(peak-np.array(m['peak'])),m['peakRadius']+1e-12)

    def test_crossfit_bound_includes_training_perturbations(self):
        rng=np.random.default_rng(771)
        xy=np.array([[v['samples'][0][k] for k in ('x','y')] for v in fixture()])+rng.normal(0,.15,(17,2))
        y=rows(xy)@np.array([1.,.01,-.02,-.1,.005,-.1]);rho=.002
        result=bounded_crossfit(xy,y,rho)
        for pair in result['pairs']:
            if 'correction' not in pair:continue
            left,right=pair['centres'];training=pair['trainingVisits']
            for _ in range(100):
                angles=rng.uniform(0,2*np.pi,17);radii=rho*np.sqrt(rng.uniform(0,1,17));changed=xy+np.column_stack((radii*np.cos(angles),radii*np.sin(angles)))
                a=rows(changed);values=y[training]+rng.uniform(-.003,.003,15)
                beta=np.linalg.lstsq(a[training],values,rcond=None)[0];correction=(a[left]-a[right])@beta
                self.assertLessEqual(abs(correction-pair['correction']),pair['totalAllowance']+1e-12)

    def test_possible_hidden_motion_not_called_stationary(self):
        v=fixture();xy=np.array([[w['samples'][0][k] for k in ('x','y')] for w in v]);values=np.array([w['samples'][0]['value'] for w in v])
        model=fit_envelope(xy,values,.3);result=bounded_dwell(v,model,.3)
        self.assertEqual(result['state'],'indeterminate')

    def test_nonsteady_measurements_and_nonmutation(self):
        v=fixture();before=copy.deepcopy(v);evaluate(v,.0001);self.assertEqual(v,before)
        for visit in v:
            for j,s in enumerate(visit['samples']):s['value']+=.1*(j-2)
        self.assertEqual(evaluate(v,0.)['reason'],'measurement-inconsistency')


class WhitenedTests(unittest.TestCase):
    def test_whitened_row_bound_including_finite_quadratic_terms(self):
        rng=np.random.default_rng(55117)
        xy=rng.normal(0,1,(37,2))
        transform=np.linalg.inv(np.linalg.qr(rows(xy),mode='reduced')[1])
        radii=np.geomspace(1e-6,1.,37)
        bounds=whitened_row_bounds(xy,radii,transform)
        for _ in range(100):
            angle=rng.uniform(0,2*np.pi,37)
            delta=radii[:,None]*np.column_stack([np.cos(angle),np.sin(angle)])
            actual=np.linalg.norm((rows(xy+delta)-rows(xy))@transform,axis=1)
            self.assertTrue(np.all(actual<=bounds+1e-12))

    def test_flat_unsupported_peak_diagnostics_are_absent(self):
        xy=np.array([[v['samples'][0][k] for k in ('x','y')] for v in fixture()])
        for b in [np.array([1,0,0,-.1,0,0]),np.array([1,0,0,0,0,0])]:
            m=fit_envelope(xy,rows(xy)@b,.001)
            self.assertIsNone(m['peak'])
            self.assertIsNone(m['peakRadius'])
            self.assertIsNone(m['peakNormUpper'])

    def test_dwell_bounds_all_admitted_refit_gradients(self):
        rng=np.random.default_rng(66191)
        v=fixture();xy=np.array([[w['samples'][0][k] for k in ('x','y')] for w in v])
        y=rows(xy)@np.array([.8,.01,-.02,-.1,.01,-.12]);rho=.003
        for w,value in zip(v,y):
            for sample in w['samples']:sample['value']=float(value)
        model=fit_envelope(xy,y,rho);windows=bounded_dwell(v,model,rho)['windows']
        for _ in range(100):
            angle=rng.uniform(0,2*np.pi,17);rr=rho*np.sqrt(rng.uniform(0,1,17))
            changed=xy+np.column_stack([rr*np.cos(angle),rr*np.sin(angle)])
            beta=np.linalg.lstsq(rows(changed),y,rcond=None)[0]
            for i,p in enumerate(xy):
                directions=rng.uniform(0,2*np.pi,2)
                points=p+rho*np.column_stack([np.cos(directions),np.sin(directions)])
                self.assertLessEqual(abs(np.diff(rows(points)@beta)[0]),windows[i]['spatialChangeUpper']+1e-12)

    def test_old_v3_failures_are_development_regressions(self):
        for i in [68,69]:
            p=Path(f'research/results/si_bounded_pose_pilot_2026-09-16/variants/physical-{i:03d}.json.gz')
            r=json.loads(gzip.decompress(p.read_bytes()))['variants'][17]
            self.assertEqual(r['v3']['status'],'abstained')
            self.assertEqual(evaluate(r['visits'],.001)['status'],'supported')


if __name__=='__main__':unittest.main()
