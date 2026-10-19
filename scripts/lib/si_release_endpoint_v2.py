"""Separate blank-control extension; emitting endpoint v1 remains unchanged."""
from lib.si_release_endpoint_v1 import KEYS, endpoint as emitting_endpoint, refinement_check as emitting_refinement

VERSION='release-endpoint-stability-v2'
BLANK_CATEGORIES=('blank-no-nomination','blank-inspection-incomplete','blank-verifier-abstained','blank-supported-report')


def endpoint(meta):
    if type(meta) is not dict or set(meta)!=KEYS:
        raise ValueError('Exact endpoint metadata keys required')
    if meta['field']!='blank':
        return emitting_endpoint(meta)
    if meta['auditPassed'] is not True:
        raise ValueError('Independent audit must have passed')
    if type(meta['nominationPresent']) is not bool or type(meta['reportedPointPresent']) is not bool:
        raise ValueError('Explicit boolean state required')
    if meta['sourceErrorMetres'] is not None:
        raise ValueError('Blank release error is not applicable')
    state=(meta['stage'],meta['nominationPresent'],meta['nominalStatus'],meta['reportedPointPresent'])
    states=[('no-eligible-nomination',False,None,False),
            ('mission-budget-exhausted',True,None,False),
            ('inspection-complete',True,'abstained',False),
            ('inspection-complete',True,'supported',True)]
    if state not in states:
        raise ValueError('Inconsistent blank terminal state')
    category=BLANK_CATEGORIES[states.index(state)]
    return dict(applicable=False,success=None,category=category,
                blankControls=dict(falseNomination=meta['nominationPresent'],
                                   inspectionCompleted=meta['stage']=='inspection-complete',
                                   falseReport=meta['reportedPointPresent']))


def refinement_check(witness):
    if type(witness) is not dict or set(witness)!={'parentNumericalPassed','resolutions'}:
        raise ValueError('Exact witness keys required')
    if type(witness['parentNumericalPassed']) is not bool:
        raise ValueError('Explicit parent-gate boolean required')
    rows=witness['resolutions']
    if type(rows) is not list or len(rows)!=3:
        raise ValueError('Three ordered resolutions required')
    for row in rows:
        if type(row) is not dict or set(row)!={'worldKey','arm','navDt','endpoint'}:
            raise ValueError('Exact resolution metadata keys required')
        if type(row['worldKey']) is not str or not row['worldKey'] or row['arm'] not in ('RW','GW','RL','GL','NS'):
            raise ValueError('Invalid world or arm')
    if [row['navDt'] for row in rows]!=['1/16','1/32','1/64']:
        raise ValueError('Wrong resolution order')
    if len({row['worldKey'] for row in rows})!=1 or len({row['arm'] for row in rows})!=1:
        raise ValueError('Mixed world or arm')
    states=[endpoint(row['endpoint']) for row in rows]
    if len({row['endpoint']['field'] for row in rows})!=1:
        raise ValueError('Mixed fields')
    if rows[0]['endpoint']['field']!='blank':
        result=emitting_refinement(witness)
        return {**result,'version':VERSION,'blankOutcomeStable':None}
    stable=len({state['category'] for state in states})==1
    return dict(version=VERSION,parentNumericalPassed=witness['parentNumericalPassed'],localisationApplicable=False,
                endpointStable=None,blankOutcomeStable=stable,passed=witness['parentNumericalPassed'] and stable,
                states=states,physicalValidation=False)
