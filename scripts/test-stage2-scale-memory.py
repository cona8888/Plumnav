#!/usr/bin/env python3
import gzip,importlib.util,json,unittest
from pathlib import Path
sp=importlib.util.spec_from_file_location('scale_memory','scripts/analyze-stage2-scale-memory.py');module=importlib.util.module_from_spec(sp);sp.loader.exec_module(module)


class ScaleMemoryTests(unittest.TestCase):
    def test_design(self):
        c=module.cases();self.assertEqual(len(c),64);self.assertEqual(len({(s['field'],s['replicate'],s['variant']) for s in c}),64)
        self.assertEqual(sum(s['variant'].startswith('similar-') for s in c),30)

    def test_development_forward_histories_and_unit_adapter(self):
        root=Path('research/evidence/si_scale_memory_development_2026-09-16')
        for field in ['peak','si-pulse']:
            base=json.loads(gzip.decompress((root/f'{field}-base.json.gz').read_bytes()))
            for variant in ['reference','similar-small','similar-large','similar-slow','settle-16']:
                r=json.loads(gzip.decompress((root/f'{field}-{variant}.json.gz').read_bytes()))
                audit=module.inspect_replay(base,r['spec'],r['config'],r['history']);self.assertLess(audit['errors']['sensorHistory'],1e-9)
                ds=module.decisions(r['history'],r['spec']);self.assertEqual(len(ds),2)
                self.assertTrue(all(d['admission']['admitted'] for d in ds))


if __name__=='__main__':unittest.main()
