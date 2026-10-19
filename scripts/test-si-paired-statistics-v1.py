"""Synthetic-only test driver for complete-block paired statistics."""
import argparse
import copy
from datetime import datetime,timezone
import hashlib
import itertools
import json
from pathlib import Path
from lib.si_paired_statistics_v1 import paired_statistics,FIELDS,ARMS

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def canonical(x):return json.dumps(x,sort_keys=True,allow_nan=False,separators=(',',':'))
def meta(field,success):
    if field=='blank' or not success:return dict(auditPassed=True,field=field,stage='no-eligible-nomination',nominationPresent=False,nominalStatus=None,reportedPointPresent=False,sourceErrorMetres=None)
    return dict(auditPassed=True,field=field,stage='inspection-complete',nominationPresent=True,nominalStatus='supported',reportedPointPresent=True,sourceErrorMetres=.05)
def fixture(name,patterns):
    worlds=[name+'-'+str(i) for i in range(len(patterns))];records=[]
    for world,(continuous,pulsed) in zip(worlds,patterns):
        for f,values in zip(FIELDS,[continuous,pulsed,[False]*5]):
            for a,y in zip(ARMS,values):records.append(dict(worldKey=world,field=f,arm=a,endpoint=meta(f,y)))
    return dict(name=name,worldKeys=worlds,records=records)
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
    paths=[Path(__file__),Path('scripts/lib/si_paired_statistics_v1.py'),Path('scripts/lib/si_release_endpoint_v1.py'),Path('research/protocols/si_paired_statistics_synthetic_v1_2026-09-24.md')]
    pins=[dict(path=str(p),sha256=sha(p)) for p in paths]
    def write(name,r):
        with (a.output/name).open('x') as f:json.dump(r,f,indent=2,allow_nan=False);f.write('\n')
    write('manifest.json',dict(version='paired-statistics-synthetic-v1',createdAt=datetime.now(timezone.utc).isoformat(),sources=pins,syntheticOnly=True,newMissions=0))
    try:
        plus=[0,0,0,1,0];minus=[0,1,0,0,1]
        two=fixture('opposite',[(plus,minus),(minus,plus)])
        zero=fixture('constant',[([0]*5,[0]*5) for _ in range(64)])
        binary=list(itertools.product((0,1),repeat=5))*2
        patterns=fixture('all-patterns',[(list(p),list(reversed(p))) for p in binary])
        mixed=fixture('negative-categories',[([0]*5,[0]*5) for _ in range(2)])
        for row in mixed['records']:
            if row['field']=='blank':continue
            m=row['endpoint'];arm=row['arm']
            if arm=='GW':m.update(stage='mission-budget-exhausted',nominationPresent=True)
            if arm=='RL':m.update(stage='inspection-complete',nominationPresent=True,nominalStatus='abstained')
            if arm in ('GL','NS'):m.update(stage='inspection-complete',nominationPresent=True,nominalStatus='supported',reportedPointPresent=True,sourceErrorMetres=.2 if arm=='GL' else .05)
        cases=[]
        for f,draws in [(two,list(itertools.product(range(2),repeat=2))),(zero,None),(patterns,None),(mixed,None)]:
            before=canonical(f);result=paired_statistics(f['records'],f['worldKeys'],bootstrap_seed=924213,draws=draws)
            assert before==canonical(f),'Input mutated'
            assert result==paired_statistics(f['records'],f['worldKeys'],bootstrap_seed=924213,draws=draws)
            assert result==paired_statistics(list(reversed(f['records'])),f['worldKeys'],bootstrap_seed=924213,draws=draws)
            assert all(row['proportion'] is None and row['successes'] is None for row in result['arms'] if row['field']=='blank')
            if f['name']=='opposite':
                for row in result['primary']:
                    assert row['mean']==0 and abs(row['bootstrapPercentile95'][0]+.925)<1e-12 and abs(row['bootstrapPercentile95'][1]-.925)<1e-12 and not row['observedWorldContrastsConstant']
                assert all(v[0]==v[1]==-v[2]==-v[3] for v in result['bootstrap']['contrastSampleMeans'])
            if f['name']=='constant':
                assert all(row['bootstrapPercentile95']==[0,0] and row['empiricalIntervalDegenerate'] and row['observedWorldContrastsConstant'] and row['conservativeFamily95'][0]<0<row['conservativeFamily95'][1] for row in result['primary'])
            if f['name']=='all-patterns':
                assert all(row['mean']==0 for row in result['primary'])
                assert all(row['proportion']==.5 for row in result['arms'] if row['field']!='blank')
            if f['name']=='negative-categories':
                assert [r['mean'] for r in result['primary']]==[0,-1,0,-1]
                assert {k for row in result['arms'] for k in row['categories']}=={'no-nomination','inspection-incomplete','verifier-abstained','out-of-tolerance-report','within-tolerance-report','blank-not-applicable'}
            cases.append(dict(fixture=f,result=result))
        rejected=[]
        def reject(name,change,draws=None,seed=924213):
            f=copy.deepcopy(two);change(f)
            try:paired_statistics(f['records'],f['worldKeys'],bootstrap_seed=seed,draws=draws)
            except (ValueError,TypeError):rejected.append(name);return
            raise AssertionError('Invalid input accepted: '+name)
        reject('missing-row',lambda f:f['records'].pop())
        reject('duplicate-row',lambda f:f['records'].append(copy.deepcopy(f['records'][0])))
        reject('unexpected-world',lambda f:f['records'][0].update(worldKey='other'))
        reject('missing-world-key',lambda f:f['worldKeys'].pop())
        reject('duplicate-world-key',lambda f:f['worldKeys'].append(f['worldKeys'][0]))
        reject('wrong-arm',lambda f:f['records'][0].update(arm='coverage'))
        reject('mismatched-field',lambda f:f['records'][0]['endpoint'].update(field='si-pulse'))
        reject('failed-audit',lambda f:f['records'][0]['endpoint'].update(auditPassed=False))
        reject('missing-metadata',lambda f:f['records'][0]['endpoint'].pop('sourceErrorMetres'))
        reject('invalid-report',lambda f:f['records'][0]['endpoint'].update(reportedPointPresent=True))
        reject('extra-row-key',lambda f:f['records'][0].update(extra=0))
        reject('missing-row-key',lambda f:f['records'][0].pop('arm'))
        reject('unknown-field',lambda f:f['records'][0].update(field='outdoor'))
        reject('boolean-identity',lambda f:f['records'][0].update(worldKey=True))
        for name,draws in [('float-draws',[[0.,1.],[1.,0.]]),('boolean-draws',[[True,False],[False,True]]),('negative-draw',[[-1,1],[0,1]]),('out-of-range',[[0,2],[1,0]]),('wrong-columns',[[0],[1]]),('empty-draws',[]),('one-draw',[[0,1]])]:reject(name,lambda f:None,draws=draws)
        reject('boolean-seed',lambda f:None,seed=True);reject('negative-seed',lambda f:None,seed=-1)
        assert len(rejected)==23
        for row in pins:assert sha(Path(row['path']))==row['sha256']
        write('fixtures_and_results.json',cases)
        receipt=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),fixtureSets=len(cases),invalidInputsRejected=rejected,repeatAndRowPermutationPassed=True,inputsUnchanged=True,pairedDrawIdentityPassed=True,degenerateIntervalLabelsPassed=True,manifestSha256=sha(a.output/'manifest.json'),dataSha256=sha(a.output/'fixtures_and_results.json'),syntheticOnly=True,realHistoriesRead=0,newMissions=0,independentlyAudited=False,realCampaignAdmitted=False)
        write('complete.json',receipt);print(json.dumps(receipt))
    except BaseException as error:
        write('failure.json',dict(passed=False,error=repr(error),at=datetime.now(timezone.utc).isoformat(),newMissions=0));raise

if __name__=='__main__':main()
