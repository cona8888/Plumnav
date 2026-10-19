#!/usr/bin/env python3
"""Descriptive diagnosis only; never changes Stage 2c's frozen acceptance gates."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import numpy as np


def sha(body):return hashlib.sha256(body).hexdigest()
def point(p):return np.array([p['x'],p['y']])


def turning_credit(record):
    """Integrator diagnostic, not a counterfactual rerun or causal attribution."""
    nav=record['navigation'];c=record['config'];omega=c['localInletSampling']['maximumTurnRateRadiansPerSecond']
    events=[]
    for row,nxt in zip(nav,nav[1:]):
        v=point(row['decision']['direction'])
        if np.linalg.norm(v)<=1e-9 or np.linalg.norm(point(nxt['position'])-point(row['position']))<=1e-12:continue
        desired=np.arctan2(v[1],v[0]);delta=abs(np.arctan2(np.sin(desired-row['heading']),np.cos(desired-row['heading'])))
        if delta<=1e-10:continue
        speed=c['robotSpeed']*c['domainMeters']*np.clip(row['decision'].get('speedScale',1),0,1)
        events.append(dict(time=row['time'],turnRadians=float(delta),fullTickTranslationCreditMetres=float(speed*delta/omega)))
    return dict(events=len(events),sumFullTickTranslationCreditMetres=sum(e['fullTickTranslationCreditMetres'] for e in events),largestEvent=max(events,key=lambda e:e['fullTickTranslationCreditMetres']) if events else None,
                meaning='Translation credited during the residual alignment time in the existing full-tick update; not the actual error against an event-exact closed-loop run.')


def mission_costs(record):
    c=record['config'];summary=record['summary'];dt=c['fixedDt'];costs={}
    for row,nxt in zip(record['navigation'],record['navigation'][1:]):
        stage='acquisition' if row['time']<summary['acquisitionBudgetSeconds'] else 'drain' if summary['inspectionAt'] is not None and row['time']<summary['inspectionAt'] else 'inspection'
        v=costs.setdefault(stage,dict(seconds=0.,distanceMetres=0.,movingSeconds=0.,stationaryTurningSeconds=0.,stationaryOtherSeconds=0.))
        distance=np.linalg.norm(point(nxt['position'])-point(row['position']))*c['domainMeters'];angle=abs(np.arctan2(np.sin(nxt['heading']-row['heading']),np.cos(nxt['heading']-row['heading'])))
        v['seconds']+=dt;v['distanceMetres']+=float(distance)
        v['movingSeconds' if distance>1e-12 else 'stationaryTurningSeconds' if angle>1e-10 else 'stationaryOtherSeconds']+=dt
    observations=[o for o in record['observations'] if o['time']<=summary['acquisitionBudgetSeconds']]
    return dict(stageCosts=costs,acquisitionValidReadouts=len(observations),acquisitionHitReadouts=sum(o['hit'] for o in observations),maximumAcquisitionScalar=max(o['concentration'] for o in observations),
                inspectionApproachSeconds=record['visits'][0]['arrivedAt']-summary['inspectionAt'] if record['visits'] and record['visits'][0]['arrivedAt'] is not None else None)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--raw',default='research/evidence/si_acquisition_integration_pilot_2026-09-16');parser.add_argument('--analysis',default='research/results/si_acquisition_integration_pilot_2026-09-16');parser.add_argument('--output',default='research/results/si_acquisition_integration_diagnosis_2026-09-16');args=parser.parse_args()
    raw=Path(args.raw);analysis=Path(args.analysis);output=Path(args.output);output.mkdir()
    body=(analysis/'analysis.json').read_bytes();a=json.loads(body);complete=json.loads((analysis/'complete.json').read_text())
    assert complete['complete'] and a['integrityPassed'] and sha(body)==complete['analysisSha256']
    manifest=(raw/'manifest.json').read_bytes();assert sha(manifest)==a['manifestSha256']
    inventory={}
    for worker in range(4):
        d=raw/f'worker-{worker}'
        for item in json.loads((d/'complete.json').read_text())['inventory']:inventory[item['index']]=(d/item['file'],item['sha256'])
    def load(index):
        path,digest=inventory[index];body=path.read_bytes();assert sha(body)==digest
        return json.loads(gzip.decompress(body))
    diagnosis=[]
    for triple in a['triples']:
        middle=load(triple['indices'][1]);fine=load(triple['indices'][2]);n=min(len(middle['controls']),len(fine['controls']))
        pairs=list(zip(middle['controls'][:n],fine['controls'][:n]))
        position=np.array([np.linalg.norm(point(x['position'])-point(y['position']))*10 for x,y in pairs])
        first=lambda pred:next((x['time'] for x,y in pairs if pred(x,y)),None)
        phase=first(lambda x,y:x['stage']!=y['stage'] or x['decision']['phase']!=y['decision']['phase'])
        hit=first(lambda x,y:x['measurement']['valid'] and y['measurement']['valid'] and x['measurement']['hit']!=y['measurement']['hit'])
        mode=first(lambda x,y:x['measurement']['sampleMode']!=y['measurement']['sampleMode'])
        significant=first(lambda x,y:np.linalg.norm(point(x['decision']['direction'])-point(y['decision']['direction']))>.01 or abs(x['decision'].get('speedScale',1)-y['decision'].get('speedScale',1))>.01)
        differences={f'firstPositionDifferenceAbove{threshold:g}m':float(np.flatnonzero(position>threshold)[0]/16) if np.any(position>threshold) else None for threshold in [.001,.01,.1]}
        peak=int(np.argmax(position));x,y=pairs[peak]
        diagnosis.append(dict(**{k:triple[k] for k in ['field','method','indices','gates','passed']},**differences,firstPhaseDifference=phase,firstValidHitDisagreement=hit,firstSamplingModeDisagreement=mode,firstSignificantCommandDifference=significant,maximumPositionDifference=dict(time=x['time'],metres=float(position[peak]),middlePosition=x['position'],finePosition=y['position'],middlePhase=x['decision']['phase'],finePhase=y['decision']['phase']),
            nominationObservationTimes=[(r['nomination'] or {}).get('observationTime') for r in [middle,fine]],nominationSignal=[(r['nomination'] or {}).get('concentration') for r in [middle,fine]],inspectionStarts=[r['summary']['inspectionAt'] for r in [middle,fine]],endpointTimes=[r['summary']['completedAt'] for r in [middle,fine]],turningDiagnostics=[turning_credit(r) for r in [middle,fine]]))
    primary=[dict(**r,costs=mission_costs(load(r['spec']['index']))) for r in a['runs'] if r['spec']['navDt']==1/16]
    result=dict(descriptiveOnly=True,doesNotOverrideAcceptance=True,analysisSha256=sha(body),diagnosis=diagnosis,primaryRuns=primary)
    content=(json.dumps(result,indent=2,allow_nan=False)+'\n').encode()
    with (output/'diagnosis.json').open('xb') as f:f.write(content)
    with (output/'complete.json').open('x') as f:json.dump(dict(complete=True,diagnosisSha256=sha(content),sourceSha256=sha(Path(__file__).read_bytes())),f,indent=2)
    print(json.dumps(diagnosis,indent=2))


if __name__=='__main__':main()
