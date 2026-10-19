#!/usr/bin/env python3
"""Post-integrity descriptive accounting; cannot alter numerical acceptance."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path


def sha(body):return hashlib.sha256(body).hexdigest()


def costs(record):
    summary=record['summary'];L=record['config']['domainMeters'];stages={}
    for segment in record['segments']:
        stage='acquisition' if segment['start']<summary['acquisitionBudgetSeconds'] else 'drain' if summary['inspectionAt'] is not None and segment['start']<summary['inspectionAt'] else 'inspection'
        row=stages.setdefault(stage,dict(seconds=0.,movingSeconds=0.,turningSeconds=0.,otherStationarySeconds=0.,scanHeldSeconds=0.,wallLimitedIntervals=0,distanceMetres=0.))
        row['seconds']+=segment['duration'];row['turningSeconds']+=segment['turnSeconds'];row['movingSeconds']+=segment['moveSeconds']
        row['otherStationarySeconds']+=segment['duration']-segment['turnSeconds']-segment['moveSeconds']
        row['scanHeldSeconds']+=segment['duration'] if segment['held'] else 0
        row['wallLimitedIntervals']+=int(segment['wallLimited']);row['distanceMetres']+=segment['speed']*segment['moveSeconds']*L
    assert abs(sum(s['seconds'] for s in stages.values())-summary['completedAt'])<1e-9
    assert abs(sum(s['distanceMetres'] for s in stages.values())-summary['pathLengthMetres'])<1e-8
    observations=[o for o in record['observations'] if o['time']<=summary['acquisitionBudgetSeconds']]
    nominee=record['nomination']
    return dict(stageCosts=stages,acquisitionValidReadouts=len(observations),acquisitionHitReadouts=sum(o['hit'] for o in observations),maximumAcquisitionScalar=max(o['concentration'] for o in observations),
                nomineeAgeAtInspectionSeconds=summary['inspectionAt']-nominee['observationTime'] if nominee and summary['inspectionAt'] is not None else None,
                inspectionApproachSeconds=record['visits'][0]['arrivedAt']-summary['inspectionAt'] if record['visits'] and record['visits'][0]['arrivedAt'] is not None else None)


def main():
    p=argparse.ArgumentParser();p.add_argument('--raw',required=True);p.add_argument('--analysis',required=True);p.add_argument('--output',required=True);args=p.parse_args()
    raw=Path(args.raw);audit=Path(args.analysis);output=Path(args.output)
    body=(audit/'analysis.json').read_bytes();a=json.loads(body);done=json.loads((audit/'complete.json').read_text())
    assert done['complete'] and a['integrityPassed'] and sha(body)==done['analysisSha256']
    manifest=(raw/'manifest.json').read_bytes();assert sha(manifest)==a['manifestSha256']
    inventory={}
    for worker in range(4):
        directory=raw/f'worker-{worker}'
        for item in json.loads((directory/'complete.json').read_text())['inventory']:inventory[item['index']]=(directory/item['file'],item['sha256'])
    primary=[]
    for row in a['runs']:
        if row['spec']['navDt']!=1/16:continue
        path,digest=inventory[row['spec']['index']];encoded=path.read_bytes();assert sha(encoded)==digest
        record=json.loads(gzip.decompress(encoded));primary.append(dict(**row,costs=costs(record)))
    previous=json.loads(Path('research/results/si_acquisition_integration_pilot_2026-09-16/analysis.json').read_text())
    paired_gate_change=[]
    if a['panel']=='old-world-diagnostic':
        for row in a['triples']:
            old=next(r for r in previous['triples'] if r['field']==row['field'] and r['method']==row['method'])
            paired_gate_change.append(dict(field=row['field'],method=row['method'],old=old,corrected=row))
    result=dict(descriptiveOnly=True,doesNotOverrideAcceptance=True,panel=a['panel'],analysisSha256=sha(body),primaryRuns=primary,pairedGateChange=paired_gate_change,
                interpretationBoundary='Two independent source/start worlds only; methods, fields, reporting arms and numerical meshes are paired. Not population success rates, algorithm ranking, hardware validation or proof of no leak.')
    output.mkdir();encoded=(json.dumps(result,indent=2,allow_nan=False)+'\n').encode()
    with (output/'diagnosis.json').open('xb') as f:f.write(encoded)
    with (output/'complete.json').open('x') as f:json.dump(dict(complete=True,diagnosisSha256=sha(encoded),sourceSha256=sha(Path(__file__).read_bytes())),f,indent=2)
    print(json.dumps(dict(panel=a['panel'],primaryRuns=len(primary),diagnosisSha256=sha(encoded))))


if __name__=='__main__':main()
