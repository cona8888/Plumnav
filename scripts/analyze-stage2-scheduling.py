#!/usr/bin/env python3
import argparse
from concurrent.futures import ProcessPoolExecutor
import gzip
import hashlib
import json
from pathlib import Path
import time
import numpy as np
from lib.si_scheduling_audit import audit,compact,compare,metrics
from lib.si_scheduling_statistics import ARMS,summarize


def sha(body):return hashlib.sha256(body).hexdigest()


def run(job):
    path,item,config,spec=job;body=Path(path).read_bytes();assert sha(body)==item['sha256']
    record=json.loads(gzip.decompress(body));assert record['spec']==spec and record['config']==config
    assert record['development'] is None and all(item['replay'][k] for k in ['passed','schedulingTraceMatched']) and item['replay']['privateFieldQueries']==0
    checked=audit(record);data=compact(record);data['metrics']=metrics(record);data['schedule']=checked['schedule']
    return dict(index=spec['index'],audit=checked,replay=item['replay']),data


def stable_times(values):
    if all(v is None for v in values):return True
    return all(v is not None for v in values) and max(values)-min(values)<=1


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',default='research/evidence/si_encounter_scheduling_2026-09-17');p.add_argument('--output',default='research/results/si_encounter_scheduling_2026-09-17');args=p.parse_args()
    start=time.monotonic();root=Path(args.input);output=Path(args.output);output.mkdir();details=[];records=[]
    try:
        mb=(root/'manifest.json').read_bytes();m=json.loads(mb);completion=json.loads((root/'complete.json').read_text())
        assert completion['complete'] and completion['manifestSha256']==sha(mb) and m['caseCount']==240 and m['primaryCount']==192
        for source in m['sources']:
            assert sha(Path(source['file']).read_bytes())==source['sha256'],source['file']
            assert sha((root/'source-snapshot'/source['name']).read_bytes())==source['sha256']
        jobs=[]
        for worker in range(4):
            d=root/f'worker-{worker}';info=json.loads((d/'complete.json').read_text());assert info['complete'] and len(info['inventory'])==60
            for item in info['inventory']:
                i=item['index'];assert i%4==worker;jobs.append((str(d/item['file']),item,m['configs'][i],m['cases'][i]))
        assert sorted(j[1]['index'] for j in jobs)==list(range(240))
        with ProcessPoolExecutor(max_workers=4) as pool:
            for detail,record in pool.map(run,jobs):
                details.append(detail);records.append(record)
                if len(details)%10==0:print(f'audited {len(details)}/240',flush=True)
        triples=[];absent_identical=True
        for world in [0,1]:
            for field in ['si-continuous','si-pulse','blank']:
                for method,policy in ARMS:
                    group=sorted([r for r in records if r['spec']['worldIndex']==world and r['spec']['field']==field and r['spec']['method']==method and r['spec']['policy']==policy],key=lambda r:-r['spec']['navDt']);assert len(group)==3
                    comparison=compare(group);comparison.update(worldIndex=world,policy=policy)
                    comparison['gates']['eligibleEncounterTimeStable']=stable_times([r['metrics']['firstEligibleTime'] for r in group])
                    comparison['gates']['latchTimeStable']=stable_times([r['schedule']['firstEligibleControlTime'] for r in group])
                    comparison['passed']=all(comparison['gates'].values());triples.append(comparison)
                    if field=='blank':absent_identical &= all(np.array_equal(group[0]['positions'],r['positions']) and np.array_equal(group[0]['scalar'],r['scalar']) for r in group)
        coupled=all(t['passed'] for t in triples)
        absent=all(r['nomination'] is None and not r['decisions'] and (r['spec']['policy']!='encounter-gated' or r['schedule']['requestedScans']==0) for r in records if r['spec']['field']=='blank')
        performance=summarize(records) if coupled and absent and absent_identical else None
        result=dict(schemaVersion='si-encounter-scheduling-audit-v1',integrityPassed=True,coupledResolutionPassed=coupled,absentControlPassed=absent,absentBitIdentical=bool(absent_identical),manifestSha256=sha(mb),sourceCount=len(m['sources']),
                    errors={k:max(d['audit']['errors'].get(k,0.) for d in details) for k in {k for d in details for k in d['audit']['errors']}},
                    counts={k:sum(d['audit'][k] for d in details) for k in ['traceRows','fieldValuesChecked','inletGeometriesChecked','filteredValuesChecked','publicMeasurementsChecked','navigationStepsChecked']},
                    details=details,triples=triples,performance=performance,runs=[{k:v for k,v in r.items() if k not in ['positions','scalar']} for r in sorted(records,key=lambda r:r['spec']['index'])],elapsedSeconds=time.monotonic()-start)
        encoded=(json.dumps(result,indent=2,allow_nan=False)+'\n').encode()
        with (output/'analysis.json').open('xb') as f:f.write(encoded)
        with (output/'complete.json').open('x') as f:json.dump(dict(complete=True,integrityPassed=True,coupledResolutionPassed=coupled,absentControlPassed=absent,absentBitIdentical=bool(absent_identical),analysisSha256=sha(encoded),elapsedSeconds=time.monotonic()-start),f,indent=2)
        print(json.dumps({k:v for k,v in result.items() if k in ['integrityPassed','coupledResolutionPassed','absentControlPassed','absentBitIdentical','counts','elapsedSeconds']}),flush=True)
    except Exception as exc:
        with (output/'failure.json').open('x') as f:json.dump(dict(complete=False,integrityPassed=False,error=f'{type(exc).__name__}: {exc}',completedCases=[d['index'] for d in details]),f,indent=2)
        raise


if __name__=='__main__':main()
