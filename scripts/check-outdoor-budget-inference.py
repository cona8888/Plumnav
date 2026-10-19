#!/usr/bin/env python3
"""Supplementary independent counts/intervals check after numerical acceptance.

Uses only stdlib binomial sums and bisection (not the production SciPy/Beta
interval code), directly from immutable raw outcomes. Never runs a simulation.
"""
import argparse
from collections import defaultdict
from datetime import datetime,timezone
import gzip
import hashlib
import json
import math
from pathlib import Path


def require(condition,message):
    if not condition:raise ValueError(message)


def read(path):return json.loads(Path(path).read_text())
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def cumulative(k,n,p):
    return math.fsum(math.comb(n,j)*p**j*(1-p)**(n-j) for j in range(k+1))


def interval(successes,n,alpha):
    require(isinstance(successes,int) and isinstance(n,int) and n>0 and 0<=successes<=n and 0<alpha<1,'Bad interval input')
    if successes==0:lower=0.
    else:
        lo,hi=0.,1.
        for _ in range(80):
            mid=(lo+hi)/2
            if 1-cumulative(successes-1,n,mid)<alpha/2:lo=mid
            else:hi=mid
        lower=(lo+hi)/2
    if successes==n:upper=1.
    else:
        lo,hi=0.,1.
        for _ in range(80):
            mid=(lo+hi)/2
            if cumulative(successes,n,mid)>alpha/2:lo=mid
            else:hi=mid
        upper=(lo+hi)/2
    return [lower,upper]


def self_test():
    require(abs(interval(0,128,.025)[1]-(1-.0125**(1/128)))<1e-14,'Zero boundary')
    require(abs(interval(128,128,.025)[0]-.0125**(1/128))<1e-14,'Full boundary')
    for x in [1,10,50,64,100,127]:
        lo,hi=interval(x,128,.025)
        require(lo<x/128<hi,'Interval excludes estimate')
        require(abs(1-cumulative(x-1,128,lo)-.0125)<1e-13,'Lower tail inversion')
        require(abs(cumulative(x,128,hi)-.0125)<1e-13,'Upper tail inversion')
        a,b=interval(128-x,128,.025)
        require(abs(lo-(1-b))<1e-13 and abs(hi-(1-a))<1e-13,'Symmetry')
    print('PASS: independent binomial-sum interval boundaries, tail inversion and symmetry.')


def check(root):
    closure=read(root/'closure.json');audit=read(root/'audit.json');manifest=read(root/'manifest.json')
    require(closure['accepted'] and closure['mode']=='campaign' and audit['accepted'],'Campaign not independently accepted')
    for key,name in [('manifest','manifest.json'),('audit','audit.json'),('report','report.md'),('executionReceipt','execution-complete.json')]:
        require(sha(root/name)==closure[key+'Sha256'],'Closed input changed')
    complete=read(root/'execution-complete.json');groups=defaultdict(dict);files=0
    for setting,receipt in zip(manifest['specs'],complete['files']):
        if setting['resolution']!=0:continue
        path=root/receipt['file'];require(sha(path)==receipt['sha256'],'Raw history changed')
        trace=json.loads(gzip.decompress(path.read_bytes()));require(trace['spec']==setting,'Trace identity');files+=1
        for measurement in trace['measurements']:
            key=(setting['wind'],setting['speed'],measurement['sensor']['id'],measurement['rateKgPerSecond'])
            world=setting['world'];require(world not in groups[key],'Duplicate world')
            groups[key][world]=measurement['outcomes']
    require(files==512 and len(groups)==16,'Primary inventory')
    world_ids=list(range(2000,2128));stats=audit['statistics'];seen=set()
    require(stats['primaryHistories']==512 and stats['primaryOutcomes']==4096 and stats['independentWorldsPerSetting']==128,'Reported denominators')
    require(len(stats['primary'])==2 and {p['endpoint'] for p in stats['primary']}=={'additional-detection','additional-blank-alarm'},'Primary endpoint inventory')
    for s in stats['groups']:
        key=(s['wind'],s['speed'],s['sensor'],s['rateKgPerSecond']);require(key not in seen,'Duplicate summary');seen.add(key)
        g=groups[key];require(sorted(g)==world_ids and s['n']==128,'World counts')
        early=[];late=[];neither=[]
        for world in world_ids:
            x,y=g[world];a,b=x['alarmSeconds'],y['alarmSeconds']
            require(x['budgetSeconds']==600 and y['budgetSeconds']==int(990/key[1]+36),'Budget')
            if a is not None:require(a==b,'Lost early alarm');early.append(world)
            elif b is not None:require(600<b<=y['budgetSeconds'],'Bad late alarm');late.append(world)
            else:neither.append(world)
        require(s['earlyAlarmWorlds']==early and s['lateOnlyWorlds']==late and s['neitherWorlds']==neither,'Paired memberships')
        require(s['fullMinusShortAlarmProbability']==len(late)/128,'Difference')
        blank=groups[(key[0],key[1],key[2],0)]
        require(len(s['budgets'])==2,'Reported budget inventory')
        for j,budget in enumerate(s['budgets']):
            require(budget['budgetSeconds']==g[world_ids[0]][j]['budgetSeconds'],'Reported cap')
            ids=[w for w in world_ids if g[w][j]['alarmSeconds'] is not None]
            require(budget['worlds']==ids and budget['alarms']==len(ids) and budget['estimate']==len(ids)/128,'Budget counts')
            require(budget['alarmsWithMatchedBlankSilent']==sum(blank[w][j]['alarmSeconds'] is None for w in ids),'Matched blank count')
            restricted=math.fsum(g[w][j]['budgetSeconds'] if g[w][j]['alarmSeconds'] is None else g[w][j]['alarmSeconds'] for w in world_ids)/128
            require(restricted==budget['restrictedMeanTimeSeconds'],'Restricted mean')
    require(len(seen)==16,'Summary count')
    primary=[]
    for label,rate in [('additional-detection',1e-4),('additional-blank-alarm',0)]:
        g=groups[(.5,1,'generic-sigma0.2-tau0.5',rate)]
        count=sum(x[0]['alarmSeconds'] is None and x[1]['alarmSeconds'] is not None for x in g.values())
        bounds=interval(count,128,.025);reported=next(x for x in stats['primary'] if x['endpoint']==label)
        require(reported['n']==128 and reported['lateAlarms']==count and reported['difference']==count/128,'Primary endpoint')
        require(all(abs(a-b)<1e-12 for a,b in zip(bounds,reported['interval975'])),'Independent interval disagreement')
        primary.append(dict(endpoint=label,lateAlarms=count,independentInterval975=bounds))
    return dict(accepted=True,checkedAt=datetime.now(timezone.utc).isoformat(),
        campaignClosureSha256=sha(root/'closure.json'),checkerSha256=sha(Path(__file__)),
        primaryHistories=files,independentWorldsPerSetting=128,groups=16,primary=primary,
        method='Raw paired outcomes; independent stdlib binomial sums and 80-step bisection; no SciPy interval function.',physicalValidation=False)


def main():
    p=argparse.ArgumentParser();p.add_argument('--self-test',action='store_true');p.add_argument('--input',type=Path);p.add_argument('--output',type=Path);args=p.parse_args()
    if args.self_test:self_test();return
    require(args.input and args.output,'Input and new output required');require(not args.output.exists(),'Output exists')
    result=check(args.input)
    with args.output.open('x') as out:json.dump(result,out,indent=2,allow_nan=False);out.write('\n')
    print(json.dumps(result))


if __name__=='__main__':main()
