#!/usr/bin/env python3
import copy
import unittest
from lib.outdoor_budget_statistics import exact_interval,summarise


def fixture():
    result=[]
    for world in range(2000,2128):
        j=world-2000
        for wind in [.5,2]:
            for speed in [.5,1]:
                end=int(990/speed+36);ms=[]
                for rate in [0,1e-4]:
                    early,late=(1,3) if rate==0 else (40,60)
                    for tau in [.5,5]:
                        a=100 if j<early else None;b=100 if j<early else 700 if j<late else None
                        ms.append(dict(sensor=dict(id=f'generic-sigma0.2-tau{tau:g}'),rateKgPerSecond=rate,
                            outcomes=[dict(budgetSeconds=cap,alarmSeconds=t,restrictedTimeSeconds=cap if t is None else t) for cap,t in [(600,a),(end,b)]]))
                result.append(dict(spec=dict(world=world,wind=wind,speed=speed,resolution=0),measurements=ms))
    return result


class StatisticsTest(unittest.TestCase):
    def test_boundary_uncertainty(self):
        lo,hi=exact_interval(0,128,.025);self.assertEqual(lo,0)
        self.assertAlmostEqual(hi,1-.0125**(1/128),places=14)
        lo,hi=exact_interval(128,128,.025);self.assertEqual(hi,1)
        self.assertAlmostEqual(lo,.0125**(1/128),places=14)
        with self.assertRaises(ValueError):exact_interval(0,0,.025)

    def test_known_paired_counts(self):
        s=summarise(fixture());self.assertEqual(s['primaryHistories'],512)
        self.assertEqual([p['lateAlarms'] for p in s['primary']],[20,2])
        self.assertEqual([p['difference'] for p in s['primary']],[20/128,2/128])
        self.assertEqual(len(s['groups']),16)
        r=next(x for x in s['groups'] if x['wind']==.5 and x['speed']==1 and x['sensor']=='generic-sigma0.2-tau0.5' and x['rateKgPerSecond']>0)
        self.assertEqual([b['alarmsWithMatchedBlankSilent'] for b in r['budgets']],[39,57])

    def test_incomplete_duplicate_or_nonmonotone_rejected(self):
        traces=fixture()
        with self.assertRaises(ValueError):summarise(traces[:-1])
        with self.assertRaises(ValueError):summarise(traces+[traces[0]])
        damaged=copy.deepcopy(traces);damaged[0]['measurements'][0]['outcomes'][1].update(alarmSeconds=None,restrictedTimeSeconds=2016)
        with self.assertRaises(ValueError):summarise(damaged)

    def test_development_worlds_rejected(self):
        traces=fixture()
        for t in traces:t['spec']['world']-=1800
        with self.assertRaises(ValueError):summarise(traces)


if __name__=='__main__':unittest.main()
