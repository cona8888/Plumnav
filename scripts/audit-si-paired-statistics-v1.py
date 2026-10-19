"""Saved-fixture audit using rational means/quantiles, not production helpers."""
import argparse
from collections import Counter
from datetime import datetime,timezone
from decimal import Decimal,localcontext
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import struct
import time

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):return json.loads(p.read_text())
def classify(m):
    assert m['auditPassed'] is True
    if m['field']=='blank':
        assert m['stage']=='no-eligible-nomination' and not m['nominationPresent'] and m['sourceErrorMetres'] is None
        return None,'blank-not-applicable'
    if m['stage']=='no-eligible-nomination':
        assert not m['nominationPresent'] and m['nominalStatus'] is None and not m['reportedPointPresent'] and m['sourceErrorMetres'] is None
        return 0,'no-nomination'
    assert m['nominationPresent']
    if m['stage']=='mission-budget-exhausted':
        assert m['nominalStatus'] is None and not m['reportedPointPresent'] and m['sourceErrorMetres'] is None
        return 0,'inspection-incomplete'
    assert m['stage']=='inspection-complete'
    if m['nominalStatus']=='abstained':
        assert not m['reportedPointPresent'] and m['sourceErrorMetres'] is None
        return 0,'verifier-abstained'
    assert m['nominalStatus']=='supported' and m['reportedPointPresent'] and m['sourceErrorMetres']>=0
    success=m['sourceErrorMetres']<=.1
    return int(success),'within-tolerance-report' if success else 'out-of-tolerance-report'
def quantile(values,q):
    values=sorted(values);position=(len(values)-1)*q;left=position.numerator//position.denominator;fraction=position-left
    return values[left] if fraction==0 else values[left]+fraction*(values[left+1]-values[left])
def close(value,wanted):assert abs(float(value)-float(wanted))<=1e-12,(value,wanted)
def main():
    p=argparse.ArgumentParser();p.add_argument('--input',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args();start=time.monotonic()
    manifest=load(a.input/'manifest.json');done=load(a.input/'complete.json');data=load(a.input/'fixtures_and_results.json')
    assert done['passed'] and done['manifestSha256']==sha(a.input/'manifest.json') and done['dataSha256']==sha(a.input/'fixtures_and_results.json')
    for row in manifest['sources']:assert sha(Path(row['path']))==row['sha256']
    assert len(data)==4 and len(done['invalidInputsRejected'])==23
    checked=0;sets=[]
    for item in data:
        f=item['fixture'];r=item['result'];keys=f['worldKeys'];n=len(keys)
        lookup={(x['worldKey'],x['field'],x['arm']):classify(x['endpoint']) for x in f['records']}
        expected={(w,field,arm) for w in keys for field in ('si-continuous','si-pulse','blank') for arm in ('RW','GW','RL','GL','NS')}
        assert set(lookup)==expected and len(f['records'])==len(expected)
        columns=[]
        for field in ('si-continuous','si-pulse'):
            columns.append([lookup[w,field,'GL'][0]+lookup[w,field,'RW'][0]-lookup[w,field,'RL'][0]-lookup[w,field,'GW'][0] for w in keys])
            columns.append([lookup[w,field,'GL'][0]-lookup[w,field,'NS'][0] for w in keys])
        draws=r['bootstrap']['drawIndices'];assert len(draws)>=2 and all(len(d)==n and all(type(i) is int and 0<=i<n for i in d) for d in draws)
        encoded=b''.join(struct.pack('<I',i) for d in draws for i in d)
        assert hashlib.sha256(encoded).hexdigest()==r['bootstrap']['indexSha256']
        if f['name']=='opposite':assert draws==[[0,0],[0,1],[1,0],[1,1]]
        else:assert len(draws)==10000 and r['bootstrap']['seed']==924213
        for j,values in enumerate(columns):
            pstat=r['primary'][j];assert pstat['worldContrasts']==values;mean=Fraction(sum(values),n);close(pstat['mean'],mean)
            means=[Fraction(sum(values[i] for i in d),n) for d in draws]
            for k,value in enumerate(means):close(r['bootstrap']['contrastSampleMeans'][k][j],value)
            low=quantile(means,Fraction(1,40));high=quantile(means,Fraction(39,40))
            close(pstat['bootstrapPercentile95'][0],low);close(pstat['bootstrapPercentile95'][1],high)
            assert pstat['observedWorldContrastsConstant']==(len(set(values))==1) and pstat['empiricalIntervalDegenerate']==(low==high)
            bound=2 if j%2==0 else 1
            with localcontext() as ctx:
                ctx.prec=60;h=Decimal(2*bound)*(Decimal(160).ln()/(2*n)).sqrt();m=Decimal(mean.numerator)/mean.denominator
                close(pstat['unclippedConservativeHalfWidth'],h)
                close(pstat['conservativeFamily95'][0],max(Decimal(-bound),m-h));close(pstat['conservativeFamily95'][1],min(Decimal(bound),m+h))
            checked+=len(means)
        for row in r['arms']:
            values=[lookup[w,row['field'],row['arm']] for w in keys]
            assert row['n']==n and row['categories']==dict(Counter(category for _,category in values))
            if row['field']=='blank':assert row['proportion'] is None and row['successes'] is None and not row['localisationApplicable']
            else:
                count=sum(v for v,_ in values);assert row['successes']==count and row['localisationApplicable'];close(row['proportion'],Fraction(count,n))
        assert r['worldOrder']==keys and r['independentWorlds']==n and not r['scope']['realCampaignAdmitted'] and not r['scope']['metadataBindingVerified']
        sets.append(dict(name=f['name'],worlds=n,rows=len(f['records']),draws=len(draws)))
    for row in manifest['sources']:assert sha(Path(row['path']))==row['sha256']
    result=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,fixtureSets=sets,scalarBootstrapMeansChecked=checked,arithmetic='Fraction means/linear quantiles, independent scalar loops, Decimal bounds',manifestSha256=sha(a.input/'manifest.json'),dataSha256=sha(a.input/'fixtures_and_results.json'),auditorSha256=sha(Path(__file__)),syntheticOnly=True,realHistoriesRead=0,newMissions=0,realCampaignAdmitted=False)
    with a.output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result))

if __name__=='__main__':main()
