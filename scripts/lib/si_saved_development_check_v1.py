"""Independent terminal projection checker, not a forward/sensor/fit audit."""
from decimal import Decimal, localcontext


def check(record, extracted):
    s = record['summary']; field = record['spec']['field']; blank = field == 'blank'
    nominated = record['nomination'] is not None
    status = None; report_present = False; error = None
    if s['stage'] == 'inspection-complete':
        arm = record['verification']['arms'][0]; status = arm['decision']['status']
        out = s['errors'][0]; report_present = out['reportedPoint'] is not None; error = out['sourceErrorMetres']
        assert (status == 'supported') == report_present
        if report_present:
            with localcontext() as ctx:
                ctx.prec = 70
                dec = lambda value: Decimal(str(value))
                length = dec(record['config']['domainMeters'])
                origin = record['nomination']['point']; peak = arm['decision']['candidate']['geometry']['peak']
                p = out['reportedPoint']
                for i, axis in enumerate(('x', 'y')):
                    expected = dec(origin[axis]) + Decimal('0.1')/length*dec(peak[i])
                    assert abs(dec(p[axis])-expected) <= Decimal('1e-12')
                if blank:
                    assert error is None
                else:
                    source = record['config']['sourcePositionOverride']
                    distance = sum((dec(p[a])-dec(source[a]))**2 for a in ('x', 'y')).sqrt()*length
                    assert abs(dec(error)-distance) <= Decimal('1e-10')
                    assert (dec(error) <= Decimal('0.1')) == (distance <= Decimal('0.1'))
    meta = dict(auditPassed=True, field=field, stage=s['stage'], nominationPresent=nominated,
                nominalStatus=status, reportedPointPresent=report_present, sourceErrorMetres=error)
    if not nominated:
        category = 'blank-no-nomination' if blank else 'no-nomination'
    elif s['stage'] == 'mission-budget-exhausted':
        category = 'blank-inspection-incomplete' if blank else 'inspection-incomplete'
    elif status == 'abstained':
        category = 'blank-verifier-abstained' if blank else 'verifier-abstained'
    elif blank:
        category = 'blank-supported-report'
    else:
        category = 'within-tolerance-report' if Decimal(str(error)) <= Decimal('0.1') else 'out-of-tolerance-report'
    expected = dict(applicable=not blank, success=None if blank else category == 'within-tolerance-report', category=category)
    if blank:
        expected['blankControls'] = dict(falseNomination=nominated, inspectionCompleted=s['stage'] == 'inspection-complete', falseReport=report_present)
    assert meta == extracted['metadata'] and expected == extracted['endpoint']
    return dict(passed=True, comparedMetadataFields=len(meta), category=category,
                decimalPrecision=70, fullScientificAuditExecuted=False)
