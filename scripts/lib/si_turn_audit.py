"""Prospective direction-resolved acceptance, preserving the earlier scalar gates."""
import math
import numpy as np
from lib.si_turn_integration_audit import audit as event_audit,compact as event_compact,compare as event_compare
from lib.si_scheduling_audit import scheduling_checks,metrics


def audit(record):
    result=event_audit(record);result['schedule']=scheduling_checks(record)
    result['antipodalTies']=sum(s['antipodalTie'] for s in record['segments'])
    return result


def compact(record):
    data=event_compact(record);data['metrics']=metrics(record)
    # Same physical 1/64 s clocks in all meshes, including intra-control turns.
    stride=round((1/64)/(record['config']['fixedDt']/4))
    tr=np.asarray(record['trace'])[::stride];assert np.array_equal(tr[:,0],np.arange(len(tr))/64)
    data['directional']=tr[:,np.r_[0:12,16:24]];data['domainMetres']=record['config']['domainMeters']
    labels=np.full(len(tr),'approach',dtype='<U12');times=tr[:,0]
    labels[times<record['summary']['acquisitionBudgetSeconds']]='acquisition'
    if record['summary']['inspectionAt'] is not None:
        labels[(times>=record['summary']['acquisitionBudgetSeconds'])&(times<record['summary']['inspectionAt'])]='drain'
    for v in record['visits']:
        if v['arrivedAt'] is not None:
            end=v['closedAt'] if v['closedAt'] is not None else record['summary']['completedAt']
            labels[(times>=v['arrivedAt'])&(times<=end)]='settling'
            labels[(times>=v['arrivedAt']+8)&(times<=end)]='retained'
    data['phaseLabels']=labels
    return data


def pair(a,b):
    n=min(len(a['directional']),len(b['directional']));x=a['directional'][:n];y=b['directional'][:n];L=a['domainMetres'];assert L==b['domainMetres']
    assert np.array_equal(x[:,0],y[:,0])
    angle=np.abs(np.arctan2(np.sin(x[:,3]-y[:,3]),np.cos(x[:,3]-y[:,3])))
    gx=x[:,4:12].reshape(-1,4,2)*L;gy=y[:,4:12].reshape(-1,4,2)*L
    labeled=np.linalg.norm(gx-gy,axis=2)
    offsets=np.linalg.norm((gx-x[:,None,1:3]*L)-(gy-y[:,None,1:3]*L),axis=2)
    filtered=np.abs(x[:,12:16]-y[:,12:16]);noisy=np.abs(x[:,16:20]-y[:,16:20])
    def maximum(mask):
        if not np.any(mask):return None
        return dict(samples=int(mask.sum()),headingRadians=float(angle[mask].max()),labeledInletMetres=float(labeled[mask].max()),inletOffsetMetres=float(offsets[mask].max()),filteredC0=filtered[mask].max(axis=0).tolist(),readoutC0=noisy[mask].max(axis=0).tolist())
    phases={phase:maximum((a['phaseLabels'][:n]==phase)|(b['phaseLabels'][:n]==phase)) for phase in ['acquisition','drain','approach','settling','retained']}
    return dict(all=maximum(np.ones(n,dtype=bool)),phases=phases)


def stable_times(values):
    return all(v is None for v in values) or (all(v is not None for v in values) and max(values)-min(values)<=1)


def compare(triple):
    result=event_compare(triple);coarse=pair(triple[0],triple[1]);fine=pair(triple[1],triple[2]);g=result['gates']
    g['eligibleEncounterTimeStable']=stable_times([r['metrics']['firstEligibleTime'] for r in triple])
    g['latchTimeStable']=stable_times([r['schedule']['firstEligibleControlTime'] for r in triple])
    for phase in ['all','acquisition','drain','approach','settling','retained']:
        a=coarse['all'] if phase=='all' else coarse['phases'][phase];b=fine['all'] if phase=='all' else fine['phases'][phase]
        g[f'{phase}:presence']=bool(a is None)==bool(b is None)
        if a is None or b is None:continue
        g[f'{phase}:heading']=b['headingRadians']<=.02
        g[f'{phase}:inletOffset']=b['inletOffsetMetres']<=.001
        g[f'{phase}:labeledInlet']=b['labeledInletMetres']<=.011
        for kind in ['filteredC0','readoutC0']:
            for channel in range(4):
                high=a[kind][channel];low=b[kind][channel]
                g[f'{phase}:{kind}:{channel}:absolute']=low<=.003
                g[f'{phase}:{kind}:{channel}:contraction']=low<=1e-5 or low<=.8*high
    result.update(worldIndex=triple[0]['spec']['worldIndex'],policy=triple[0]['spec']['policy'],directionalCoarse=coarse,directionalFine=fine,passed=all(g.values()))
    return result
