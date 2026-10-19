"""Separate scalar/rational audit; imports no production endpoint or statistics."""
import argparse
from collections import Counter
from datetime import datetime,timezone
from decimal import Decimal,localcontext
from fractions import Fraction
import hashlib
import itertools
import json
import math
from pathlib import Path
import struct
import time

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def classify(m):
    keys={'auditPassed','field','stage','nominationPresent','nominalStatus','reportedPointPresent','sourceErrorMetres'}
    if type(m) is not dict or set(m)!=keys or m['auditPassed'] is not True:return None
    f,s,n,q,r,e=(m[k] for k in ('field','stage','nominationPresent','nominalStatus','reportedPointPresent','sourceErrorMetres'))
    if f not in ('si-continuous','si-pulse','blank') or type(n) is not bool or type(r) is not bool:return None
    if e is not None and (type(e) not in (int,float) or not math.isfinite(e) or e<0):return None
    if f=='blank' and e is not None:return None
    if s=='no-eligible-nomination':
        if n or q is not None or r or e is not None:return None
        c='no-nomination'
    elif s=='mission-budget-exhausted':
        if not n or q is not None or r or e is not None:return None
        c='inspection-incomplete'
    elif s=='inspection-complete':
        if not n or q not in ('supported','abstained') or r!=(q=='supported'):return None
        if f!='blank' and r!=(e is not None):return None
        c='verifier-abstained' if q=='abstained' else ('supported-report' if f=='blank' else ('within-tolerance-report' if e<=.1 else 'out-of-tolerance-report'))
    else:return None
    if f=='blank':return dict(applicable=False,success=None,category='blank-'+c,blankControls=dict(falseNomination=n,inspectionCompleted=s=='inspection-complete',falseReport=r))
    return dict(applicable=True,success=c=='within-tolerance-report',category=c)

def quantile(values,p):
    values=sorted(values);rank=Fraction(len(values)-1)*p;lo=rank.numerator//rank.denominator;frac=rank-lo
    return values[lo] if frac==0 else values[lo]*(1-frac)+values[lo+1]*frac

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--input',required=True,type=Path);parser.add_argument('--manifest',required=True,type=Path);parser.add_argument('--output',required=True,type=Path);a=parser.parse_args();assert not a.output.exists();start=time.monotonic()
    manifest=json.loads(a.manifest.read_text())
    for row in manifest['sources']:assert sha(row['path'])==row['sha256'],row['path']
    complete=json.loads((a.input/'complete.json').read_text());assert complete['passed'] and complete['newMissions']==complete['realHistoriesRead']==0
    for name,digest in complete['files'].items():assert sha(a.input/name)==digest
    enumeration=json.loads((a.input/'endpoint_enumeration.json').read_text());seen=set();valid=0
    for row in enumeration:
        m=row['metadata'];key=tuple(m[k] for k in ('field','stage','nominationPresent','nominalStatus','reportedPointPresent','sourceErrorMetres'))
        assert key not in seen;seen.add(key);expected=classify(m)
        assert row['accepted']==(expected is not None)
        if expected is not None:assert row['result']==expected;valid+=1
    wanted=set(itertools.product(('si-continuous','si-pulse','blank'),('no-eligible-nomination','mission-budget-exhausted','inspection-complete'),(False,True),(None,'supported','abstained'),(False,True),(None,-.01,0.,.099,.1,.101)))
    assert seen==wanted and len(seen)==648 and valid==18
    witnesses=json.loads((a.input/'witnesses.json').read_text());blank_seen=set()
    for kind,items in witnesses.items():
        for row in items:
            value,out=row['input'],row['result'];states=[classify(res['endpoint']) for res in value['resolutions']]
            assert all(state is not None for state in states) and out['states']==states
            assert [r['navDt'] for r in value['resolutions']]==['1/16','1/32','1/64']
            if kind=='blank':
                categories=tuple(s['category'] for s in states);blank_seen.add((categories,value['parentNumericalPassed']))
                stable=categories.count(categories[0])==3
                assert out['endpointStable'] is None and out['blankOutcomeStable']==stable and out['localisationApplicable'] is False
            else:
                stable=len({s['success'] for s in states})==1
                assert out['endpointStable']==stable and out['blankOutcomeStable'] is None and out['localisationApplicable'] is True
            assert out['passed']==(value['parentNumericalPassed'] and stable)
    blank_categories=('blank-no-nomination','blank-inspection-incomplete','blank-verifier-abstained','blank-supported-report')
    assert blank_seen==set(itertools.product(itertools.product(blank_categories,repeat=3),(False,True)))
    deck=json.loads((a.input/'paired_fixture.json').read_text());worlds=deck['worlds'];out=deck['result'];index={};fields=('si-continuous','si-pulse','blank');arms=('RW','GW','RL','GL','NS')
    for row in deck['records']:
        key=(row['worldKey'],row['field'],row['arm']);assert key not in index
        state=classify(row['endpoint']);assert state is not None and row['endpoint']['field']==row['field'];index[key]=state
    assert set(index)==set(itertools.product(worlds,fields,arms)) and len(worlds)==32
    for summary in out['arms']:
        field,arm=summary['field'],summary['arm'];states=[index[w,field,arm] for w in worlds];counts=Counter(s['category'] for s in states)
        if field=='blank':
            for c in blank_categories:counts.setdefault(c,0)
            assert summary['successes'] is None and summary['proportion'] is None and summary['localisationApplicable'] is False
            for name in ('falseNomination','inspectionCompleted','falseReport'):
                count=sum(s['blankControls'][name] for s in states)
                assert summary['blankControls'][name]==dict(count=count,denominator=32,proportion=float(Fraction(count,32)))
            assert summary['categories']==dict.fromkeys(blank_categories,8)
        else:
            count=sum(s['success'] for s in states);assert count==16
            assert summary['successes']==count and summary['proportion']==float(Fraction(count,32)) and summary['localisationApplicable'] is True
        assert summary['categories']==dict(counts) and summary['n']==32
    vectors=[]
    for world in worlds:
        values=[]
        for field in fields[:2]:
            y=[int(index[world,field,arm]['success']) for arm in arms]
            values.extend((y[3]+y[0]-y[2]-y[1],y[3]-y[4]))
        vectors.append(values)
    boot=out['bootstrap'];draws=boot['drawIndices'];assert len(draws)==10000 and all(len(draw)==32 and all(type(i) is int and 0<=i<32 for i in draw) for draw in draws)
    assert boot['indexSha256']==hashlib.sha256(b''.join(struct.pack('<I',i) for draw in draws for i in draw)).hexdigest()
    assert boot['seed']==924213 and boot['method']=='PCG64-whole-world' and boot['quantileMethod']=='linear'
    rational=[]
    for draw,observed in zip(draws,boot['contrastSampleMeans']):
        expected=[Fraction(sum(vectors[i][j] for i in draw),32) for j in range(4)]
        assert observed==[float(x) for x in expected];rational.append(expected)
    for j,primary in enumerate(out['primary']):
        column=[row[j] for row in vectors];mean=Fraction(sum(column),32);half_range=2 if j%2==0 else 1
        assert primary['worldContrasts']==column and primary['mean']==float(mean)==0
        qs=[float(quantile([row[j] for row in rational],p)) for p in (Fraction(1,40),Fraction(39,40))]
        assert primary['bootstrapPercentile95']==qs and primary['empiricalIntervalDegenerate']==(qs[0]==qs[1])
        assert primary['observedWorldContrastsConstant']==(len(set(column))==1)
        with localcontext() as ctx:
            ctx.prec=60;h=Decimal(2*half_range)*(Decimal(160).ln()/Decimal(64)).sqrt();mu=Decimal(mean.numerator)/Decimal(mean.denominator)
            bounds=[float(max(Decimal(-half_range),mu-h)),float(min(Decimal(half_range),mu+h))]
        assert abs(primary['unclippedConservativeHalfWidth']-float(h))<1e-14
        assert all(abs(a-b)<1e-14 for a,b in zip(primary['conservativeFamily95'],bounds))
    assert out['scope']['metadataBindingVerified'] is False and out['scope']['realCampaignAdmitted'] is False and out['scope']['physicalValidation'] is False
    assert complete['negativeCheckCount']==44 and len(complete['negativeChecks'])==len(set(complete['negativeChecks']))
    receipt=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,enumeratedStates=648,validStates=18,blankWitnesses=128,emittingWitnesses=8,pairedWorlds=32,rows=len(index),scalarBootstrapMeans=40000,arithmetic='Independent state classification, scalar loops, Fraction means/quantiles, Decimal bounds',manifestSha256=sha(a.manifest),testReceiptSha256=sha(a.input/'complete.json'),auditorSha256=sha(__file__),syntheticOnly=True,newMissions=0,realHistoryBindingVerified=False)
    with a.output.open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
    print(json.dumps(receipt))

if __name__=='__main__':main()
