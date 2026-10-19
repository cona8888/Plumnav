"""Metadata-only coverage and negative fixtures; no outcomes or AWS calls."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('audit_index',HERE/'prepare-mechanism-campaign-audit-index-v1.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class AuditIndexFixtures(unittest.TestCase):
    def setUp(self): self.doc=json.loads(m.PORTABLE.read_bytes())

    def test_full_membership_and_no_mutation(self):
        before=copy.deepcopy(self.doc); out=m.index(self.doc)
        self.assertEqual(before,self.doc)
        self.assertEqual(len(out['historyIds']),2400)
        self.assertEqual(len(out['worldBlocks']),128)
        self.assertEqual(len(out['resolutionTriplets']),240)
        self.assertFalse(out['containsOutcomes']); self.assertFalse(out['productionAdmitted'])

    def test_paired_contrast_weights(self):
        out=m.index(self.doc)
        for effect in out['confirmatoryContrasts']:
            self.assertNotEqual(effect['field'],'blank')
            self.assertEqual(len(effect['pairedWorlds']),128)
            expected={'GL':1,'RL':-1,'GW':-1,'RW':1} if effect['name']=='interaction' else {'GL':1,'NS':-1}
            self.assertEqual(effect['weights'],expected)
            for block in effect['pairedWorlds']:
                for term in block['terms']:
                    case=next(c for c in self.doc['cases'] if c['id']==term['caseId'])
                    self.assertEqual(case['worldKey'],block['worldKey'])
                    self.assertEqual(case['spec']['field'],effect['field'])
                    self.assertEqual(case['spec']['navDt'],1/64)
                    self.assertEqual(term['weight'],expected[case['arm']])

    def test_triplet_clock_order_and_blank_policy(self):
        out=m.index(self.doc); cases={c['id']:c for c in self.doc['cases']}
        for t in out['resolutionTriplets']:
            self.assertEqual([cases[c]['spec']['navDt'] for c in t['caseIds']],[1/16,1/32,1/64])
            self.assertEqual(t['primaryEndpointDefined'],t['field']!='blank')
            self.assertEqual(len({cases[c]['worldKey'] for c in t['caseIds']}),1)

    def test_missing_history_rejected(self):
        self.doc['cases'].pop()
        with self.assertRaises(ValueError): m.index(self.doc)

    def test_duplicate_history_rejected(self):
        self.doc['cases'].append(copy.deepcopy(self.doc['cases'][0]))
        with self.assertRaises(ValueError): m.index(self.doc)

    def test_wrong_arm_binding_rejected(self):
        c=next(c for c in self.doc['cases'] if c['arm']=='GW'); c['arm']='RW'
        with self.assertRaises(ValueError): m.index(self.doc)

    def test_wrong_world_binding_rejected(self):
        self.doc['cases'][0]['worldKey']=self.doc['worlds'][1]['key']
        with self.assertRaises(ValueError): m.index(self.doc)


if __name__=='__main__': unittest.main()
