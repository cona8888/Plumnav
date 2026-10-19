"""Synthetic verification tests, never simulations or AWS calls."""
import copy
import math
import unittest
import mechanism_portability_aws_first_v2 as p


def fixture():
    return dict(spec=dict(seed=5),summary=dict(stage='abstained'),
        controls=[dict(time=1.,decision=dict(direction=dict(x=.5,y=.2)))],
        visits=[dict(samples=[dict(value=.5,time=1.,hit=True,clipped=False)])],
        verification=dict(arms=[dict(observation=dict(visits=[dict(samples=[dict(value=.5)])]),
          decision=dict(status='abstained',candidate=dict(status='abstained',
            geometry=dict(rank=6,admitted=True,sigmaMin=.7,basisTransform=[[0.0]],
              coefficients=[.5],rmse=.01,peakNormUpper=.5),
            dwell=dict(windows=[dict(range=.1,tolerance=.003,possibleDistanceUpper=0.)]))))]))


def margin_fixture(value=.4):
    visits=[dict(samples=[dict(value=value)]) for _ in range(17)]
    candidate=dict(geometry=dict(admitted=True,rmseUpper=.01,eigenMaxUpper=-.1,peakNormUpper=.5),
       dwell=dict(windows=[dict(state='reject',range=.1,spatialChangeUpper=0.,tolerance=.003)]),
       crossfit=dict(pairs=[dict(state='indeterminate',envelope=dict(admitted=True,rmseUpper=.01))]))
    return dict(verification=dict(arms=[dict(observation=dict(visits=visits),decision=dict(candidate=candidate))]))


class ComparisonTests(unittest.TestCase):
    def changed(self,func):
        a=fixture();b=copy.deepcopy(a);func(b)
        return p.compare_history(a,b)

    def test_unchanged_is_exact_but_never_admission(self):
        r=p.compare_history(fixture(),fixture())
        self.assertTrue(r['passed'] and r['exact'])
        self.assertFalse(r['admissionAllowed'])
        self.assertTrue(r['independentAuditsRequired'])

    def test_retained_values_and_duplicate_have_bounded_roundoff(self):
        for branch in ('top','copy'):
            def change(x):
                target=x['visits'] if branch=='top' else x['verification']['arms'][0]['observation']['visits']
                target[0]['samples'][0]['value']=math.nextafter(.5,1.)
            self.assertTrue(self.changed(change)['passed'])

    def test_measurement_zero_sign_types_and_budget_stay_protected(self):
        for v in (0.,-.5,True,'0.5',.50001,float('nan'),float('inf')):
            self.assertFalse(self.changed(lambda x:x['visits'][0]['samples'][0].update(value=v))['passed'])
        a=fixture();a['visits'][0]['samples'][0]['value']=0.
        b=copy.deepcopy(a);b['visits'][0]['samples'][0]['value']=1e-17
        self.assertFalse(p.compare_history(a,b)['passed'])

    def test_verifier_near_zero_is_narrow_and_invariant_conditional(self):
        for v in (0,1e-17,-1e-17):
            self.assertTrue(self.changed(lambda x:x['verification']['arms'][0]['decision']['candidate']['geometry']['basisTransform'][0].__setitem__(0,v))['passed'])
        self.assertFalse(self.changed(lambda x:x['verification']['arms'][0]['decision']['candidate']['geometry']['basisTransform'][0].__setitem__(0,1e-6))['passed'])

    def test_explicit_numeric_budget_boundary(self):
        a=fixture();a['verification']['arms'][0]['decision']['candidate']['geometry']['coefficients']=[0.]
        b=copy.deepcopy(a);b['verification']['arms'][0]['decision']['candidate']['geometry']['coefficients']=[p.NOMINAL_CAP]
        self.assertTrue(p.compare_history(a,b)['passed'])
        b['verification']['arms'][0]['decision']['candidate']['geometry']['coefficients']=[math.nextafter(p.NOMINAL_CAP,math.inf)]
        self.assertFalse(p.compare_history(a,b)['passed'])

    def test_all_decisions_and_metadata_exact(self):
        edits=[lambda x:x['spec'].update(seed=6),
          lambda x:x['controls'][0].update(time=1.00000000001),
          lambda x:x['controls'][0]['decision']['direction'].update(x=math.nextafter(.5,1.)),
          lambda x:x['visits'][0]['samples'][0].update(hit=False),
          lambda x:x['visits'][0]['samples'][0].update(clipped=True),
          lambda x:x['verification']['arms'][0]['decision'].update(status='supported'),
          lambda x:x['verification']['arms'][0]['decision']['candidate']['geometry'].update(rank=5),
          lambda x:x['verification']['arms'][0]['decision']['candidate']['geometry'].update(admitted=False),
          lambda x:x['verification']['arms'][0]['decision']['candidate']['dwell']['windows'][0].update(possibleDistanceUpper=1e-17),
          lambda x:x['summary'].update(stage='supported'),
          lambda x:x['visits'].pop(),
          lambda x:x['verification']['arms'][0]['decision']['candidate']['geometry'].update(unknown=1e-17)]
        for i,fn in enumerate(edits):
            with self.subTest(change=i):self.assertFalse(self.changed(fn)['passed'])

    def test_named_verifier_numbers_still_reject_nonfinite_boolean(self):
        for v in (True,float('inf'),float('nan'),None):
            self.assertFalse(self.changed(lambda x:x['verification']['arms'][0]['decision']['candidate']['geometry'].update(rmse=v))['passed'])
        a=fixture();a['verification']['arms'][0]['decision']['candidate']['geometry']['rmse']=float('nan')
        self.assertFalse(p.compare_history(a,a)['passed'])

    def test_endpoints_remain_exact(self):
        a=dict(passed=True,errors=dict(a=0.))
        result=p.comparison_gate(dict(verification=None),dict(verification=None),a,a,dict(a=1e-9),
                               dict(error=.2),dict(error=math.nextafter(.2,1.)))
        self.assertFalse(result['candidateChecksPassed'])

    def test_unlisted_math_field_is_not_implicitly_allowed(self):
        a=fixture();a['verification']['arms'][0]['decision']['candidate']['geometry']['unknown']=.5
        b=copy.deepcopy(a);b['verification']['arms'][0]['decision']['candidate']['geometry']['unknown']=math.nextafter(.5,1.)
        self.assertFalse(p.compare_history(a,b)['passed'])

    def test_reordered_samples_rejected_by_exact_clock(self):
        a=fixture();a['visits'][0]['samples'].append(dict(a['visits'][0]['samples'][0],time=2.))
        b=copy.deepcopy(a);b['visits'][0]['samples'].reverse()
        self.assertFalse(p.compare_history(a,b)['passed'])


class AuditTests(unittest.TestCase):
    def test_absent_verification_has_exact_null_decision_check(self):
        a=dict(passed=True,errors=dict(response=1e-15),decisionCheck=None)
        self.assertTrue(p.compare_audits(a,a,dict(response=1e-9))['passed'])
        b=dict(a,decisionCheck=dict(maximumNumericDifference=0.,windows=0,pairs=0))
        self.assertFalse(p.compare_audits(a,b,dict(response=1e-9))['passed'])
        self.assertFalse(p.compare_audits(b,a,dict(response=1e-9))['passed'])
        b=dict(a);del b['decisionCheck']
        self.assertFalse(p.compare_audits(a,b,dict(response=1e-9))['passed'])

    def test_decision_residual_has_original_bound_counts_exact(self):
        a=dict(passed=True,errors=dict(response=1e-15),decisionCheck=dict(maximumNumericDifference=1e-15,windows=17,pairs=8))
        b=copy.deepcopy(a);b['decisionCheck']['maximumNumericDifference']=1e-14
        self.assertTrue(p.compare_audits(a,b,dict(response=1e-9))['passed'])
        for key,value in [('maximumNumericDifference',1.01e-9),('maximumNumericDifference',-1.),
                          ('maximumNumericDifference',True),('windows',16),('pairs',7),('unexpected',0.)]:
            c=copy.deepcopy(b);c['decisionCheck'][key]=value
            self.assertFalse(p.compare_audits(a,c,dict(response=1e-9))['passed'])

    def test_equation_error_and_schema_unchanged(self):
        a=dict(passed=True,errors=dict(response=1e-15))
        for b in [dict(a,passed=False),dict(a,errors=dict(response=1.01e-9)),dict(a,errors={}),
                  dict(a,decisionCheck=dict(maximumNumericDifference=0.,windows=0,pairs=0))]:
            self.assertFalse(p.compare_audits(a,b,dict(response=1e-9))['passed'])


class MarginTests(unittest.TestCase):
    def test_separated_abstention_passes_guard_only(self):
        self.assertTrue(p.decision_margins(margin_fixture())['passed'])

    def test_signal_and_derived_boundary_fail_closed(self):
        self.assertFalse(p.decision_margins(margin_fixture(.16))['passed'])
        r=margin_fixture();r['verification']['arms'][0]['decision']['candidate']['geometry']['rmseUpper']=.003
        self.assertFalse(p.decision_margins(r)['passed'])

    def test_dwell_threshold_and_schema(self):
        r=margin_fixture();r['verification']['arms'][0]['decision']['candidate']['dwell']['windows'][0]['range']=.003
        self.assertFalse(p.decision_margins(r)['passed'])
        self.assertFalse(p.decision_margins(dict(verification={}))['passed'])

    def test_absence_of_verification_does_not_assert_no_leak(self):
        result=p.decision_margins(dict(verification=None))
        self.assertTrue(result['passed'])
        self.assertFalse(result['applicable'] or result['admissionAllowed'])


if __name__=='__main__':unittest.main(verbosity=2)
