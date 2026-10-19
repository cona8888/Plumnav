"""Separate prospective portability candidate; no admission or job launch.

Only a caller executing the SHA-verified independent full-history auditor on
BOTH histories may use this comparison as one gate. Numeric comparators alone
never establish correctness. AWS completion/download/repeatability gates remain
outside this development helper. Frozen v1 is imported, never modified.
"""
import copy
import hashlib
import math
from pathlib import Path
import statistics

import mechanism_portability_candidate_v1 as v1

VERSION = 'mechanism-portability-aws-first-v2'
V1_SHA = '2e09ea5b9aeee71079cc4be5b3998585bd383808a0a1fc9cc0c18290e5e27d33'
if hashlib.sha256(Path(v1.__file__).read_bytes()).hexdigest() != V1_SHA:
    raise ValueError('Frozen v1 helper changed')

# Existing independent audit limits / 16, NOT fitted to cloud maxima. These are
# engineering comparison budgets, not a proof of numerical forward error.
NOMINAL_CAP = 1e-10 / 16
DERIVED_CAP = 1e-9 / 16
CONCENTRATION_CAP = v1.LIMITS['concentration'][1]
DECISION_AUDIT_LIMIT = 1e-9
ENVELOPE_SCALARS = frozenset((
    'rmse', 'whitenedMatrixErrorUpper', 'whitenedSigmaLower',
    'whitenedCoefficientRadius', 'coefficientRadius', 'hessianRadius',
    'eigenMax', 'eigenMaxUpper', 'hessianNorm', 'rmseUpper',
    'peakRadius', 'peakNormUpper', 'valueChangeNormUpper',
    'whitenedNormalResidualNorm'))
PAIR_SCALARS = frozenset((
    'correction', 'coordinateAllowance', 'trainingAllowance', 'totalAllowance',
    'residual', 'whitenedDifferenceNorm', 'whitenedDifferenceErrorUpper',
    'weightChangeUpper'))


def index(x, n=None):
    return type(x) is int and x >= 0 and (n is None or x < n)


def numeric(x):
    return type(x) in (float, int) and math.isfinite(x)


def field(p):
    """Explicit additional scalar paths; no suffix/global float exception."""
    if len(p) == 5 and p[0] == 'visits' and index(p[1], 17) and p[2] == 'samples' and index(p[3], 5) and p[4] == 'value':
        return 'retained-concentration', CONCENTRATION_CAP
    if len(p) < 4 or p[:2] != ('verification','arms') or not index(p[2]):
        return None
    tail = p[3:]
    if tail[:1] == ('observation',):
        return field(tail[1:])
    if tail[:2] != ('decision', 'candidate'):
        return None
    tail = tail[2:]
    envelope = None
    if tail[:1] == ('geometry',):
        envelope = tail[1:]
    elif len(tail) >= 4 and tail[:2] == ('crossfit','pairs') and index(tail[2], 8):
        if tail[3] == 'envelope':
            envelope = tail[4:]
        elif len(tail) == 4 and tail[3] in PAIR_SCALARS:
            return 'verifier-derived', DERIVED_CAP
        elif tail[3:] == ('tolerance',):
            return 'retained-concentration', CONCENTRATION_CAP
    elif len(tail) == 4 and tail[:2] == ('dwell','windows') and index(tail[2], 17):
        if tail[3] in ('range','tolerance'):
            return 'retained-concentration', CONCENTRATION_CAP
        if tail[3] in ('gradientUpper','spatialChangeUpper'):
            return 'verifier-derived', DERIVED_CAP
        # Translation/diameter zero branches deliberately stay EXACT.
    if envelope == ('sigmaMin',):
        return 'verifier-nominal', NOMINAL_CAP
    if envelope is not None:
        if len(envelope) == 2 and envelope[0] == 'coefficients' and index(envelope[1], 6):
            return 'verifier-nominal', NOMINAL_CAP
        if len(envelope) == 3 and envelope[0] == 'basisTransform' and index(envelope[1], 6) and index(envelope[2], 6):
            return 'verifier-basis', NOMINAL_CAP
        if len(envelope) == 1 and envelope[0] in ENVELOPE_SCALARS:
            return 'verifier-derived', DERIVED_CAP
        if len(envelope) == 2 and ((envelope[0] == 'peak' and index(envelope[1], 2)) or
                (envelope[0] == 'whitenedRowErrorBounds' and index(envelope[1], 17))):
            return 'verifier-derived', DERIVED_CAP
    return None


def compare_history(left, right):
    """Preliminary comparison only; invariant/full-audit checks are mandatory."""
    out = dict(policy=VERSION, passed=True, exact=True, changedScalars=0,
        rejectedDifferences=0, allowedDifferences=0, byClass={}, examples=[],
        independentAuditsRequired=True, admissionAllowed=False)

    def reject(p, why, a, b):
        out['passed'] = out['exact'] = False
        out['rejectedDifferences'] += 1
        if len(out['examples']) < 30:
            out['examples'].append(dict(path='/'+'/'.join(map(str,p)), reason=why,
                                       reference=repr(a), candidate=repr(b)))

    def walk(a,b,p=()):
        if isinstance(a, bool) or isinstance(b, bool):
            if type(a) is not type(b) or a != b:
                reject(p,'exact-boolean',a,b)
            return
        kind = field(p)
        if kind and kind[0].startswith('verifier-') and numeric(a) and numeric(b):
            if type(a) is type(b) and a == b and math.copysign(1,a) == math.copysign(1,b):
                return
            accept_numeric(a,b,p,kind,False)
            return
        if type(a) is not type(b):
            reject(p,'type',a,b)
        elif type(a) is dict:
            if a.keys() != b.keys():
                reject(p,'keys',sorted(a),sorted(b))
            for k in a:
                if k in b:
                    walk(a[k],b[k],p+(k,))
        elif type(a) is list:
            if len(a)!=len(b):
                reject(p,'length',len(a),len(b))
            for i,(x,y) in enumerate(zip(a,b)):
                walk(x,y,p+(i,))
        elif type(a) is float:
            if not numeric(a) or not numeric(b):
                reject(p,'non-finite',a,b)
            elif a != b or math.copysign(1,a)!=math.copysign(1,b):
                old = v1.field_kind(p)
                rule = kind or ((old,v1.LIMITS[old][1]) if old else None)
                if rule is None:
                    reject(p,'exact-field',a,b)
                else:
                    accept_numeric(a,b,p,rule,True)
        elif type(a) not in (int,str,type(None)):
            reject(p,'unsupported-type',a,b)
        elif a!=b:
            reject(p,'exact-field',a,b)

    def accept_numeric(a,b,p,rule,use_ulps):
        out['exact']=False
        out['changedScalars']+=1
        name,cap=rule
        error=abs(a-b)
        if use_ulps and (a==0 or b==0 or math.copysign(1,a)!=math.copysign(1,b)):
            reject(p,'zero-or-sign-change',a,b)
            return
        if error>cap or (use_ulps and v1.ulps(a,b)>v1.MAX_ULPS):
            reject(p,'numeric-budget',a,b)
            return
        row=out['byClass'].setdefault(name,dict(count=0,maxAbsoluteDifference=0.,absoluteCap=cap))
        row['count']+=1
        row['maxAbsoluteDifference']=max(row['maxAbsoluteDifference'],error)
        out['allowedDifferences']+=1

    walk(left,right)
    return out


def compare_audits(left,right,bounds):
    """Existing error bounds + separately named decision residual; exact rest."""
    a,b=copy.deepcopy(left),copy.deepcopy(right)
    residuals=[]
    if ('decisionCheck' in a) != ('decisionCheck' in b):
        return dict(passed=False,reason='decision residual schema',admissionAllowed=False)
    if (a.get('decisionCheck') is None) != (b.get('decisionCheck') is None):
        return dict(passed=False,reason='decision residual schema',admissionAllowed=False)
    for label,d in (('reference',a),('candidate',b)):
        if 'decisionCheck' not in d or d['decisionCheck'] is None:
            continue
        dc=d['decisionCheck']
        if type(dc) is not dict or set(dc)!={'maximumNumericDifference','windows','pairs'}:
            return dict(passed=False,reason='decision residual schema',admissionAllowed=False)
        val=dc['maximumNumericDifference']
        if not numeric(val) or not 0 <= val <= DECISION_AUDIT_LIMIT:
            return dict(passed=False,reason='decision residual limit',admissionAllowed=False)
        residuals.append(dict(role=label,value=val,limit=DECISION_AUDIT_LIMIT))
        dc['maximumNumericDifference']=0.0
    result=v1.compare_audits(a,b,bounds,v1.VERSION)
    return dict(result,policy=VERSION,decisionResiduals=residuals)


def decision_margins(record):
    """Conservative guards on gates actually visited by the frozen verifier.

    Four times the derived budget covers the <=3 changing operands in the
    audited dwell/crossfit gate expressions. This is a comparison separation
    guard, not a bound on unmodelled physics or a general stability theorem.
    """
    issues=[]; checked=[]
    def gate(path,value,limit,guard=4*DERIVED_CAP):
        if not numeric(value) or not numeric(limit):
            issues.append(dict(path=path,reason='non-finite margin'))
            return
        gap=abs(value-limit)
        checked.append(dict(path=path,distance=gap,guard=guard))
        if gap<=guard:
            issues.append(dict(path=path,reason='threshold-near',distance=gap,guard=guard))
    ver=record.get('verification')
    if ver is None:
        return dict(passed=True,applicable=False,checks=[],issues=[],admissionAllowed=False)
    try:
        for ai,arm in enumerate(ver['arms']):
            d=arm['decision']; c=d.get('candidate')
            if c is None:
                # Unsupported continuous-motion contracts are already checked
                # by the unchanged independent auditor; no numeric exception.
                continue
            visits=arm['observation']['visits']
            for i in range(0,len(visits),2):
                gate(f'arm/{ai}/signal/{i}',statistics.median(s['value'] for s in visits[i]['samples']),.16,2*CONCENTRATION_CAP)
            if 'geometry' not in c:
                continue  # Early abstention; no fit diagnostics are relaxed.
            model=c['geometry']
            if model['admitted']:
                gate(f'arm/{ai}/fit',model['rmseUpper'],.003)
                gate(f'arm/{ai}/curvature',model['eigenMaxUpper'],-.006)
                if model.get('peakNormUpper') is not None:
                    gate(f'arm/{ai}/peak',model['peakNormUpper'],1.)
            for i,w in enumerate(c['dwell']['windows']):
                if w['state']=='indeterminate':
                    continue
                gate(f'arm/{ai}/dwell/{i}/upper',w['range']+w['spatialChangeUpper'],w['tolerance'])
                gate(f'arm/{ai}/dwell/{i}/lower',w['range']-w['spatialChangeUpper'],w['tolerance'])
            for i,p in enumerate(c['crossfit']['pairs']):
                m=p['envelope']
                if m['admitted']:
                    gate(f'arm/{ai}/crossfit/{i}/fit',m['rmseUpper'],.003)
                if p['state']!='indeterminate':
                    gate(f'arm/{ai}/crossfit/{i}/upper',p['residual']+p['totalAllowance'],p['tolerance'])
                    gate(f'arm/{ai}/crossfit/{i}/lower',p['residual']-p['totalAllowance'],p['tolerance'])
    except (KeyError,TypeError,ValueError,IndexError) as error:
        issues.append(dict(reason='margin schema',error=str(error)))
    return dict(passed=not issues,applicable=True,checks=checked,issues=issues,admissionAllowed=False)


def comparison_gate(reference,candidate,ref_details,details,bounds,ref_endpoint,endpoint):
    """Caller MUST run both full audits; this helper cannot accept an AWS job."""
    h=compare_history(reference,candidate)
    a=compare_audits(ref_details,details,bounds)
    e=v1.compare(ref_endpoint,endpoint)
    margins=[decision_margins(x) for x in (reference,candidate)]
    return dict(version=VERSION,candidateChecksPassed=h['passed'] and a['passed'] and e['passed']
        and all(m['passed'] for m in margins),history=h,audit=a,endpoint=e,decisionMargins=margins,
        accepted=False,admissionAllowed=False,awsSmokeRequired=True,awsRepeatabilityRequired=True)
