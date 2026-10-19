"""Prospective fresh-world budget statistics; no parameter fitting or simulations."""
from collections import defaultdict
from scipy.stats import beta
from .outdoor_holdout_statistics import wilson


def exact_interval(successes, n, alpha):
    if not isinstance(n,int) or not isinstance(successes,int) or not 0<=successes<=n or n<=0 or not 0<alpha<1:
        raise ValueError('Invalid binomial interval inputs')
    return [0. if successes==0 else float(beta.ppf(alpha/2,successes,n-successes+1)),
            1. if successes==n else float(beta.ppf(1-alpha/2,successes+1,n-successes))]


def summarise(traces):
    groups=defaultdict(dict)
    for trace in traces:
        s=trace['spec']
        if s['resolution']!=0:
            continue
        end=int(990/s['speed']+36)
        for m in trace['measurements']:
            key=(s['wind'],s['speed'],m['sensor']['id'],m['rateKgPerSecond'])
            if s['world'] in groups[key]:raise ValueError('Duplicate paired world')
            o=m['outcomes']
            if len(o)!=2 or [x['budgetSeconds'] for x in o]!=[600,end]:raise ValueError('Unexpected budget')
            for x in o:
                t=x['alarmSeconds'];cap=x['budgetSeconds']
                if t is not None and (not isinstance(t,(int,float)) or not 3<=t<=cap or int(t)!=t):raise ValueError('Invalid alarm time')
                if x['restrictedTimeSeconds']!=(cap if t is None else t):raise ValueError('Invalid restricted time')
            a,b=[x['alarmSeconds'] for x in o]
            if a is not None and a!=b:raise ValueError('Lost/changed early alarm')
            if a is None and b is not None and b<=600:raise ValueError('Invalid late alarm')
            groups[key][s['world']]=o
    keys={(u,v,f'generic-sigma0.2-tau{tau:g}',q) for u in [.5,2] for v in [.5,1] for tau in [.5,5] for q in [0,1e-4]}
    worlds=list(range(2000,2128))
    if set(groups)!=keys or any(sorted(g)!=worlds for g in groups.values()):raise ValueError('Incomplete fresh-world factorial')
    result=[]
    for key,g in sorted(groups.items()):
        wind,speed,sensor,rate=key; blank=groups[(wind,speed,sensor,0)]
        budgets=[]
        for index,cap in enumerate([600,int(990/speed+36)]):
            ids=[w for w in worlds if g[w][index]['alarmSeconds'] is not None]
            budgets.append(dict(budgetSeconds=cap,alarms=len(ids),estimate=len(ids)/128,wilson95=wilson(len(ids),128),
                restrictedMeanTimeSeconds=sum(g[w][index]['restrictedTimeSeconds'] for w in worlds)/128,
                alarmsWithMatchedBlankSilent=sum(g[w][index]['alarmSeconds'] is not None and blank[w][index]['alarmSeconds'] is None for w in worlds),
                worlds=ids))
        early=[w for w in worlds if g[w][0]['alarmSeconds'] is not None]
        late=[w for w in worlds if g[w][0]['alarmSeconds'] is None and g[w][1]['alarmSeconds'] is not None]
        result.append(dict(wind=wind,speed=speed,sensor=sensor,rateKgPerSecond=rate,n=128,
            budgets=budgets,earlyAlarmWorlds=early,lateOnlyWorlds=late,
            neitherWorlds=[w for w in worlds if g[w][1]['alarmSeconds'] is None],
            fullMinusShortAlarmProbability=len(late)/128))
    primary=[]
    for rate in [1e-4,0]:
        r=next(r for r in result if r['wind']==.5 and r['speed']==1 and r['sensor']=='generic-sigma0.2-tau0.5' and r['rateKgPerSecond']==rate)
        count=len(r['lateOnlyWorlds'])
        primary.append(dict(endpoint='additional-detection' if rate else 'additional-blank-alarm',n=128,lateAlarms=count,
            difference=count/128,interval975=exact_interval(count,128,.025)))
    return dict(groups=result,primary=primary,independentWorldsPerSetting=128,primaryHistories=512,primaryOutcomes=4096,
        intervalMethod='Two Clopper-Pearson 97.5% intervals for paired late-alarm indicators; Bonferroni family coverage at least 95% under independent-world sampling.',
        timeWarning='Each restricted mean has its own budget cap; unequal-cap means are not an unqualified efficiency comparison.',
        physicalValidation=False,calibratedCommercialDevices=False)
