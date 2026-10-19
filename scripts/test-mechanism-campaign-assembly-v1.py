"""Synthetic routing/negative fixtures only; no reserved-world simulation."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from lib.si_mechanism_campaign_assembly_v1 import (
    frozen, assemble_rows, bind_saved_case, regular, sha, MANIFEST_SHA)

ROOT=Path(__file__).resolve().parents[1]
MANIFEST=ROOT/'research/results/si_mechanism_portable_metadata_attempt01_2026-09-29/prospective_manifest_portable_v1.json'
INDEX=ROOT/'research/results/si_mechanism_campaign_audit_index_v1_attempt01_2026-09-30/audit-index.json'
ANALYSIS=ROOT/'research/protocols/si_mechanism_campaign_analysis_v1_2026-09-30.json'


def metadata(field,kind='none',error=.09):
    return dict(auditPassed=True,field=field,
        stage='no-eligible-nomination' if kind=='none' else 'inspection-complete',
        nominationPresent=kind!='none',nominalStatus=None if kind=='none' else kind,
        reportedPointPresent=kind=='supported',
        sourceErrorMetres=error if kind=='supported' and field!='blank' else None)


def row(case,kind='none',error=.09):
    m=metadata(case['spec']['field'],kind,error)
    c=dict(spec=case['spec'],summary=dict(stage=m['stage'],completedAt=1),
        nomination=None if kind=='none' else dict(point=dict(x=.5,y=.5)),
        decisions=[] if kind=='none' else [dict(radius=0,status=kind,reason='fixture')],
        positions=np.full((17,2),.5),scalar=np.zeros(2,dtype=float))
    return dict(case=case,metadata=m,compact=c)


class AssemblyFixtures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document,cls.index,cls.config=frozen(ROOT,MANIFEST,INDEX,ANALYSIS)
        cls.cases={c['id']:c for c in cls.document['cases']}

    def setUp(self):
        self.rows={cid:row(c) for cid,c in self.cases.items()}
        self.routing=copy.deepcopy(self.index)

    def assemble(self):
        return assemble_rows(self.document,self.routing,self.config,self.rows)

    def test_complete_all_zero_routing_is_not_acceptance(self):
        result=self.assemble()
        self.assertTrue(result['componentPassed'])
        self.assertEqual(len(result['triplets']),240)
        stats=result['statistics']
        self.assertEqual(stats['independentWorlds'],128)
        self.assertEqual(stats['bootstrap']['seed'],711397807)
        self.assertEqual(stats['bootstrap']['drawCount'],10000)
        self.assertTrue(all(p['empiricalIntervalDegenerate'] for p in stats['primary']))
        self.assertTrue(all(p['unclippedConservativeHalfWidth']>0 for p in stats['primary']))
        self.assertTrue(all(not v for k,v in result['scope'].items() if k!='explanation'))
        for arm in stats['arms']:
            if arm['field']=='blank':
                self.assertIsNone(arm['successes'])
                self.assertEqual(arm['blankControls']['falseReport']['count'],0)

    def test_paired_treatment_pattern_no_pseudoreplication(self):
        for cid,c in self.cases.items():
            if c['spec']['field']!='blank' and c['arm']=='GL':
                self.rows[cid]=row(c,'supported')
        result=self.assemble()
        self.assertEqual([p['mean'] for p in result['statistics']['primary']],[1,1,1,1])
        self.assertEqual(result['statistics']['independentWorlds'],128)

    def test_missing_history_rejected(self):
        self.rows.pop(next(iter(self.rows)))
        with self.assertRaisesRegex(ValueError,'2400-row'):
            self.assemble()

    def test_extra_history_rejected(self):
        self.rows['extra']=next(iter(self.rows.values()))
        with self.assertRaisesRegex(ValueError,'2400-row'):
            self.assemble()

    def test_swapped_case_rejected(self):
        a,b=list(self.rows)[:2]; self.rows[a]['case']=self.cases[b]
        with self.assertRaisesRegex(ValueError,'case identity'):
            self.assemble()

    def test_field_mismatch_rejected(self):
        self.rows[next(iter(self.rows))]['metadata']['field']='blank'
        with self.assertRaisesRegex(ValueError,'field mismatch'):
            self.assemble()

    def test_wrong_primary_clock_rejected(self):
        self.routing['worldBlocks'][0]['primary']['si-continuous']['RW']=self.routing['resolutionTriplets'][0]['caseIds'][0]
        with self.assertRaisesRegex(ValueError,'primary case'):
            self.assemble()

    def test_wrong_world_order_rejected(self):
        self.routing['worldBlocks'].reverse()
        with self.assertRaisesRegex(ValueError,'block order'):
            self.assemble()

    def test_duplicate_triplet_rejected(self):
        self.routing['resolutionTriplets'][1]=self.routing['resolutionTriplets'][0]
        with self.assertRaisesRegex(ValueError,'Duplicate'):
            self.assemble()

    def test_numerical_failure_retained_without_statistics(self):
        cid=self.routing['resolutionTriplets'][0]['caseIds'][2]
        self.rows[cid]['compact']['positions'][:,0]+=.01
        result=self.assemble()
        self.assertFalse(result['componentPassed'])
        self.assertIsNone(result['statistics'])
        self.assertEqual(len(result['triplets']),240)
        self.assertEqual(len(result['failedTriplets']),1)

    def test_tolerance_boundary_flip_blocks_statistics(self):
        route=self.routing['resolutionTriplets'][0]
        for cid,error in zip(route['caseIds'],[.1,.1,.100000000001]):
            self.rows[cid]=row(self.cases[cid],'supported',error)
        result=self.assemble()
        adverse=result['failedTriplets']
        self.assertIn(route['caseIds'],adverse)
        target=next(t for t in result['triplets'] if t['caseIds']==route['caseIds'])
        self.assertTrue(target['numerical']['passed'])
        self.assertFalse(target['endpointGate']['passed'])
        self.assertIsNone(result['statistics'])

    def test_blank_report_category_flip_blocks_statistics(self):
        route=next(t for t in self.routing['resolutionTriplets'] if t['field']=='blank')
        for cid,kind in zip(route['caseIds'],['abstained','abstained','supported']):
            self.rows[cid]=row(self.cases[cid],kind)
        result=self.assemble()
        target=next(t for t in result['triplets'] if t['caseIds']==route['caseIds'])
        self.assertFalse(target['endpointGate']['blankOutcomeStable'])
        self.assertIsNone(result['statistics'])

    def test_bad_compact_arrays_rejected(self):
        cid=next(iter(self.rows))
        for bad in (np.full((17,2),np.nan),np.zeros((16,2)),np.zeros((17,2),dtype=int)):
            self.rows[cid]['compact']['positions']=bad
            with self.assertRaisesRegex(ValueError,'array'):
                self.assemble()

    def test_changed_seed_rejected(self):
        changed=copy.deepcopy(self.config);changed['bootstrap']['seed']=2
        with self.assertRaisesRegex(ValueError,'resampling allocation'):
            assemble_rows(self.document,self.routing,changed,self.rows)


class ArtifactBindingFixtures(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.p=self.root/'producer';self.i=self.root/'independent'
        d,_,_=frozen(ROOT,MANIFEST,INDEX,ANALYSIS)
        self.case=d['cases'][0];self.cid=self.case['id'];self.release='a'*64
        self.h=self.p/'run/cases'/self.cid/'mission.json.gz'
        self.h.parent.mkdir(parents=True);self.h.write_bytes(b'Synthetic hash-binding fixture; not a raw audited history')
        from lib.si_release_endpoint_v2 import endpoint
        r=row(self.case);compact=dict(r['compact']);compact.pop('positions');compact.pop('scalar')
        for root,prefix in ((self.p,'run/audits/'),(self.i,'audits/')):
            folder=root/prefix;folder.mkdir(parents=True)
            array=folder/(self.cid+'-arrays.npz')
            np.savez_compressed(array,positions=r['compact']['positions'],scalar=r['compact']['scalar'])
            diag=dict(details=dict(passed=True),guard=dict(fixture=True),
                extracted=dict(metadata=r['metadata'],endpoint=endpoint(r['metadata'])),compact=compact,
                historySha256=sha(self.h),arraysSha256=sha(array))
            dp=folder/(self.cid+'-diagnostics.json');dp.write_text(json.dumps(diag))
            receipt=dict(passed=True,detailsPassed=True,caseId=self.cid,case=self.case,
                manifestSha256=MANIFEST_SHA,releaseSha256=self.release,historySha256=sha(self.h),
                diagnosticsSha256=sha(dp),arraysSha256=sha(array))
            (folder/(self.cid+'.json')).write_text(json.dumps(receipt))

    def bind(self):
        return bind_saved_case(self.p,self.i,self.case,self.release)

    def test_matching_artifacts_do_not_prove_independent_execution(self):
        result=self.bind()
        self.assertFalse(result['independentExecutionProvenanceVerified'])
        self.assertEqual(result['bindings']['historySha256'],sha(self.h))

    def test_changed_history_rejected(self):
        self.h.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'receipt identity'):
            self.bind()

    def test_changed_diagnostic_rejected(self):
        p=self.i/'audits'/(self.cid+'-diagnostics.json');p.write_text('{}')
        with self.assertRaisesRegex(ValueError,'checksum'):
            self.bind()

    def test_changed_array_rejected(self):
        p=self.i/'audits'/(self.cid+'-arrays.npz');p.write_bytes(b'wrong')
        with self.assertRaisesRegex(ValueError,'checksum'):
            self.bind()

    def test_wrong_release_rejected(self):
        with self.assertRaisesRegex(ValueError,'receipt identity'):
            bind_saved_case(self.p,self.i,self.case,'b'*64)

    def test_symlinked_ancestor_and_traversal_rejected(self):
        (self.root/'linked').symlink_to(self.i,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'Symlinked'):
            regular(self.root,'linked/audits/'+self.cid+'.json')
        with self.assertRaisesRegex(ValueError,'Noncanonical'):
            regular(self.root,'../missing')


if __name__=='__main__':
    unittest.main()
