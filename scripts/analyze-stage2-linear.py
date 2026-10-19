#!/usr/bin/env python3
import argparse
from concurrent.futures import ProcessPoolExecutor
import gzip
import hashlib
import json
from pathlib import Path
import time
import numpy as np
from lib.si_linear_audit import audit,compact,compare
from lib.si_scheduling_statistics import ARMS


def sha(b):return hashlib.sha256(b).hexdigest()


def run(job):
    path,item,config,spec=job;body=Path(path).read_bytes();assert sha(body)==item['sha256']
    record=json.loads(gzip.decompress(body));assert record['spec']==spec and record['config']==config and record['development'] is None
    assert item['replay']['passed'] and item['replay']['schedulingTraceMatched'] and item['replay']['privateFieldQueries']==0
    checked=audit(record);data=compact(record);data['schedule']=checked['schedule']
    return dict(index=spec['index'],audit=checked,replay=item['replay']),data


def main():
    p=argparse.ArgumentParser();p.add_argument('--panel',choices=['diagnostic','fresh'],default='diagnostic');args=p.parse_args();start=time.monotonic()
    root=Path(f'research/evidence/si_linear_{args.panel}_2026-09-17');output=Path(f'research/results/si_linear_{args.panel}_2026-09-17');output.mkdir();details=[];records=[]
    try:
        mb=(root/'manifest.json').read_bytes();m=json.loads(mb);done=json.loads((root/'complete.json').read_text());count=36 if args.panel=='diagnostic' else 144
        assert done['complete'] and done['manifestSha256']==sha(mb) and m['caseCount']==count and m['panel']==f'linear-{args.panel}'
        assert len(m['cases'])==len(m['configs'])==count
        for s in m['sources']:
            assert sha(Path(s['file']).read_bytes())==s['sha256'],s['file']
            assert sha((root/'source-snapshot'/s['name']).read_bytes())==s['sha256']
        jobs=[]
        for w in range(4):
            d=root/f'worker-{w}';info=json.loads((d/'complete.json').read_text());assert info['complete'] and len(info['inventory'])==count//4
            for item in info['inventory']:
                i=item['index'];assert i%4==w;jobs.append((str(d/item['file']),item,m['configs'][i],m['cases'][i]))
        assert sorted(j[1]['index'] for j in jobs)==list(range(count))
        with ProcessPoolExecutor(max_workers=4) as pool:
            for detail,record in pool.map(run,jobs):
                details.append(detail);records.append(record)
                if len(details)%6==0:print(f'audited {len(details)}/{count}',flush=True)
        triples=[];absent_identical=True
        for world in sorted({r['spec']['worldIndex'] for r in records}):
            for field in ['si-continuous','si-pulse','blank']:
                for method,policy in ARMS:
                    group=sorted([r for r in records if r['spec']['worldIndex']==world and r['spec']['field']==field and r['spec']['method']==method and r['spec']['policy']==policy],key=lambda r:-r['spec']['navDt']);assert len(group)==3
                    triples.append(compare(group))
                    if field=='blank':absent_identical &= all(np.array_equal(group[0]['positions'],r['positions']) and np.array_equal(group[0]['scalar'],r['scalar']) and np.array_equal(group[0]['directional'],r['directional']) for r in group)
        coupled=all(t['passed'] for t in triples)
        absent=all(r['nomination'] is None and not r['decisions'] and not r['metrics']['encounter'] and (r['spec']['policy']!='encounter-gated' or r['schedule']['requestedScans']==0) for r in records if r['spec']['field']=='blank')
        result=dict(schemaVersion='si-linear-response-audit-v1',panel=args.panel,integrityPassed=True,coupledResolutionPassed=coupled,absentControlPassed=absent,absentBitIdentical=bool(absent_identical),manifestSha256=sha(mb),sourceCount=len(m['sources']),
            errors={k:max(d['audit']['errors'].get(k,0.) for d in details) for k in {k for d in details for k in d['audit']['errors']}},
            counts={k:sum(d['audit'][k] for d in details) for k in ['traceRows','fieldValuesChecked','inletGeometriesChecked','filteredValuesChecked','publicMeasurementsChecked','navigationStepsChecked','antipodalTies']},
            details=details,triples=triples,performance=None,runs=[{k:v for k,v in r.items() if k not in ['positions','scalar','directional','phaseLabels']} for r in sorted(records,key=lambda r:r['spec']['index'])],elapsedSeconds=time.monotonic()-start)
        body=(json.dumps(result,indent=2,allow_nan=False)+'\n').encode()
        with (output/'analysis.json').open('xb') as f:f.write(body)
        with (output/'complete.json').open('x') as f:json.dump(dict(complete=True,integrityPassed=True,coupledResolutionPassed=coupled,absentControlPassed=absent,absentBitIdentical=bool(absent_identical),analysisSha256=sha(body),elapsedSeconds=time.monotonic()-start),f,indent=2)
        print(json.dumps({k:v for k,v in result.items() if k in ['panel','integrityPassed','coupledResolutionPassed','absentControlPassed','absentBitIdentical','counts','elapsedSeconds']}),flush=True)
        for t in triples:
            if not t['passed']:print(json.dumps(dict(world=t['worldIndex'],field=t['field'],method=t['method'],policy=t['policy'],failed=[k for k,v in t['gates'].items() if not v])),flush=True)
    except Exception as e:
        with (output/'failure.json').open('x') as f:json.dump(dict(complete=False,integrityPassed=False,error=f'{type(e).__name__}: {e}',completedCases=[d['index'] for d in details]),f,indent=2)
        raise


if __name__=='__main__':main()
