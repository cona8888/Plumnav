"""Independent fixture-chain and scalar-map checker; no production helper imports."""
import argparse
from datetime import datetime, timezone
from decimal import Decimal, localcontext
import hashlib
import json
import math
from pathlib import Path
import re
import time

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def keys(d,wanted):assert type(d) is dict and set(d)==set(wanted)
def num(x):return type(x) in (int,float) and math.isfinite(x)
def xy(p):
    keys(p,('x','y'));assert all(num(p[k]) for k in ('x','y'));return [p['x'],p['y']]
def dec(x):return Decimal(x) if type(x) is int else Decimal.from_float(x)
def read(path):
    def pairs(items):
        assert len(items)==len({k for k,v in items});return dict(items)
    def constant(value):raise AssertionError('Non-finite JSON')
    return json.loads(path.read_bytes(),object_pairs_hook=pairs,parse_constant=constant)

def independent(entry):
    root=Path(entry['directory']).resolve();mp=root/'manifest.json';assert not mp.is_symlink() and sha(mp)==entry['manifestSha256'];m=read(mp)
    keys(m,('version','purpose','syntheticOnly','identity','artifacts'))
    assert m['version']=='synthetic-terminal-manifest-v1' and m['purpose']=='synthetic-terminal-binding-only' and m['syntheticOnly'] is True
    ident=m['identity'];keys(ident,('worldKey','arm','field','navDt'))
    assert type(ident['worldKey']) is str and re.fullmatch('synthetic-[A-Za-z0-9-]+',ident['worldKey'])
    assert ident['arm'] in ('RW','GW','RL','GL','NS') and ident['field'] in ('si-continuous','si-pulse','blank') and ident['navDt'] in ('1/16','1/32','1/64')
    keys(m['artifacts'],('history','completion','process','audit'));files={};seen=set()
    extra={'history':('config','nomination','verification','summary'),'completion':('completed','historySha256'),'process':('exitCode','timedOut'),'audit':('passed','historySha256','realAuditExecuted')}
    for role,item in m['artifacts'].items():
        keys(item,('path','sha256'));name=item['path'];assert type(name) is str and '\\' not in name and name not in seen and name!='manifest.json';seen.add(name)
        assert not name.startswith('/') and all(part not in ('','.','..') for part in name.split('/'))
        path=root
        for part in name.split('/'):
            path=path/part;assert not path.is_symlink()
        assert path.resolve().is_relative_to(root) and path.is_file() and path.stat().st_size<=2_000_000 and sha(path)==item['sha256']
        data=read(path);keys(data,('version','syntheticOnly','identity',*extra[role]))
        assert data['version']=='synthetic-terminal-'+role+'-v1' and data['syntheticOnly'] is True and data['identity']==ident;files[role]=data
    assert files['completion']['completed'] is True and files['completion']['historySha256']==m['artifacts']['history']['sha256']
    assert type(files['process']['exitCode']) is int and files['process']['exitCode']==0 and files['process']['timedOut'] is False
    assert files['audit']['passed'] is True and files['audit']['historySha256']==m['artifacts']['history']['sha256'] and files['audit']['realAuditExecuted'] is False
    r=files['history'];blank=ident['field']=='blank';c=r['config']
    keys(c,('domainMeters','targetStatus') if blank else ('domainMeters','targetStatus','sourcePositionOverride'))
    assert num(c['domainMeters']) and c['domainMeters']==10 and c['targetStatus']==('absent' if blank else 'present')
    source=None if blank else xy(c['sourcePositionOverride']);nom=r['nomination'];centre=None
    if nom is not None:keys(nom,('point',));centre=xy(nom['point'])
    summary=r['summary'];keys(summary,('stage','errors'));s=summary['stage'];reports=summary['errors'];assert type(reports) is list
    q=None;error=None;reported=False
    if s!='inspection-complete':
        assert s in ('no-eligible-nomination','mission-budget-exhausted') and not reports and r['verification'] is None
        assert (s=='no-eligible-nomination')==(nom is None)
        category='no-nomination' if nom is None else 'inspection-incomplete'
    else:
        assert centre is not None;v=r['verification'];keys(v,('exactPoseOnly','arms'));assert v['exactPoseOnly'] is True and type(v['arms']) is list and len(v['arms'])==len(reports)==1
        arm=v['arms'][0];report=reports[0];keys(arm,('poseRadiusMetres','decision'));keys(report,('poseRadiusMetres','reportedPoint','sourceErrorMetres'))
        assert all(num(x['poseRadiusMetres']) and x['poseRadiusMetres']==0 for x in (arm,report))
        decision=arm['decision'];keys(decision,('status','candidate'));q=decision['status'];error=report['sourceErrorMetres']
        if q=='abstained':
            assert decision['candidate'] is None or type(decision['candidate']) is dict
            assert report['reportedPoint'] is None and error is None;category='verifier-abstained'
        else:
            assert q=='supported';keys(decision['candidate'],('geometry',));g=decision['candidate']['geometry'];keys(g,('peak',));peak=g['peak']
            assert type(peak) is list and len(peak)==2 and all(num(x) for x in peak);actual=xy(report['reportedPoint']);reported=True
            with localcontext() as context:
                context.prec=70
                expected=[float(dec(centre[i])+Decimal('0.01')*dec(peak[i])) for i in (0,1)]
                assert all(abs(actual[i]-expected[i])<=1e-12 for i in (0,1))
                if blank:assert error is None
                else:
                    reconstructed=float(sum((dec(actual[i])-dec(source[i]))**2 for i in (0,1)).sqrt()*Decimal(10))
                    assert num(error) and error>=0 and abs(error-reconstructed)<=1e-10
                    assert (error<=.1)==(reconstructed<=.1)
            category='supported-report' if blank else 'within-tolerance-report' if error<=.1 else 'out-of-tolerance-report'
    metadata=dict(auditPassed=True,field=ident['field'],stage=s,nominationPresent=nom is not None,nominalStatus=q,reportedPointPresent=reported,sourceErrorMetres=error)
    endpoint=dict(applicable=not blank,success=None if blank else category=='within-tolerance-report',category=('blank-' if blank else '')+category)
    if blank:endpoint['blankControls']=dict(falseNomination=nom is not None,inspectionCompleted=s=='inspection-complete',falseReport=reported)
    return metadata,endpoint,m

def main():
    p=argparse.ArgumentParser();p.add_argument('--input',required=True,type=Path);p.add_argument('--manifest',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args();assert not a.output.exists();start=time.monotonic()
    execution=read(a.manifest)
    for row in execution['sources']:assert sha(row['path'])==row['sha256'],row['path']
    done=read(a.input/'complete.json');assert done['passed'] and done['realAuditExecuted'] is False and done['realHistoriesRead']==done['newMissions']==0
    for name,digest in done['files'].items():assert sha(a.input/name)==digest
    deck=read(a.input/'bindings.json');assert len(deck['entries'])==len(deck['bindings'])==len(deck['expected'])==15
    seen=set();categories={}
    for entry,output,expected in zip(deck['entries'],deck['bindings'],deck['expected']):
        metadata,state,m=independent(entry)
        key=tuple(m['identity'][k] for k in ('worldKey','arm','field','navDt'));assert key not in seen;seen.add(key)
        assert output['metadata']==metadata and output['endpoint']==state and output['identity']==m['identity']
        assert output['provenance']==dict(manifestSha256=entry['manifestSha256'],artifacts=m['artifacts'])
        assert state['category']==expected['category'] and state['success']==expected['success'];categories[state['category']]=categories.get(state['category'],0)+1
        assert output['scope']==dict(syntheticOnly=True,realAuditExecuted=False,realHistoryBindingVerified=False,physicalValidation=False,realCampaignAdmitted=False)
    negative=read(a.input/'negative_receipts.json');assert len(negative)==51
    rejected=[]
    for row in negative:
        try:independent(row['entry'])
        except (AssertionError,ValueError,KeyError,TypeError,FileNotFoundError):rejected.append(row['name'])
        else:raise AssertionError('Independent checker accepted '+row['name'])
    assert len(set(rejected))==51 and 'near-boundary-classification' in rejected
    inventory=read(a.input/'fixture_inventory.json');root=a.input/'fixtures'
    actual={str(path.relative_to(root)):('symlink:'+str(path.readlink()) if path.is_symlink() else sha(path)) for path in root.rglob('*') if path.is_file() or path.is_symlink()}
    assert actual==inventory
    receipt=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,successfulFixtures=15,rejectedFixtures=51,categories=categories,checkedFixtureFiles=len(inventory),arithmetic='Separate schema/path/hash logic and 70-digit Decimal point/distance reconstruction',manifestSha256=sha(a.manifest),testReceiptSha256=sha(a.input/'complete.json'),auditorSha256=sha(__file__),syntheticOnly=True,realAuditExecuted=False,realHistoryBindingVerified=False,newMissions=0)
    with a.output.open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
    print(json.dumps(receipt))

if __name__=='__main__':main()
