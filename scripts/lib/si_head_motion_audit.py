"""Independent forward-history checks; no imports from the simulation engine."""
import math
import numpy as np

MODES = [('stationary',0.,0.,4.),('translation-1mm-4s',.001,0.,4.),
         ('translation-10mm-4s',.01,0.,4.),('translation-10mm-1s',.01,0.,1.),
         ('rotation-15deg-4s',0.,math.pi/12,4.),('rotation-15deg-1s',0.,math.pi/12,1.)]


def cases():
    out=[]
    for field in ['peak','offset-peak','ridge','uniform','blank','si-continuous','si-pulse']:
        for phase in [5,15] if field=='si-pulse' else [0]:
            for mode in range(6):
                for rep in range(4):
                    out.append(dict(index=len(out),field=field,phaseSeconds=phase,radiusMetres=.05,response='nominal',noiseC0=.001,replicate=rep,seed=960101+rep,worldSeed=100301+rep,panel='head-motion',mode=mode))
    return out


class EngineRandom:
    def __init__(self,seed):
        self.state=seed&0xffffffff or 0x9e3779b9
        self.spare=None

    def next(self):
        self.state=(self.state+0x6d2b79f5)&0xffffffff
        v=self.state
        v=((v^(v>>15))*(v|1))&0xffffffff
        v^=(v+(((v^(v>>7))*(v|61))&0xffffffff))&0xffffffff
        return ((v^(v>>14))&0xffffffff)/4294967296

    def normal(self):
        if self.spare is not None:
            out=self.spare;self.spare=None;return out
        u=max(1e-12,self.next());v=self.next();radius=math.sqrt(-2*math.log(u))
        self.spare=radius*math.sin(2*math.pi*v)
        return radius*math.cos(2*math.pi*v)


def engine_seed(seed):
    h=2166136261
    for value in [seed,9173]:
        h^=int(math.floor(value*1000003+.5))&0xffffffff
        h=(h*16777619)&0xffffffff
        h^=h>>13
    return h


def filtered_history(times,inputs,settings):
    """Closed-form accumulated integral, independent of engine segment-window code."""
    times=np.asarray(times);inputs=np.asarray(inputs)
    step=float(times[1]-times[0]);window=settings['averagingSeconds']
    window_ticks=round(window/step)
    assert times[0]==0 and np.max(abs(np.diff(times)-step))<1e-12
    assert abs(window_ticks*step-window)<1e-12 and window_ticks>0
    delay=math.pi*(settings['tubeInnerDiameterMetres']/2)**2*settings['tubeLengthMetres']/(settings['flowLitresPerMinutePerChannel']/60000)
    due=times+delay;event=0;clock=0.;state=np.zeros(4);target=np.zeros(4);integral=np.zeros(4)
    antiderivative=np.zeros_like(inputs)
    def advance(end):
        nonlocal clock,state,integral
        length=end-clock
        if length<=0:return
        tau=np.where(target>=state,settings['riseTimeConstantSeconds'],settings['recoveryTimeConstantSeconds'])
        one_minus=-np.expm1(-length/tau)
        integral=integral+target*length+(state-target)*tau*one_minus
        state=state+(target-state)*one_minus
        clock=end
    for i,time in enumerate(times):
        while event<len(due) and due[event]<=time:
            advance(float(due[event]));target=inputs[event].copy();event+=1
        advance(float(time));antiderivative[i]=integral
    prior=np.zeros_like(inputs)
    if window_ticks<len(times):prior[window_ticks:]=antiderivative[:-window_ticks]
    return (antiderivative-prior)/window


def expected_noisy_readout(filtered,dt,config):
    rng=EngineRandom(engine_seed(config['seed']));out=np.zeros_like(filtered);last=np.zeros(4)
    ticks=round(config['localInletSampling']['sampleIntervalSeconds']/dt)
    for i,value in enumerate(filtered):
        if i%ticks==0:last=np.clip(value+config['sensorNoise']*np.array([rng.normal() for _ in range(4)]),0,config['sensorSaturation'])
        rng.normal();rng.normal()  # Wind readout consumes two normals even at zero noise.
        out[i]=last
    return out


def physical_values(points,t,config,spec):
    p=np.asarray(points);domain=config['domainMeters'];field=spec['field']
    x=(p[...,0]-.5)*domain;y=(p[...,1]-.5)*domain
    if field=='peak':return .01+np.exp(-(x*x+y*y)/.18)
    if field=='offset-peak':return .01+np.exp(-((x-.03)**2+(y+.02)**2)/.18)
    if field=='ridge':return .01+np.exp(-x*x/.18)
    if field=='uniform':return np.ones_like(x)
    if field=='blank':return np.zeros_like(x)
    # Independent quadrature of the prescribed SI half-space kernel, at selected
    # clocks only. This checks evaluator agreement, not outdoor CFD validation.
    a=config['physicalAtmosphere'];m=a['measurement'];age=t+a['sourceAgeAtMissionStartSeconds']
    nodes,weights=np.polynomial.legendre.leggauss(4)
    source=np.array([config['sourcePositionOverride'][k]*domain for k in ['x','y']])
    heading=math.radians(config['windDirectionDegrees']);wind=config['localInletSampling']['referenceWindMetresPerSecond']*np.array([math.sin(heading),-math.cos(heading)])
    ages=[];masses=[];lo=0.
    while lo<age:
        hi=min(age,lo+a['quadraturePanelSeconds'])
        if 'pulse' in a:
            pulse=a['pulse'];half=pulse['periodSeconds']/2;phase=pulse['phaseSeconds']
            edge=(math.floor((lo+phase+1e-10)/half)+1)*half-phase
            if edge>lo+1e-10:hi=min(hi,edge)
        midpoint=(lo+hi)/2;rate=a['emissionRateKgPerSecond']
        if 'pulse' in a and (midpoint+phase)%pulse['periodSeconds']>=half:rate=0.
        if rate:
            ages.extend(age-midpoint-(hi-lo)/2*nodes)
            masses.extend(rate*(hi-lo)/2*weights)
        lo=hi
    ages=np.array(ages);v=a['sourceWidthMetres']**2+2*a['diffusivityMetresSquaredPerSecond']*ages
    centres=source+ages[:,None]*wind
    delta=p.reshape(-1,2)[:,None,:]*domain-centres
    z=config['localInletSampling']['inletHeightMetres'];h=a['releaseHeightMetres']
    vertical=np.exp(-(z-h)**2/(2*v))+np.exp(-(z+h)**2/(2*v))
    amplitude=np.array(masses)/(2*math.pi*v)**1.5
    value=np.sum(np.exp(-np.sum(delta*delta,axis=2)/(2*v))*amplitude*vertical,axis=1)
    return ((value+m['backgroundKgPerCubicMetre'])/m['concentrationScaleKgPerCubicMetre']).reshape(p.shape[:-1])


def inspect_history(record,config,trace,dt,*,noisy=True):
    tr=np.asarray(trace,dtype=float);spec=record['spec'];n=len(tr)
    assert tr.shape==(n,28 if noisy else 24) and np.isfinite(tr).all()
    assert n==round(record['summary']['completedAt']/dt)+1 and np.max(abs(tr[:,0]-np.arange(n)*dt))<1e-12
    visit=tr[:,1].astype(int);assert np.array_equal(tr[:,1],visit) and visit.min()==0 and visit.max()==16
    arrivals=np.array([v['arrivedAt'] for v in record['visits']])[visit]
    age=tr[:,0]-arrivals;name,amplitude,rotation,period=MODES[spec['mode']]
    wave=np.where((age>=0)&(age<=12),np.sin(2*np.pi*age/period),0.)
    direction=visit*np.pi/8+spec['replicate']*np.pi/7
    offset=amplitude*wave[:,None]*np.column_stack([np.cos(direction),np.sin(direction)])
    angle=rotation*wave
    errors={'motion':float(max(np.max(abs(tr[:,5:7]-offset)),np.max(abs(tr[:,7]-angle))))}
    assert errors['motion']<1e-12
    angles=tr[:,4,None]+angle[:,None]+np.array([0,-np.pi/2,np.pi,np.pi/2])
    radius=config['localInletSampling']['opposingInletSpacingMetres']/2/config['domainMeters']
    expected_points=tr[:,None,2:4]+offset[:,None,:]/config['domainMeters']+radius*np.stack([np.cos(angles),np.sin(angles)],axis=2)
    points=tr[:,8:16].reshape(n,4,2);errors['inletGeometry']=float(np.max(abs(points-expected_points)))
    assert errors['inletGeometry']<1e-12
    if not spec['field'].startswith('si-'):
        expected=physical_values(points,0,config,spec)
        field_error=np.max(abs(tr[:,16:20]-expected));field_checks=4*n
    else:
        retained={round(s['time']/dt) for v in record['visits'] for s in v['samples']}
        checks=sorted(retained|set(range(0,n,257))|{n-1});field_error=0.;field_checks=4*len(checks)
        for i in checks:field_error=max(field_error,float(np.max(abs(tr[i,16:20]-physical_values(points[i],tr[i,0],config,spec)))))
    errors['fieldInput']=float(field_error);assert field_error<1e-10
    filtered=filtered_history(tr[:,0],tr[:,16:20],config['localInletSampling'])
    errors['sensorHistory']=float(np.max(abs(filtered-tr[:,20:24])));assert errors['sensorHistory']<1e-9
    if noisy:
        predicted=expected_noisy_readout(filtered,dt,config)
        errors['noisyReadout']=float(np.max(abs(predicted-tr[:,24:28])));assert errors['noisyReadout']<1e-9
        for i,(v,head,actual) in enumerate(zip(record['visits'],record['headVisits'],record['actualSamples'])):
            for body_sample,head_sample,physical in zip(v['samples'],head['samples'],actual):
                row=tr[round(body_sample['time']/dt)]
                assert np.max(abs(row[2:4]-[physical['position'][k] for k in ['x','y']]))<1e-12
                assert abs(row[4]-physical['heading'])<1e-12
                assert np.max(abs(row[24:28]-[c['concentration'] for c in physical['localInletReadings']]))<1e-12
                for j,k in enumerate(['x','y']):
                    assert abs(head_sample[k]-body_sample[k]-row[5+j]/.1)<1e-10
                assert {k:x for k,x in head_sample.items() if k not in ['x','y']}=={k:x for k,x in body_sample.items() if k not in ['x','y']}
    return {'traceRows':n,'inletGeometriesChecked':4*n,'fieldValuesChecked':field_checks,
            'sensorValuesChecked':4*n,'errors':errors,'maximumTrueOffsetMetres':float(np.max(np.linalg.norm(offset,axis=1))),
            'maximumTrueRotationRadians':float(np.max(abs(angle)))}
