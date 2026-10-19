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
from lib.si_fine_scheduling_statistics import summarize,select_primary
from lib.si_scheduling_statistics import ARMS


def sha(b):return hashlib.sha256(b).hexdigest()


def run(job):
    path,item,config,spec,mode=job;body=Path(path).read_bytes();assert sha(body)==item['sha256'] and len(body)==item['bytes']
    record=json.loads(gzip.decompress(body));assert record['spec']==spec and record['config']==config and record['development'] is None
    assert item['replay']['passed'] and item['replay']['schedulingTraceMatched'] and item['replay']['privateFieldQueries']==0
    if mode=='preflight':
        c=item['compatibility'];assert c['passed'];old=Path(c['referenceFile']).read_bytes();assert sha(old)==c['referenceSha256']
        reference=json.loads(gzip.decompress(old))
        assert {k:v for k,v in spec.items() if k not in ['studyId','caseRole']}==reference['spec']
        assert record.keys()==reference.keys()
        for key in record:
            if key=='spec':continue
            if key=='summary':assert {k:v for k,v in record[key].items() if k!='rpcMilliseconds'}=={k:v for k,v in reference[key].items() if k!='rpcMilliseconds'}
            else:assert record[key]==reference[key],key
    else:assert item['compatibility'] is None
    checked=audit(record);data=compact(record);data['schedule']=checked['schedule']
    if mode=='preflight' or spec['caseRole']=='primary' and spec['worldIndex'] not in [0,5,10,15]:
        for key in ['positions','scalar','directional','phaseLabels']:data.pop(key)
    return dict(index=spec['index'],audit=checked,replay=item['replay'],compatibility=item['compatibility']),data


def main():
    p=argparse.ArgumentParser();p.add_argument('--mode',choices=['preflight','campaign'],default='preflight');args=p.parse_args();start=time.monotonic()
    root=Path(f'research/evidence/si_fine_scheduling_{args.mode}_2026-09-17');out=Path(f'research/results/si_fine_scheduling_{args.mode}_2026-09-17');out.mkdir();details=[];records=[]
    try:
        mb=(root/'manifest.json').read_bytes();m=json.loads(mb);done=json.loads((root/'complete.json').read_text());count=4 if args.mode=='preflight' else 288
        assert done['complete'] and not done['failures'] and done['manifestSha256']==sha(mb) and m['caseCount']==count and m['mode']==args.mode
        assert all(w['status']=='fulfilled' and w['value']['code']==0 for w in done['workers'])
        assert m['studyId']=='fine-scheduling-v1' and m['witnessWorlds']==[0,5,10,15]
        for s in m['sources']:
            assert sha(Path(s['file']).read_bytes())==s['sha256'],s['file'];assert sha((root/'source-snapshot'/s['name']).read_bytes())==s['sha256']
        lookup={s['index']:(s,c) for s,c in zip(m['cases'],m['configs'])};assert len(lookup)==count
        jobs=[]
        for w in range(4):
            d=root/f'worker-{w}';info=json.loads((d/'complete.json').read_text());assert info['complete'] and len(info['inventory'])==count//4
            assert {f.name for f in d.glob('*.json.gz')}=={i['file'] for i in info['inventory']}
            for item in info['inventory']:
                i=item['index'];assert i%4==w;s,c=lookup[i];jobs.append((str(d/item['file']),item,c,s,args.mode))
        assert sorted(j[1]['index'] for j in jobs)==sorted(lookup)
        with ProcessPoolExecutor(max_workers=4) as pool:
            for detail,record in pool.map(run,jobs):
                details.append(detail);records.append(record)
                if len(details)%6==0 or len(details)==count:print(f'audited {len(details)}/{count}',flush=True)
        triples=[];absent_identical=True;performance=None
        if args.mode=='campaign':
            assert m['primaryCount']==192;select_primary(records)
            for world in m['witnessWorlds']:
                for field in ['si-continuous','si-pulse','blank']:
                    for method,policy in ARMS:
                        group=sorted([r for r in records if r['spec']['worldIndex']==world and r['spec']['field']==field and r['spec']['method']==method and r['spec']['policy']==policy],key=lambda r:-r['spec']['navDt'])
                        assert [r['spec']['navDt'] for r in group]==[1/16,1/32,1/64];triples.append(compare(group))
                        if field=='blank':absent_identical &= all(np.array_equal(group[0][k],r[k]) for r in group for k in ['positions','scalar','directional'])
            assert len(triples)==48
        coupled=all(t['passed'] for t in triples) if args.mode=='campaign' else None
        absent=all(r['nomination'] is None and not r['decisions'] and not r['metrics']['encounter'] and (r['spec']['policy']!='encounter-gated' or r['schedule']['requestedScans']==0) for r in records if r['spec']['field']=='blank') if args.mode=='campaign' else None
        if args.mode=='campaign' and coupled and absent and absent_identical:performance=summarize(records)
        result=dict(schemaVersion='si-fine-scheduling-audit-v1',mode=args.mode,integrityPassed=True,compatibilityPassed=all(d['compatibility']['passed'] for d in details) if args.mode=='preflight' else None,
            coupledResolutionPassed=coupled,absentControlPassed=absent,absentBitIdentical=bool(absent_identical) if args.mode=='campaign' else None,manifestSha256=sha(mb),sourceCount=len(m['sources']),
            errors={k:max(d['audit']['errors'].get(k,0.) for d in details) for k in {k for d in details for k in d['audit']['errors']}},
            counts={k:sum(d['audit'][k] for d in details) for k in ['traceRows','fieldValuesChecked','inletGeometriesChecked','filteredValuesChecked','publicMeasurementsChecked','navigationStepsChecked','antipodalTies']},
            details=details,triples=triples,performance=performance,runs=[{k:v for k,v in r.items() if k not in ['positions','scalar','directional','phaseLabels']} for r in sorted(records,key=lambda r:r['spec']['index'])],elapsedSeconds=time.monotonic()-start)
        body=(json.dumps(result,indent=2,allow_nan=False)+'\n').encode()
        with (out/'analysis.json').open('xb') as f:f.write(body)
        flags={k:result[k] for k in ['integrityPassed','compatibilityPassed','coupledResolutionPassed','absentControlPassed','absentBitIdentical']}
        with (out/'complete.json').open('x') as f:json.dump(dict(complete=True,**flags,analysisSha256=sha(body),elapsedSeconds=time.monotonic()-start),f,indent=2)
        print(json.dumps(dict(mode=args.mode,**flags,elapsedSeconds=result['elapsedSeconds'])),flush=True)
        for t in triples:
            if not t['passed']:print(json.dumps(dict(world=t['worldIndex'],field=t['field'],method=t['method'],policy=t['policy'],failed=[k for k,v in t['gates'].items() if not v])),flush=True)
    except Exception as e:
        with (out/'failure.json').open('x') as f:json.dump(dict(complete=False,error=f'{type(e).__name__}: {e}',completedCases=[d['index'] for d in details]),f,indent=2)
        raise


if __name__=='__main__':main()
