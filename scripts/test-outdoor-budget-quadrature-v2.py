#!/usr/bin/env python3
import importlib.util
import unittest
from pathlib import Path
from lib.outdoor_budget_quadrature_v2 import independent_concentration as segmented,log_age_reference

s=importlib.util.spec_from_file_location('old',Path(__file__).with_name('audit-outdoor-detectability.py'))
old=importlib.util.module_from_spec(s);s.loader.exec_module(old)


def field(wind):
    return dict(source=dict(x=50,y=50,z=.025),wind=dict(x=wind,y=0),diffusivity=.2,sigma=.25,rateKgPerSecond=1e-5)


class QuadratureTest(unittest.TestCase):
    def test_age_and_change_of_variable(self):
        for wind in [.5,2]:
            f=field(wind)
            for dx,dy in [(0,0),(.25,0),(1,0),(0,.25),(20,5),(40,0),(-5,1)]:
                row=dict(x=50+dx,y=50+dy,z=.05);previous=0
                for age in [1,10,100,600.125,1200.125,1626.125,2616.125,10000]:
                    a,b=segmented(row,f,age),log_age_reference(row,f,age)
                    self.assertLessEqual(abs(a-b),1e-9+abs(b)*1e-10)
                    self.assertGreaterEqual(a+1e-10,previous);previous=a

    def test_preserved_failure_and_old_nonmonotonicity(self):
        row=dict(x=50,y=50.25,z=.05);f=field(2)
        early=old.independent_concentration(row,f,1200.125)
        late=old.independent_concentration(row,f,2616.125)
        corrected=segmented(row,f,2616.125)
        self.assertGreater(early-late,.01)
        self.assertAlmostEqual(late,9.961616725710345,places=9)
        self.assertLess(abs(corrected-9.974220642343424),1e-5)
        self.assertAlmostEqual(segmented(row,f,1200.125),corrected,places=10)


if __name__=='__main__':unittest.main()
