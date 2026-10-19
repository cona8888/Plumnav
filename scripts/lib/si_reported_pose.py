"""Frozen Stage 1l observation-channel perturbations; never change readings."""
import copy
import math
import random

MODELS=['frame-translation','relative-bias','visit-drift','continuous-drift','visit-error','readout-jitter']
AMPLITUDES=[.0001,.001,.005,.01,.02]
OFFSET_METRES=.1


def alternatives():
    return [{'model':'exact','amplitudeMetres':0}]+[{'model':model,'amplitudeMetres':a} for model in MODELS for a in AMPLITUDES]


def unit_errors(replicate):
    rng=random.Random(1300101+replicate)
    angle=2*math.pi*rng.random();direction=[math.cos(angle),math.sin(angle)]
    def disk():
        radius=math.sqrt(rng.random());angle=2*math.pi*rng.random()
        return [radius*math.cos(angle),radius*math.sin(angle)]
    return {'direction':direction,'visits':[disk() for _ in range(17)],'samples':[[disk() for _ in range(5)] for _ in range(17)]}


def transform(visits,alternative,replicate):
    model=alternative['model'];amplitude=alternative['amplitudeMetres']
    if model not in ['exact',*MODELS] or amplitude<0:
        raise ValueError('Unknown reporting model or negative amplitude')
    if len(visits)!=17 or any(len(v['samples'])!=5 for v in visits):
        raise ValueError('Reporting experiment requires complete windows')
    vectors=unit_errors(replicate);direction=vectors['direction']
    start=visits[0]['samples'][0]['time'];span=visits[-1]['samples'][-1]['time']-start
    if span<=0:
        raise ValueError('Invalid observation span')
    anchor=[amplitude*x for x in direction] if model=='frame-translation' else [0.,0.]
    transformed=copy.deepcopy(visits);errors=[]
    for i,(original,new) in enumerate(zip(visits,transformed)):
        visit_errors=[]
        for j,(sample,reported) in enumerate(zip(original['samples'],new['samples'])):
            if model=='exact':unit=[0.,0.]
            elif model in ['frame-translation','relative-bias']:unit=direction
            elif model=='visit-drift':unit=[x*i/16 for x in direction]
            elif model=='continuous-drift':unit=[x*(sample['time']-start)/span for x in direction]
            elif model=='visit-error':unit=vectors['visits'][i]
            else:unit=vectors['samples'][i][j]
            error=[amplitude*x for x in unit];visit_errors.append(error)
            for k,axis in enumerate(('x','y')):
                reported[axis]=sample[axis]+(error[k]-anchor[k])/OFFSET_METRES
        # Targets are normalized world coordinates; included as reporting metadata only.
        for k,axis in enumerate(('x','y')):
            new['target'][axis]=original['target'][axis]+sum(e[k] for e in visit_errors)/5/100
        errors.append(visit_errors)
    return {'visits':transformed,'worldErrorsMetres':errors,'anchorErrorMetres':anchor,'unitErrors':vectors}
