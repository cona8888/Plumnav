"""Independent saved-history audit for the SHORT BLANK development gate only."""
import argparse
import copy
import gzip
import hashlib
import json
import math
from pathlib import Path
from datetime import datetime, timezone

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def audit_record(record):
    assert record['development'] == {'acquisitionSeconds':24}
    assert record['spec']['field'] == 'blank' and record['spec']['replicate'] == 3000
    assert record['summary']['completedAt'] == 24
    assert record['summary']['stage'] == 'no-eligible-nomination'
    assert record['nomination'] is None and record['verification'] is None and not record['visits']
    controls=record['controls']; ledger=record['availabilityTrace']; trace=record['trace']
    assert len(controls)==len(ledger)==385 and len(trace)==6145
    assert all(row[0] == i/256 for i,row in enumerate(trace))
    observations=[]
    extra=0
    for i,(control,entry) in enumerate(zip(controls,ledger)):
        t=i/16
        assert control['time']==entry['time']==t
        m=control['measurement']
        assert m['time']==t
        raw_mode=entry['rawMode']; raw_valid=entry['rawValid']
        assert raw_mode in ['passive','blanked','quad-passive-return']
        assert raw_valid == (raw_mode!='blanked' and t.is_integer())
        promoted=record['availability']=='live-passive' and raw_mode=='blanked' and t.is_integer()
        assert m['valid']==entry['effectiveValid']==(raw_valid or promoted)
        assert m['sampleMode']==entry['effectiveMode']==('passive' if promoted else raw_mode)
        if promoted:
            extra+=1
            assert m['quadSniff']['scanId']==entry['scanId']
            assert m['quadSniff']['phase']=='aspirate'
        instrument=trace[i*16]
        measured=[r['concentration'] for r in m['localInletReadings']]
        assert measured==instrument[-4:], 'readout is not the same hardware acquisition'
        assert all(math.isfinite(v) for v in measured)
        assert abs(m['concentration']-sum(measured)/4)<1e-15
        if m['valid']:
            assert t.is_integer()
            observations.append({**m,'position':control['position']})
        if i<len(record['segments']) and raw_mode=='blanked':
            seg=record['segments'][i]
            assert seg['held'] and seg['turnSeconds']==seg['moveSeconds']==seg['speed']==0
            assert controls[i+1]['position']==control['position']
            assert controls[i+1]['heading']==control['heading']
            assert controls[i+1]['distance']==control['distance']
    assert observations==record['observations'], 'eligible observation history mismatch'
    assert len({o['time'] for o in observations})==len(observations)
    return dict(controls=len(controls),instrumentRows=len(trace),observations=len(observations),extraEligibleReadouts=extra)

def normalized(r):
    r=copy.deepcopy(r)
    for key in ['availability','availabilityVersion','availabilityTrace']:
        r.pop(key,None)
    r['summary']['rpcMilliseconds']=0
    return r

def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    done=json.loads((a.input/'complete.json').read_text())
    assert done['passed'] and done['developmentOnly'] and not done['fullMissionAdmitted']
    for s in done['sources']:
        assert sha(Path(s['path']))==s['sha256']
    details=[]; records=[]
    for item in done['smoke']:
        path=a.input/item['file'];assert sha(path)==item['sha256']
        body=gzip.decompress(path.read_bytes());assert hashlib.sha256(body).hexdigest()==item['historySha256']
        r=json.loads(body);result=audit_record(r);records.append(r)
        assert result['observations']==item['observations'] and result['extraEligibleReadouts']==item['extraEligibleReadouts']
        if r['availability']=='original-withheld':
            parent=json.loads(gzip.decompress((a.input/f"{r['spec']['policy']}-parent.json.gz").read_bytes()))
            assert normalized(parent)==normalized(r)
        details.append(dict(file=item['file'],sha256=sha(path),**result))
    live=next(r for r in records if r['availability']=='live-passive' and r['spec']['policy']=='reference')
    def must_reject(mutation):
        r=copy.deepcopy(live);mutation(r)
        try:audit_record(r)
        except AssertionError:return
        raise AssertionError('Corruption was not rejected')
    must_reject(lambda r:r['observations'].pop())
    target=next(i for i,e in enumerate(live['availabilityTrace']) if e['rawMode']=='blanked' and e['effectiveValid'])
    must_reject(lambda r:r['segments'][target].update(held=False))
    must_reject(lambda r:r['controls'][target]['measurement']['localInletReadings'][0].update(concentration=99))
    must_reject(lambda r:r['trace'][1].__setitem__(0,123))
    out=dict(schemaVersion='short-readout-history-audit-v1',createdAt=datetime.now(timezone.utc).isoformat(),acceptedFor='24-second blank interface development only',completeSha256=sha(a.input/'complete.json'),scriptSha256=sha(Path(__file__)),histories=details,sameHostOriginalReferences=2,negativeMutationsRejected=4,fullMissionAdmitted=False,verifierExercised=False,physicalValidation=False)
    with a.output.open('x') as f:json.dump(out,f,indent=2);f.write('\n')
    print(json.dumps(out,indent=2))

if __name__=='__main__':main()
