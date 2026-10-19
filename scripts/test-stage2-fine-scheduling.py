import copy
import unittest
from lib.si_fine_scheduling_statistics import summarize,select_primary
from lib.si_scheduling_statistics import ARMS,BINARY,CONTINUOUS,wilson


def fixtures():
    rows=[]
    for w in range(16):
        for field in ['si-continuous','si-pulse','blank']:
            for method,policy in ARMS:
                metrics={k:False for k in BINARY};metrics.update({k:float(w) for k in CONTINUOUS})
                metrics['restrictedEncounterSeconds']=600-(10 if policy=='encounter-gated' else 0)
                rows.append(dict(spec=dict(studyId='fine-scheduling-v1',caseRole='primary',navDt=1/64,worldIndex=w,field=field,method=method,policy=policy),metrics=metrics))
    return rows


class FineSchedulingStatisticsTests(unittest.TestCase):
    def test_fixed_pairing(self):
        rows=fixtures();a=summarize(rows);self.assertEqual(a,summarize(rows));self.assertEqual(a['primaryMissions'],192)
        for p in a['pairedContrasts']:
            self.assertEqual(p['metrics']['restrictedEncounterSeconds']['bootstrapPercentile95'],[-10.,-10.])
            self.assertEqual(p['metrics']['restrictedEncounterSeconds']['negativeWorlds'],16)
    def test_witnesses_never_count_as_worlds(self):
        rows=fixtures();extra=copy.deepcopy(rows[0]);extra['spec'].update(caseRole='resolution-witness',navDt=1/16);extra['metrics']['restrictedEncounterSeconds']=99999
        self.assertEqual(summarize(rows),summarize(rows+[extra]))
    def test_wrong_primary_resolution(self):
        rows=fixtures();rows[0]['spec']['navDt']=1/16
        with self.assertRaises(AssertionError):select_primary(rows)
    def test_missing_case(self):
        with self.assertRaises(AssertionError):select_primary(fixtures()[:-1])
    def test_duplicate_case(self):
        rows=fixtures();rows[-1]=rows[0]
        with self.assertRaises(AssertionError):select_primary(rows)
    def test_wrong_world(self):
        rows=fixtures();rows[0]['spec']['worldIndex']=16
        with self.assertRaises(AssertionError):select_primary(rows)
    def test_non_boolean_outcome(self):
        rows=fixtures();rows[0]['metrics']['encounter']=1
        with self.assertRaises(AssertionError):summarize(rows)
    def test_nonfinite_value(self):
        rows=fixtures();rows[0]['metrics']['completedAt']=float('nan')
        with self.assertRaises(AssertionError):summarize(rows)
    def test_zero_rate_uncertainty(self):self.assertGreater(wilson(0,16)[1],.19)
    def test_fields_not_pooled(self):
        a=summarize(fixtures());self.assertEqual(len(a['arms']),12);self.assertTrue(all(x['independentWorlds']==16 for x in a['arms']))


if __name__=='__main__':unittest.main()
