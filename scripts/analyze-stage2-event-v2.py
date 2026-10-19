#!/usr/bin/env python3
import argparse
from concurrent.futures import ProcessPoolExecutor
import gzip
import hashlib
import json
from pathlib import Path
import time
import numpy as np
from lib.si_event_integration_audit_v2 import audit,compact,compare


def sha(body):return hashlib.sha256(body).hexdigest()


def run(job):
    path,item,config,spec=job
    body=Path(path).read_bytes();assert sha(body)==item['sha256']
    record=json.loads(gzip.decompress(body));assert record['spec']==spec and record['config']==config
    assert record['development'] is None and item['replay']['passed'] and item['replay']['privateFieldQueries']==0
    result=audit(record)
    return dict(index=spec['index'],audit=result,replay=item['replay']),compact(record)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--input',default='research/evidence/si_event_old_worlds_2026-09-16');parser.add_argument('--output',default='research/results/si_event_old_worlds_audit_v2_2026-09-16');args=parser.parse_args()
    start=time.monotonic();root=Path(args.input);output=Path(args.output);output.mkdir()
    mb=(root/'manifest.json').read_bytes();m=json.loads(mb);completion=json.loads((root/'complete.json').read_text())
    assert completion['complete'] and completion['manifestSha256']==sha(mb)
    for source in m['sources']:
        assert sha(Path(source['file']).read_bytes())==source['sha256'],source['file']
        assert sha((root/'source-snapshot'/source['name']).read_bytes())==source['sha256']
    jobs=[]
    for worker in range(4):
        d=root/f'worker-{worker}';info=json.loads((d/'complete.json').read_text());assert info['complete'] and len(info['inventory'])==9
        for item in info['inventory']:
            i=item['index'];jobs.append((str(d/item['file']),item,m['configs'][i],m['cases'][i]))
    assert sorted(j[1]['index'] for j in jobs)==list(range(36))
    details=[];records=[]
    try:
        with ProcessPoolExecutor(max_workers=4) as pool:
            for detail,record in pool.map(run,jobs):
                details.append(detail);records.append(record);print(f"audited {len(details)}/36: case {detail['index']}",flush=True)
        triples=[]
        for field in ['si-continuous','si-pulse','blank']:
            for method in ['coverage','surge-cast','quad-sniff-refine']:
                group=sorted([r for r in records if r['spec']['replicate']==0 and r['spec']['field']==field and r['spec']['method']==method],key=lambda r:-r['spec']['navDt']);assert len(group)==3
                triples.append(compare(group))
        errors={k:max(d['audit']['errors'].get(k,0.) for d in details) for k in {k for d in details for k in d['audit']['errors']}}
        absent_identical=all(np.array_equal(group[0]['positions'],r['positions']) and np.array_equal(group[0]['scalar'],r['scalar']) for method in ['coverage','surge-cast','quad-sniff-refine'] for group in [[r for r in records if r['spec']['field']=='blank' and r['spec']['replicate']==0 and r['spec']['method']==method]] for r in group)
        result=dict(schemaVersion='si-event-exact-integration-audit-v2',auditSources=[dict(file=str(path),sha256=sha(path.read_bytes())) for path in [Path(__file__),Path('scripts/lib/si_event_motion_audit_v2.py'),Path('scripts/lib/si_event_integration_audit_v2.py'),Path('scripts/test-stage2-event-audit-v2.py'),Path('research/protocols/si_event_audit_amendment_v2_2026-09-16.md')]],panel=m['panel'],absentBitIdentical=absent_identical,integrityPassed=True,coupledResolutionPassed=all(t['passed'] for t in triples),absentControlPassed=all(r['nomination'] is None and not r['decisions'] for r in records if r['spec']['field']=='blank'),manifestSha256=sha(mb),sourceCount=len(m['sources']),errors=errors,
                    counts={k:sum(d['audit'][k] for d in details) for k in ['traceRows','fieldValuesChecked','inletGeometriesChecked','filteredValuesChecked','publicMeasurementsChecked','navigationStepsChecked']},details=details,triples=triples,
                    runs=[{k:v for k,v in r.items() if k not in ['positions','scalar']} for r in sorted(records,key=lambda r:r['spec']['index'])],elapsedSeconds=time.monotonic()-start)
        encoded=(json.dumps(result,indent=2,allow_nan=False)+'\n').encode()
        with (output/'analysis.json').open('xb') as f:f.write(encoded)
        with (output/'complete.json').open('x') as f:json.dump(dict(complete=True,integrityPassed=True,coupledResolutionPassed=result['coupledResolutionPassed'],absentBitIdentical=absent_identical,analysisSha256=sha(encoded),elapsedSeconds=time.monotonic()-start),f,indent=2)
        print(json.dumps({k:v for k,v in result.items() if k in ['integrityPassed','coupledResolutionPassed','absentControlPassed','absentBitIdentical','counts','errors','elapsedSeconds']}),flush=True)
    except Exception as exc:
        with (output/'failure.json').open('x') as f:json.dump(dict(complete=False,integrityPassed=False,error=f'{type(exc).__name__}: {exc}',completedCases=[d['index'] for d in details]),f,indent=2)
        raise


if __name__=='__main__':main()
