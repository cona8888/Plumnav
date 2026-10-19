"""Strict compact-metadata endpoint check for a proposed future campaign.

Caller attestations must later be bound to real audit/history hashes. This module
does not load simulations, infer missing values, or validate physical releases.
"""
import math

VERSION='release-endpoint-stability-v1'
KEYS={'auditPassed','field','stage','nominationPresent','nominalStatus','reportedPointPresent','sourceErrorMetres'}
STAGES={'no-eligible-nomination','mission-budget-exhausted','inspection-complete'}

def endpoint(meta):
    if not isinstance(meta,dict) or set(meta)!=KEYS:raise ValueError('Exact endpoint metadata keys required')
    if meta['auditPassed'] is not True:raise ValueError('Independent audit must have passed')
    field=meta['field'];stage=meta['stage'];status=meta['nominalStatus'];error=meta['sourceErrorMetres']
    if field not in ('si-continuous','si-pulse','blank') or stage not in STAGES:raise ValueError('Unknown field or stage')
    if type(meta['nominationPresent']) is not bool or type(meta['reportedPointPresent']) is not bool:raise ValueError('Explicit boolean state required')
    nominated=meta['nominationPresent'];reported=meta['reportedPointPresent']
    if status not in (None,'supported','abstained'):raise ValueError('Unknown nominal status')
    if error is not None and (type(error) not in (int,float) or not math.isfinite(error) or error<0):raise ValueError('Invalid source error')
    if stage=='no-eligible-nomination' and nominated:raise ValueError('Nomination contradicts terminal state')
    if stage in ('mission-budget-exhausted','inspection-complete') and not nominated:raise ValueError('Missing nomination for terminal state')
    if stage!='inspection-complete':
        if status is not None or reported or error is not None:raise ValueError('Incomplete inspection cannot contain a report')
    else:
        if status is None:raise ValueError('Completed inspection requires explicit verifier status')
        if (status=='supported')!=reported:raise ValueError('Nominal support/report mismatch')
        if reported!=(error is not None):raise ValueError('Report/error mismatch')
    if field=='blank':
        if nominated or status is not None or reported or error is not None:raise ValueError('Blank localisation outside this admitted metadata contract')
        return dict(applicable=False,success=None,category='blank-not-applicable')
    if not nominated:return dict(applicable=True,success=False,category='no-nomination')
    if stage=='mission-budget-exhausted':return dict(applicable=True,success=False,category='inspection-incomplete')
    if status=='abstained':return dict(applicable=True,success=False,category='verifier-abstained')
    success=error<=.10
    return dict(applicable=True,success=success,category='within-tolerance-report' if success else 'out-of-tolerance-report')

def refinement_check(witness):
    if not isinstance(witness,dict) or set(witness)!={'parentNumericalPassed','resolutions'}:raise ValueError('Exact witness keys required')
    if type(witness['parentNumericalPassed']) is not bool:raise ValueError('Explicit parent-gate boolean required')
    rows=witness['resolutions']
    if not isinstance(rows,list) or len(rows)!=3:raise ValueError('Three ordered resolutions required')
    for row in rows:
        if not isinstance(row,dict) or set(row)!={'worldKey','arm','navDt','endpoint'}:raise ValueError('Exact resolution metadata keys required')
        if not isinstance(row['worldKey'],str) or not row['worldKey']:raise ValueError('Missing world identity')
        if row['arm'] not in ('RW','GW','RL','GL','NS'):raise ValueError('Unknown arm')
    if [r['navDt'] for r in rows]!=['1/16','1/32','1/64']:raise ValueError('Wrong resolution order')
    if len({r['worldKey'] for r in rows})!=1 or len({r['arm'] for r in rows})!=1:raise ValueError('Mixed world or treatment')
    states=[endpoint(r['endpoint']) for r in rows]
    if len({r['endpoint']['field'] for r in rows})!=1:raise ValueError('Mixed fields')
    applicable=all(s['applicable'] for s in states)
    stable=len({s['success'] for s in states})==1
    return dict(version=VERSION,parentNumericalPassed=witness['parentNumericalPassed'],localisationApplicable=applicable,endpointStable=stable,passed=witness['parentNumericalPassed'] and stable,states=states,physicalValidation=False)
