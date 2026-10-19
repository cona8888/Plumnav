#!/usr/bin/env python3
import json
import math
from pathlib import Path
import unittest
import numpy as np
from scipy.integrate import solve_ivp
from lib.si_linear_response_audit import filtered_history,advance,response


def ode_reference(times,values,p):
    delay=math.pi*(p['tubeInnerDiameterMetres']/2)**2*p['tubeLengthMetres']/(p['flowLitresPerMinutePerChannel']/60000)
    window=p['averagingSeconds'];end=times[-1]
    if delay>=end:return np.zeros_like(times)
    # Entire history is reconstructed offline for an independent ODE check.
    # The online implementation is separately prefix-tested for causality.
    def rhs(t,y):
        u=float(np.interp(t-delay,times,values));tau=p['riseTimeConstantSeconds'] if u>=y[0] else p['recoveryTimeConstantSeconds']
        return [(u-y[0])/tau,y[0]]
    sol=solve_ivp(rhs,[delay,end],[0,0],method='DOP853',rtol=2e-12,atol=2e-13,max_step=min(np.diff(times))/4,dense_output=True);assert sol.success
    def read(ts,component):
        out=np.zeros_like(ts);mask=ts>delay;out[mask]=sol.sol(ts[mask])[component];return out
    return (read(times,1)-read(times-window,1))/window if window else read(times,0)


class LinearTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.fixtures=json.loads(Path('research/evidence/si_linear_component_2026-09-17/fixtures.json').read_text())['fixtures']

    def test_all_independent_ode_references(self):
        errors=[]
        for f in self.fixtures:
            r=np.array(f['rows']);expected=ode_reference(r[:,0],r[:,1],f['settings']);error=float(abs(expected-r[:,2]).max());errors.append(error)
            self.assertLess(error,2e-9,(f['kind'],error))
        print('Independent DOP853 maximum error:',max(errors),flush=True)

    def test_global_integral_auditor(self):
        errors=[]
        for f in self.fixtures:
            if f['kind']=='irregular':continue
            r=np.array(f['rows']);expected=filtered_history(r[:,0],np.repeat(r[:,1,None],4,axis=1),f['settings']);errors.append(float(abs(expected-r[:,2,None]).max()))
        self.assertLess(max(errors),1e-9);print('Independent cumulative-integral maximum error:',max(errors),flush=True)

    def test_asymmetric_crossing(self):
        crossing=.5*math.log(5);at=1-.5*crossing
        y,area=advance(0,1,-.5,.5,2,2)
        first=response(0,1,-.5,.5,crossing);last=response(at,at,-.5,2,2-crossing)
        self.assertAlmostEqual(first[0],at,places=12);self.assertAlmostEqual(y,last[0],places=12);self.assertAlmostEqual(area,first[1]+last[1],places=12)
        self.assertGreater(abs(y-response(0,1,-.5,.5,2)[0]),.01)

    def test_piecewise_linear_mesh_invariance(self):
        fs=[f for f in self.fixtures if f['kind']=='triangle-mesh'];a=np.array(fs[0]['rows'])
        for f in fs[1:]:self.assertLess(np.max(abs(a[:,2]-np.array(f['rows'])[::round(fs[0]['dt']/f['dt']),2])),1e-10)

    def test_tiny_interval(self):
        y,a=response(.4,.9,.2,2,1e-12);self.assertAlmostEqual(y,.4+.25e-12,places=15);self.assertLess(abs(a-.4e-12),1e-24)


if __name__=='__main__':unittest.main()
