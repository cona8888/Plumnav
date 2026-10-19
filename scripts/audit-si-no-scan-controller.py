"""Separate reconstruction of saved public-only no-scan controller fixtures."""
import argparse
import copy
from datetime import datetime,timezone
import gzip
import hashlib
import json
import math
from pathlib import Path

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):return json.loads(p.read_text())
def audit(r):
    rows=r['rows'];trace=r['trace'];assert len(rows)==len(trace)==9601
    observed=[];queries=0
    for i,(row,g) in enumerate(zip(rows,trace)):
        t=i/16;m=row['measurement'];assert row['time']==g['time']==m['time']==t
        assert m['sampleMode']=='passive' and 'quadSniff' not in m and m['valid']==t.is_integer()
        positive=r['fixture']=='positive' or r['fixture']=='pulsed' and t>=20 and (t-20)%40<10
        values=[.2625,.25,.2375,.25] if positive else [0,0,0,0]
        assert [x['channel'] for x in m['localInletReadings']]==['front','left','aft','right']
        assert [x['concentration'] for x in m['localInletReadings']]==values and not any(x['saturated'] for x in m['localInletReadings'])
        assert m['concentration']==sum(values)/4 and m['hit']==(m['valid'] and positive)
        expected=[.5+.2*math.cos(t/30),.5+.2*math.sin(t/30)]
        assert max(abs(row['position'][axis]-value) for axis,value in zip(('x','y'),expected))<1e-14
        assert row['heading']==t/30 and row['distance']==.2*(t/30)
        d=row['decision'];assert 'quadSniff' not in d and d['phase']!='AWAITING FOUR CHANNELS'
        assert all(math.isfinite(d['direction'][k]) for k in ('x','y'))
        assert row['state']['pendingScanId'] is None and row['state']['scanSequence']==0
        assert g['requestedScanId'] is None and g['pendingScanId'] is None and g['scanSequence']==0
        assert type(g['predicateQueries']) is int and g['predicateQueries']>=0;queries+=g['predicateQueries']
        if m['valid']:observed.append(dict(**m,position=row['position']))
        assert row['state']['passiveSampleCount']==len(observed)
    assert observed==r['observations'] and len(observed)==601 and queries>0
    return dict(controlRows=len(rows),eligibleReadouts=len(observed),predicateQueries=queries,issuedScans=0)

p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
manifest=load(a.input/'manifest.json');done=load(a.input/'complete.json');assert done['passed']
for x in manifest['sources']:assert sha(Path(x['path']))==x['sha256']
details=[];saved=None
for item in done['inventory']:
    path=a.input/item['file'];assert sha(path)==item['sha256'];r=json.loads(gzip.decompress(path.read_bytes()))
    details.append(dict(fixture=item['fixture'],historySha256=sha(path),**audit(r)));saved=r
assert len(details)==3 and {x['fixture'] for x in details}=={'blank','positive','pulsed'}
def reject(change):
    r=copy.deepcopy(saved);change(r)
    try:audit(r)
    except AssertionError:return
    raise AssertionError('Corrupted fixture escaped audit')
reject(lambda r:r['rows'][0]['decision'].update(quadSniff={'scanId':1}))
reject(lambda r:r['rows'][0]['state'].update(pendingScanId=1))
reject(lambda r:r['rows'][1]['measurement'].update(valid=True))
reject(lambda r:r['trace'][0].update(requestedScanId=1))
receipt=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),scriptSha256=sha(Path(__file__)),manifestSha256=sha(a.input/'manifest.json'),completeSha256=sha(a.input/'complete.json'),details=details,negativeMutationsRejected=4,controllerStateFixtureOnly=True,fullMissionAdmitted=False,physicalValidation=False)
with a.output.open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
print(json.dumps(receipt,indent=2))
