"""Exact comparison negative fixtures, not synthetic numerical admission."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from lib.si_wrapper_equivalence_admission_v2 import exact_equivalence, record_binding, reference_coverage, CASES, DEV_SHA
from lib import si_wrapper_equivalence_admission_v2 as m


class EquivalenceFixtures(unittest.TestCase):
    def setUp(self):
        # Tiny records exist solely to test comparison and exclusions. They do
        # not meet full mission/audit contracts and are never accepted artifacts.
        self.record=dict(summary=dict(rpcMilliseconds=3.,stage='fixture',completedAt=1200.),verification=None,
            controls=[dict(sensor=[0.125,1.5],position=dict(x=1.,y=2.))],trace=[[0.,1.,2.]],
            spec=dict(method='fixture'),development=None)
        self.other=copy.deepcopy(self.record)
        self.d={k:{'value':0.125} for k in ('details','guard','extracted','compact')}
        self.other_d=copy.deepcopy(self.d)
        self.a=dict(positions=np.array([[1.,2.]]),scalar=np.array([0.125]))
        self.other_a={k:v.copy() for k,v in self.a.items()}

    def check(self):return exact_equivalence(self.record,self.other,self.d,self.other_d,self.a,self.other_a)

    def test_exact_data_does_not_admit_without_terminal_proof(self):
        result=self.check()
        self.assertTrue(result['passed'])
        self.assertFalse(result['numericalSameWrapperAdmissionPassed'])
        self.assertFalse(result['terminalProvenanceVerified'])
        self.assertFalse(result['scientificallyAccepted'])

    def test_rpc_elapsed_time_only_excluded(self):
        self.other['summary']['rpcMilliseconds']=999.
        self.check()
        self.assertEqual(self.record['summary']['rpcMilliseconds'],3.)
        self.assertEqual(self.other['summary']['rpcMilliseconds'],999.)

    def test_invalid_rpc_timing_rejected(self):
        for bad in (float('nan'),float('inf'),-1.,True,'1'):
            self.other['summary']['rpcMilliseconds']=bad
            with self.assertRaises(ValueError):self.check()

    def test_one_ulp_sensor_readout_change_rejected(self):
        self.other['controls'][0]['sensor'][0]=float(np.nextafter(0.125,1.))
        with self.assertRaisesRegex(ValueError,'history differs'):self.check()

    def test_position_change_rejected(self):
        self.other['controls'][0]['position']['x']=1.000000000000001
        with self.assertRaises(ValueError):self.check()

    def test_missing_trace_row_rejected(self):
        self.other['trace']=[]
        with self.assertRaises(ValueError):self.check()

    def test_added_whole_history_field_rejected(self):
        self.other['new']='field'
        with self.assertRaises(ValueError):self.check()

    def test_signed_zero_rejected_in_history(self):
        self.other['trace'][0][0]=-0.
        with self.assertRaises(ValueError):self.check()

    def test_nonnumeric_discrete_difference_rejected(self):
        self.other['summary']['stage']='other'
        with self.assertRaises(ValueError):self.check()

    def test_type_difference_rejected(self):
        self.other['controls'][0]['position']['x']=1
        with self.assertRaises(ValueError):self.check()

    def test_full_audit_residual_difference_rejected(self):
        self.other_d['details']['value']=float(np.nextafter(0.125,1.))
        with self.assertRaisesRegex(ValueError,'diagnostic differs'):self.check()

    def test_serialized_hashes_are_not_numerical_data(self):
        self.d['historySha256']='a'*64;self.other_d['historySha256']='b'*64
        self.d['arraysSha256']='c'*64;self.other_d['arraysSha256']='d'*64
        self.d['referenceComparison']={'exact':True}
        self.check()

    def test_compact_rpc_view_uses_existing_exclusion_without_mutation(self):
        self.d['compact']['summary']={'rpcMilliseconds':3.5,'completedAt':1200.}
        self.other_d['compact']['summary']={'rpcMilliseconds':0,'completedAt':1200.}
        self.check()
        self.assertEqual(self.d['compact']['summary']['rpcMilliseconds'],3.5)

    def test_other_compact_summary_fields_still_exact(self):
        self.d['compact']['summary']={'rpcMilliseconds':3.5,'completedAt':1200.}
        self.other_d['compact']['summary']={'rpcMilliseconds':0,'completedAt':1199.}
        with self.assertRaises(ValueError):self.check()

    def test_invalid_compact_rpc_rejected(self):
        self.other_d['compact']['summary']={'rpcMilliseconds':float('nan')}
        with self.assertRaises(ValueError):self.check()

    def test_all_arrays_not_only_summary_compared(self):
        self.other_a['scalar'][0]=np.nextafter(0.125,1.)
        with self.assertRaisesRegex(ValueError,'array differs'):self.check()

    def test_npz_extra_key_rejected(self):
        self.other_a['unexpected']=np.zeros(1)
        with self.assertRaises(ValueError):self.check()

    def test_npz_nonfinite_rejected(self):
        self.other_a['positions'][0,0]=np.nan
        with self.assertRaises(ValueError):self.check()

    def test_npz_dtype_and_shape_rejected(self):
        for data in (np.array([0.125],dtype=np.float32),np.array([[0.125]])):
            self.other_a['scalar']=data
            with self.assertRaises(ValueError):self.check()

    def test_reserved_case_cannot_be_wrapper_witness(self):
        with self.assertRaisesRegex(ValueError,'reserved'):
            record_binding({}, {}, {}, {}, {}, {}, {'id':'mechanism-fresh-000-RW-blank-n64'}, {}, 'a'*64, 'development')

    def test_live_or_failed_reference_cannot_admit(self):
        with self.assertRaisesRegex(ValueError,'Unaccepted'):
            reference_coverage(dict(accepted=False),{},'a'*64)

    def test_full_equivalence_sources_are_pinned(self):
        for name,digest in m.PINS.items():self.assertEqual(m.sha(ROOT/name),digest)


class SavedProducerSchemaFixtures(unittest.TestCase):
    """Actual frozen v3/v4 producer artifacts; not independent acceptance."""
    def test_three_real_saved_complete_histories_and_derivatives(self):
        from lib.si_mechanism_history_v1 import history
        tree=ROOT/'research/results/si_mechanism_resource_v2_download_audit_attempt01_2026-09-30/download'
        ledger=tree/'provenance/collection-hashes.json'
        self.assertEqual(m.sha(ledger),'9bb04bd78cd5953290f44991e8e01acb133494d674f1d02daec2c14602ce4b48')
        pins=json.loads(ledger.read_bytes())['hashes']
        for cid in CASES:
            records=[];diagnostics=[];arrays=[]
            for phase in ('baseline','candidate'):
                base='output/runs/'+phase+'/'
                paths=[base+'cases/'+cid+'/mission.json.gz',base+'audits/'+cid+'-diagnostics.json',
                    base+'audits/'+cid+'-arrays.npz']
                for name in paths:self.assertEqual(m.sha(tree/name),pins[name])
                records.append(history(tree/paths[0]));diagnostics.append(json.loads((tree/paths[1]).read_bytes()))
                with np.load(tree/paths[2],allow_pickle=False) as z:arrays.append({k:z[k].copy() for k in z.files})
            result=exact_equivalence(records[0],records[1],diagnostics[0],diagnostics[1],arrays[0],arrays[1])
            self.assertTrue(result['passed'])
            self.assertFalse(result['numericalSameWrapperAdmissionPassed'])
            self.assertFalse(result['scientificallyAccepted'])


if __name__=='__main__':unittest.main()

