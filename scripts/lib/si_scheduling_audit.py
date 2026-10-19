"""Independent encounter latch audit, on top of frozen event/motion/sensor/v4 audit."""
import math
from lib.si_event_integration_audit_v2 import audit as event_audit,compact,compare


def eligible(m):
    values=m.get('localInletReadings',[])
    return bool(m['valid'] and m['hit'] and math.isfinite(m['concentration']) and m['concentration']>=.115 and m['sampleMode'] in ['passive','quad-passive-return'] and len(values)==4 and len({r['channel'] for r in values})==4 and all(math.isfinite(r['concentration']) and not r['saturated'] for r in values))


def scheduling_checks(record):
    assert record['schedulingVersion']=='encounter-gate-v1'
    policy=record['spec']['policy'];assert policy in ['reference','encounter-gated']
    if policy=='encounter-gated':assert record['spec']['method']=='quad-sniff-refine'
    rows=[r for r in record['controls'] if r['stage']=='acquisition'];trace=record['schedulingTrace'];assert len(rows)==len(trace)
    first=None;queries=0;scans=0
    for row,t in zip(rows,trace):
        hit=eligible(row['measurement'])
        if hit and first is None:first=row['time']
        assert t['time']==row['time'] and t['eligible']==hit and t['firstEligibleTime']==first and t['latched']==(first is not None)
        requested=row['decision'].get('quadSniff',{}).get('scanId');assert t['requestedScanId']==requested
        scans+=requested is not None
        if policy=='reference':assert t['queries']==[]
        else:
            if first is None:assert requested is None
            for query in t['queries']:
                queries+=1
                if first is None:assert query==dict(allowed=False,originalResult=None)
                else:assert type(query['originalResult']) is bool and query['allowed']==query['originalResult']
    if policy=='encounter-gated':
        for segment in record['segments']:
            if segment['start']<record['summary']['acquisitionBudgetSeconds'] and (first is None or segment['start']<first):assert not segment['held']
    return dict(firstEligibleControlTime=first,predicateQueries=queries,requestedScans=scans,traceRows=len(trace))


def metrics(record):
    summary=record['summary'];budget=summary['acquisitionBudgetSeconds'];L=record['config']['domainMeters'];dt=record['config']['fixedDt']
    observations=[o for o in record['observations'] if o['time']<=budget];first=next((o for o in observations if eligible(o)),None)
    segments=[s for s in record['segments'] if s['start']<budget]
    distance=sum(s['speed']*s['moveSeconds']*L for s in segments)
    return dict(encounter=first is not None,firstEligibleTime=first['time'] if first else None,restrictedEncounterSeconds=first['time'] if first else budget,
                distanceAtEncounterOrSearchEnd=record['navigation'][round(first['time']/dt)]['distance']*L if first else distance,
                acquisitionDistanceMetres=distance,scanHeldSeconds=sum(s['duration'] for s in segments if s['held']),turningSeconds=sum(s['turnSeconds'] for s in segments),movingSeconds=sum(s['moveSeconds'] for s in segments),
                validReadouts=len(observations),eligibleReadouts=sum(eligible(o) for o in observations),maximumScalar=max(o['concentration'] for o in observations),nomination=record['nomination'] is not None,
                inspectionCompleted=summary['stage']=='inspection-complete',supportedExact=any(a['poseRadiusMetres']==0 and a['decision']['status']=='supported' for a in (record['verification'] or {}).get('arms',[])),
                supportedJitter=any(a['poseRadiusMetres']==.001 and a['decision']['status']=='supported' for a in (record['verification'] or {}).get('arms',[])),
                completedAt=summary['completedAt'],airLitres=summary['airLitres'])


def audit(record):
    result=event_audit(record);result['schedule']=scheduling_checks(record)
    return result
