#!/usr/bin/env python3
import importlib.util,unittest
import numpy as np

sp=importlib.util.spec_from_file_location('fine_resolution','scripts/analyze-stage1p.py')
module=importlib.util.module_from_spec(sp);sp.loader.exec_module(module)


class FineResolutionTests(unittest.TestCase):
    def test_design(self):
        c=module.cases();self.assertEqual(len(c),32)
        self.assertEqual(len({(s['field'],s['mode'],s['replicate']) for s in c}),32)
        self.assertEqual({s['seed'] for s in c},set(range(970101,970105)))
        self.assertEqual({s['worldSeed'] for s in c},set(range(101301,101305)))

    def test_contraction_and_absolute_gate(self):
        a=np.zeros((85,4));s=[['supported','supported']]*3;t=list(range(85))
        self.assertTrue(module.convergence([a,a+.001,a+.0015],s,t)['passed'])
        self.assertFalse(module.convergence([a,a+.001,a+.0019],s,t)['contraction'])
        self.assertFalse(module.convergence([a,a+.004,a+.006],s,t)['fineBelowOneThirdSensitivityMargin'])

    def test_status_change(self):
        a=np.zeros((85,4));s=[['supported','supported'],['supported','abstain'],['supported','abstain']]
        self.assertFalse(module.convergence([a,a,a],s,list(range(85)))['primarySupportDecisionsStable'])

    def test_channel_cancellation_does_not_waive_scalar_failure(self):
        a=np.zeros((85,4));b=np.tile([.0001,-.0001,.0001,-.0001],(85,1));c=b+.00001
        result=module.convergence([a,b,c],[['abstain','abstain']]*3,list(range(85)))
        self.assertFalse(result['contraction']);self.assertGreater(result['comparisons'][0]['maxChannelChangeC0'],0)

    def test_reporting_and_decision_audit_on_development_only(self):
        import gzip,json
        from pathlib import Path
        r=json.loads(gzip.decompress(Path('research/evidence/si_head_motion_development_v2_2026-09-16/moving.json.gz').read_bytes()))
        # Old development inputs exercise the new reporting seed/audit implementation,
        # without running or examining a fresh validation physical path.
        for mode in [3,5]:
            result=module.variants(r['headVisits'],dict(mode=mode,replicate=31))
            self.assertEqual(len(result),2)
            if mode==5:self.assertTrue(all(v['v4']['reason']=='unresolved-within-dwell-orientation' for v in result))


if __name__=='__main__':unittest.main()
