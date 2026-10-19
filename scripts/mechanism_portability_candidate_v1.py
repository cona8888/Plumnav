"""Prospective, diagnostic-only binary64 comparison. Not an admission policy.

Default remains strict. This module does not replace the frozen full-history
auditor, replay, checksums, registry binding, or exact endpoint check.
"""
import math
import struct

VERSION = 'mechanism-portability-candidate-v1'
MODES = ('strict', VERSION)
MAX_ULPS = 32
# Independent engineering choices, not fitted to a failed history. Caps use
# 1/16 of the relevant existing audit bound. See the prospective protocol.
LIMITS = {
    'position': ('domain fraction', 1e-12 / 16),
    'heading': ('radian', 1e-10 / 16),
    'distance': ('domain fraction', 1e-10 / 16),
    'direction': ('dimensionless', 1e-10 / 16),
    'duration': ('second', 1e-10 / 16),
    'speed': ('domain fraction / second', 1e-10 / 16),
    'angularTolerance': ('radian', 1e-24 / 16),
    'concentration': ('normalised concentration', 1e-12 / 16),
    'wind': ('domain fraction / second', 1e-12 / 16),
}


def field_kind(p):
    """Allowlist only measured/derived continuous fields; everything else exact."""
    if len(p) == 3 and p[0] == 'trace' and type(p[1]) is int and type(p[2]) is int:
        col = p[2]
        if col in (1, 2) or 4 <= col < 12:
            return 'position'
        if col == 3:
            return 'heading'
        if 12 <= col < 24:
            return 'concentration'
    if len(p) < 3 or type(p[1]) is not int:
        return None
    root, tail = p[0], p[2:]
    if root == 'segments':
        if tail in (('direction', 'x'), ('direction', 'y')):
            return 'direction'
        if tail == ('angularTolerance',):
            return 'angularTolerance'
        if tail in (('turnSeconds',), ('moveSeconds',)):
            return 'duration'
        if tail == ('speed',):
            return 'speed'
        if tail and tail[0] == 'initial':
            tail = tail[1:]
        else:
            return None
    elif root not in ('controls', 'navigation', 'observations'):
        return None
    if tail in (('position', 'x'), ('position', 'y')):
        return 'position'
    if root != 'observations' and tail in (('heading',), ('distance',)):
        return tail[0]
    if root == 'controls' and tail[0] == 'measurement':
        tail = tail[1:]
    elif root != 'observations':
        return None
    if tail == ('concentration',):
        return 'concentration'
    if tail in (('wind', 'x'), ('wind', 'y')):
        return 'wind'
    if len(tail) >= 3 and tail[0] == 'localInletReadings' and type(tail[1]) is int:
        if tail[2:] == ('concentration',):
            return 'concentration'
        if tail[2:] in (('effectiveOffset', 'x'), ('effectiveOffset', 'y')):
            return 'position'
    if (len(tail) == 4 and tail[:2] == ('quadSniff', 'readings')
            and type(tail[2]) is int and tail[3] == 'concentration'):
        return 'concentration'
    return None


def ulps(a, b):
    # Only same-sign finite non-zero floats reach here. Ordered magnitudes have
    # integer bit-pattern distance even across exponent/subnormal boundaries.
    return abs(struct.unpack('>Q', struct.pack('>d', a))[0]
               - struct.unpack('>Q', struct.pack('>d', b))[0])


def compare(left, right, mode='strict'):
    if mode not in MODES:
        raise ValueError('Unknown comparison policy')
    result = dict(policy=mode, passed=True, exact=True, unequalScalars=0,
                  allowedRoundoffScalars=0, rejectedDifferences=0,
                  byField={}, examples=[], admissionAllowed=False)

    def reject(p, reason, a=None, b=None):
        result['passed'] = result['exact'] = False
        result['rejectedDifferences'] += 1
        if len(result['examples']) < 20:
            # repr keeps non-finite corrupt inputs serialisable in failure reports.
            result['examples'].append(dict(path='/' + '/'.join(map(str, p)),
                                           reason=reason, left=repr(a), right=repr(b)))

    def visit(a, b, p):
        if type(a) is not type(b):
            reject(p, 'type', type(a).__name__, type(b).__name__)
        elif type(a) is dict:
            if a.keys() != b.keys():
                reject(p, 'keys', sorted(a), sorted(b))
            for k in a:
                if k in b:
                    visit(a[k], b[k], p + (k,))
        elif type(a) is list:
            if len(a) != len(b):
                reject(p, 'length', len(a), len(b))
            for i, (x, y) in enumerate(zip(a, b)):
                visit(x, y, p + (i,))
        elif type(a) is float:
            if not math.isfinite(a) or not math.isfinite(b):
                reject(p, 'non-finite', a, b)
                return
            if a == b and math.copysign(1, a) == math.copysign(1, b):
                return
            result['exact'] = False
            result['unequalScalars'] += 1
            kind = field_kind(p)
            if mode == 'strict' or kind is None:
                reject(p, 'exact-field', a, b)
                return
            if a == 0 or b == 0 or math.copysign(1, a) != math.copysign(1, b):
                reject(p, 'zero-or-sign-change', a, b)
                return
            unit, cap = LIMITS[kind]
            distance = ulps(a, b)
            error = abs(a - b)
            g = result['byField'].setdefault(kind, dict(unit=unit, absoluteCap=cap,
                    differingScalars=0, maxAbsoluteDifference=0., maxUlps=0))
            g['differingScalars'] += 1
            g['maxAbsoluteDifference'] = max(g['maxAbsoluteDifference'], error)
            g['maxUlps'] = max(g['maxUlps'], distance)
            if distance <= MAX_ULPS and error <= cap:
                result['allowedRoundoffScalars'] += 1
            else:
                reject(p, 'roundoff-budget', a, b)
        elif type(a) not in (str, int, bool, type(None)):
            reject(p, 'unsupported-type', type(a).__name__, type(b).__name__)
        elif a != b:
            result['unequalScalars'] += 1
            reject(p, 'exact-field', a, b)

    visit(left, right, ())
    return result


def compare_audits(left, right, bounds, mode='strict'):
    """Residuals must meet unchanged equation limits, not equal one another.

    Callers must execute the independent auditor, not supply an attestation.
    All non-residual audit details remain exact. The complete residuals are saved.
    """
    if mode not in MODES:
        raise ValueError('Unknown comparison policy')
    if mode == 'strict':
        return compare(left, right)
    metadata = compare({k: v for k, v in left.items() if k != 'errors'},
                       {k: v for k, v in right.items() if k != 'errors'})
    a, b = left.get('errors'), right.get('errors')
    invalid = []
    if type(a) is not dict or type(b) is not dict or a.keys() != b.keys():
        invalid.append('residual schema')
    else:
        for k in a:
            limit = bounds.get(k)
            if (limit is None or not all(type(v) in (int, float) and math.isfinite(v)
                    and 0 <= v <= limit for v in (a[k], b[k]))):
                invalid.append(k)
    return dict(policy=mode, passed=metadata['passed'] and not invalid,
                exact=compare(left, right)['passed'], metadata=metadata,
                invalidResiduals=invalid, referenceResiduals=a, candidateResiduals=b,
                equationBounds=bounds, admissionAllowed=False)


def compare_reference_guard(bound, actual, inherited=None):
    """Follow a reused receipt to its separately hash-verified original audit.

    The caller must check the inherited file's pinned SHA first. A missing guard
    is not a successful check, and an arbitrary fallback audit is not allowed.
    """
    if bound['guard'] is not None:
        return compare(bound['guard'], actual)
    valid = (bound.get('reusedScientificAudit') is True
             and bound.get('newScientificAudit') is False
             and type(inherited) is dict and inherited.get('passed') is True
             and inherited.get('wholeReferenceMatched') is True
             and inherited.get('caseId') == bound.get('caseId')
             and inherited.get('historySha256') == bound['history']['sha256']
             and type(inherited.get('guard')) is dict
             and compare(bound['details'], inherited.get('details'))['passed'])
    if not valid:
        return dict(passed=False, reason='Invalid reused-audit provenance')
    return dict(compare(inherited['guard'], actual), guardSource='pinned-original-audit')


def write_comparison_receipt(path, reference, candidate, ref_details, details,
                             bounds, ref_endpoint, endpoint, mode='strict'):
    """Write even a rejection BEFORE caller raises; never overwrite evidence."""
    import json
    h = compare(reference, candidate, mode)
    a = compare_audits(ref_details, details, bounds, mode)
    e = compare(ref_endpoint, endpoint)
    result = dict(version=VERSION, candidateChecksPassed=h['passed'] and a['passed']
                  and e['passed'], history=h, audit=a, endpoint=e,
                  actualAuditDetails=details, accepted=False, admissionAllowed=False)
    with path.open('x') as f:
        json.dump(result, f, indent=2, allow_nan=False)
        f.write('\n')
    return result
