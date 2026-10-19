#!/usr/bin/env python3
import gzip,json,math,unittest
from pathlib import Path
import numpy as np
from lib.si_head_motion_audit import filtered_history,inspect_history,cases,MODES,EngineRandom,engine_seed


class ForwardAuditTests(unittest.TestCase):
    def test_design_unique(self):
        c=cases();self.assertEqual(len(c),192)
        self.assertEqual(len({(s['field'],s['phaseSeconds'],s['mode'],s['replicate']) for s in c}),192)

    def test_known_first_order_step_integral(self):
        settings=dict(tubeInnerDiameterMetres=.002,tubeLengthMetres=0,flowLitresPerMinutePerChannel=.25,riseTimeConstantSeconds=2,recoveryTimeConstantSeconds=2,averagingSeconds=1)
        t=np.arange(0,10.0625,.0625);y=filtered_history(t,np.ones((len(t),4)),settings)
        def area(v):return v+2*math.expm1(-v/2)
        expected=np.array([area(v)-area(max(0,v-1)) for v in t])
        self.assertLess(np.max(abs(y[:,0]-expected)),1e-12)

    test_records=[]

    def test_development_forward_and_noisy_histories(self):
        root=Path('research/evidence/si_head_motion_development_v2_2026-09-16')
        c=json.loads((root/'config.json').read_text())
        for name in ['stationary','moving']:
            r=json.loads(gzip.decompress((root/(name+'.json.gz')).read_bytes()))
            audit=inspect_history(r,c,r['trace'],c['fixedDt'])
            self.test_records.append({'name':name,**audit})
            for f in r.get('refinements',[]):
                self.test_records.append({'name':name+'-fine',**inspect_history(r,c,f['trace'],f['dt'],noisy=False)})

    def test_si_field_and_rotating_head(self):
        root=Path('research/evidence/si_head_motion_development_v2_2026-09-16')
        for name in ['si-continuous','si-pulse']:
            c=json.loads((root/(name+'-config.json')).read_text())
            r=json.loads(gzip.decompress((root/(name+'.json.gz')).read_bytes()))
            self.test_records.append({'name':name,**inspect_history(r,c,r['trace'],c['fixedDt'])})


if __name__=='__main__':
    runner=unittest.TextTestRunner()
    result=runner.run(unittest.defaultTestLoader.loadTestsFromTestCase(ForwardAuditTests))
    print(json.dumps(ForwardAuditTests.test_records,indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
