#!/usr/bin/env python3
"""Independent, integrity-first Stage 2 prescribed-path study."""
import argparse,copy,gzip,hashlib,importlib.util,json,math,random,statistics,subprocess,time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np
from lib.si_head_motion_audit import inspect_history,physical_values,filtered_history,EngineRandom
from lib.si_stationary_head_contract import evaluate
from lib.si_reported_pose import transform
from lib.si_v4_decision_audit import check_decision
sp=importlib.util.spec_from_file_location('stage1p','scripts/analyze-stage1p.py');prior=importlib.util.module_from_spec(sp);sp.loader.exec_module(prior)
MESHES=[1/64,1/128,1/256]


def sha(b):return hashlib.sha256(b).hexdigest()


def cases():
    out=[]
    for field in ['peak','ridge','blank','si-continuous','si-pulse']:
        for rep in range(2):
            variants=[('reference',1,1,8,.02),('similar-small',.5,.25,8,.02),('similar-large',2,4,8,.02),('similar-slow',1,2,8,.02),('settle-12',1,1,12,.02),('settle-16',1,1,16,.02)]
            if field.startswith('si-'):variants.append(('wind-0.1',1,1,8,.1))
            for variant,l,b,first,wind in variants:out.append(dict(index=len(out),field=field,replicate=rep,seed=980101+rep,worldSeed=102301+rep,variant=variant,lengthScale=l,timeScale=b,firstReadout=first,wind=wind))
    return out


def base_spec(s):
    return dict(index=0,field=s['field'],phaseSeconds=5 if s['field']=='si-pulse' else 0,radiusMetres=.05,response='nominal',noiseC0=.001,replicate=s['replicate'],seed=s['seed'],worldSeed=s['worldSeed'],panel='head-motion',mode=0)


def expected_config(base,s):
    c=copy.deepcopy(base);p=c['localInletSampling'];a=c['physicalAtmosphere'];l=s['lengthScale'];b=s['timeScale'];extra=s['firstReadout']-8
    c['domainMeters']*=l;c['robotSpeed']/=b;c['durationSeconds']*=b;c['checkpointSeconds']=[v*b for v in c['checkpointSeconds']];c['fixedDt']*=b;c['sensorLag']*=b
    for key in ['opposingInletSpacingMetres','inletHeightMetres','robotLengthMetres','robotWidthMetres','tubeLengthMetres','tubeInnerDiameterMetres']:p[key]*=l
    p['referenceWindMetresPerSecond']=s['wind']*l/b;p['flowLitresPerMinutePerChannel']*=l**3/b
    for key in ['riseTimeConstantSeconds','recoveryTimeConstantSeconds','averagingSeconds','sampleIntervalSeconds']:p[key]*=b
    p['maximumTurnRateRadiansPerSecond']/=b;q=p['inspection'];q['settlingSeconds']=(q['settlingSeconds']+extra)*b;q['dwellSeconds']=(12+extra)*b;q['sampleSpacingSeconds']*=b
    q['maximumPairSeparationSeconds']=2*q['dwellSeconds']+2*q['offsetNormalized']/c['robotSpeed'];c['activeSniffCycleSeconds']=q['dwellSeconds']
    a['diffusivityMetresSquaredPerSecond']*=l*l/b;p['effectiveDiffusivityMetresSquaredPerSecond']=a['diffusivityMetresSquaredPerSecond']
    a['sourceWidthMetres']*=l;a['releaseHeightMetres']*=l;a['emissionRateKgPerSecond']*=l**3/b;a['sourceAgeAtMissionStartSeconds']*=b;a['quadraturePanelSeconds']*=b
    if 'pulse' in a:a['pulse']['periodSeconds']*=b;a['pulse']['phaseSeconds']*=b
    return c


def groups(c,s):
    p=c['localInletSampling'];a=c['physicalAtmosphere'];ell=.15*s['lengthScale'];u=p['referenceWindMetresPerSecond'];T=ell/u;flow=p['flowLitresPerMinutePerChannel']/60000
    delay=math.pi*(p['tubeInnerDiameterMetres']/2)**2*p['tubeLengthMetres']/flow
    g={'peclet':u*ell/a['diffusivityMetresSquaredPerSecond'],'domain':c['domainMeters']/ell,'robotToWind':c['robotSpeed']*c['domainMeters']/u,'turnRate':p['maximumTurnRateRadiansPerSecond']*T,
       'pump':flow/(u*ell**2),'sourceStrength':a['emissionRateKgPerSecond']/(a['measurement']['concentrationScaleKgPerCubicMetre']*u*ell**2),'delay':delay/T,
       'offset':p['inspection']['offsetNormalized']*c['domainMeters']/ell,'baseNavigationDt':c['fixedDt']/T,'firstReadout':s['firstReadout']*s['timeScale']/T,
       'waypointError':.05*s['lengthScale']/ell,'poseError':.001*s['lengthScale']/ell,'noise':c['sensorNoise'],'threshold':a['measurement']['thresholdKgPerCubicMetre']/a['measurement']['concentrationScaleKgPerCubicMetre'],'saturation':c['sensorSaturation']}
    for dest,key in [('sourceWidth','sourceWidthMetres'),('releaseHeight','releaseHeightMetres')]:g[dest]=a[key]/ell
    for dest,key in [('head','opposingInletSpacingMetres'),('height','inletHeightMetres'),('robotLength','robotLengthMetres'),('robotWidth','robotWidthMetres'),('tubeLength','tubeLengthMetres'),('tubeDiameter','tubeInnerDiameterMetres')]:g[dest]=p[key]/ell
    for dest,key in [('rise','riseTimeConstantSeconds'),('recovery','recoveryTimeConstantSeconds'),('averaging','averagingSeconds'),('sampling','sampleIntervalSeconds')]:g[dest]=p[key]/T
    for dest,key in [('settling','settlingSeconds'),('dwell','dwellSeconds')]:g[dest]=p['inspection'][key]/T
    for dest,key in [('quadraturePanel','quadraturePanelSeconds'),('sourceAge','sourceAgeAtMissionStartSeconds')]:g[dest]=a[key]/T
    g.update(pulsePeriod=a.get('pulse',{}).get('periodSeconds',0)/T,pulsePhase=a.get('pulse',{}).get('phaseSeconds',0)/T,pulseDuty=a.get('pulse',{}).get('dutyFraction',0))
    return dict(featureMetres=ell,timeScaleSeconds=T,groups=g)


def normalized_inputs(h,s):
    visits=copy.deepcopy(h['visits']);contract=copy.deepcopy(h['motionContract']);b=s['timeScale']
    for v in visits:
        v['arrivedAt']/=b;v['closedAt']/=b
        for sample in v['samples']:sample['time']/=b
    for w in contract['windows']:w['start']/=b;w['end']/=b;w['translationDiameterMetres']/=s['lengthScale']
    return visits,contract


def decisions(h,s):
    visits,contract=normalized_inputs(h,s);out=[]
    for model,radius in [('exact',0.),('readout-jitter',.001)]:
        observed=transform(visits,dict(model=model,amplitudeMetres=radius),s['replicate']+500000)
        rng=random.Random(1800101+s['replicate']);rng.random();draws=[]
        for _ in range(102):
            rad=math.sqrt(rng.random());angle=2*math.pi*rng.random();draws.append([rad*math.cos(angle),rad*math.sin(angle)])
        errors=np.array(draws[17:]).reshape(17,5,2)*radius
        for i,(old,new) in enumerate(zip(visits,observed['visits'])):
            for j,(a,b) in enumerate(zip(old['samples'],new['samples'])):
                assert np.max(abs(np.array([b['x']-a['x'],b['y']-a['y']])-errors[i,j]/.1))<1e-12
                assert {k:v for k,v in a.items() if k not in ['x','y']}=={k:v for k,v in b.items() if k not in ['x','y']}
        assert np.max(abs(np.array(observed['worldErrorsMetres'])-errors))<1e-12
        result=evaluate(observed['visits'],radius,motion_contract=contract);assert result['admitted']
        audit=check_decision(observed['visits'],result['candidate'],radius,0.)
        physical_radius=result['candidate'].get('relativePeakRadiusMetres')
        out.append(dict(reporting=model,referencePoseRadius=radius,physicalPoseRadiusMetres=radius*s['lengthScale'],observed=observed,admission=result,audit=audit,
                        relativePeakRadiusPhysicalMetres=None if physical_radius is None else physical_radius*s['lengthScale']))
    return out


def inspect_replay(base,s,c,h):
    tr=np.array(h['trace']);dt=h['referenceDt']*s['timeScale'];b=s['timeScale'];extra=s['firstReadout']-8
    duration=(base['summary']['completedAt']+17*extra)*b;n=round(duration/dt)+1
    assert h['schemaVersion']=='si-scale-memory-history-v1' and h['dt']==dt and tr.shape==(n,24) and np.isfinite(tr).all()
    assert h['summary']['completedAt']==duration and h['summary']['retainedSamples']==85 and not h['summary']['nativeDeclaration'] and not h['summary']['nativeAbstention']
    assert abs(h['summary']['pathLengthMetres']-base['summary']['pathLengthMeters']*s['lengthScale'])<1e-12
    assert abs(h['summary']['airLitres']-4*c['localInletSampling']['flowLitresPerMinutePerChannel']*duration/60)<1e-12
    rt=tr[:,0]/b;assert np.max(abs(rt-np.arange(n)*h['referenceDt']))<1e-12
    mapped=rt.copy()
    for i,v in enumerate(base['visits']):
        begin=v['arrivedAt']+i*extra;end=v['closedAt']+(i+1)*extra
        mapped[rt>end]=rt[rt>end]-(i+1)*extra
        within=(rt>=begin)&(rt<=end);mapped[within]=np.minimum(rt[within]-i*extra,v['closedAt'])
    orig=np.array(base['trace']);k=np.minimum(np.floor(mapped/.0625).astype(int),len(orig)-1);end=np.minimum(k+1,len(orig)-1);f=(mapped-orig[k,0])/.0625
    expected_xy=orig[k,2:4]+f[:,None]*(orig[end,2:4]-orig[k,2:4]);angles=orig[k,4]+f*np.arctan2(np.sin(orig[end,4]-orig[k,4]),np.cos(orig[end,4]-orig[k,4]))
    geometry_error=max(float(np.max(abs(tr[:,2:4]-expected_xy))),float(np.max(abs(tr[:,4]-angles))))
    assert geometry_error<1e-12 and np.array_equal(tr[:,1],orig[k,1]) and np.max(abs(tr[:,5:8]))==0
    p=c['localInletSampling'];point_angles=tr[:,4,None]+np.array([0,-math.pi/2,math.pi,math.pi/2]);radius=p['opposingInletSpacingMetres']/(2*c['domainMeters'])
    points=tr[:,8:16].reshape(n,4,2);expected_points=tr[:,None,2:4]+radius*np.stack([np.cos(point_angles),np.sin(point_angles)],axis=2)
    inlet_error=float(np.max(abs(points-expected_points)));assert inlet_error<1e-12
    samples=[];assert len(h['visits'])==len(h['motionContract']['windows'])==17
    for i,(v,w) in enumerate(zip(h['visits'],h['motionContract']['windows'])):
        arrival=(base['visits'][i]['arrivedAt']+i*extra)*b;closed=arrival+(12+extra)*b
        assert v['arrivedAt']==arrival and v['closedAt']==closed and len(v['samples'])==5
        assert w==dict(visit=i,start=arrival,end=closed,translationDiameterMetres=0,orientationSpanRadians=0)
        within=(tr[:,0]>=arrival)&(tr[:,0]<=closed);assert np.max(np.ptp(tr[within,2:8],axis=0))<1e-12
        for j,sample in enumerate(v['samples']):
            assert sample['time']==arrival+(s['firstReadout']+j)*b
            for axis in ['x','y']:assert sample[axis]==base['visits'][i]['samples'][j][axis]
            samples.append(sample)
    assert h['motionContract']['version']=='continuous-stationary-head-v1' and h['motionContract']['basis']=='prescribed-numerical-constraint' and h['motionContract']['scope']=='continuous-head-centre-and-orientation'
    indices=[round(sample['time']/dt) for sample in samples]
    if s['field'].startswith('si-'):
        checks=sorted(set(indices)|set(range(0,n,257))|{n-1});field_error=0.
        for i in checks:field_error=max(field_error,float(np.max(abs(physical_values(points[i],tr[i,0],c,s)-tr[i,16:20]))))
        field_count=4*len(checks)
    else:
        # Synthetic field width also scales with lambda; use reference coordinates.
        field_error=float(np.max(abs(physical_values(points,0,{'domainMeters':100},s)-tr[:,16:20])));field_count=4*n
    assert field_error<1e-10
    filtered=filtered_history(tr[:,0],tr[:,16:20],p);history_error=float(np.max(abs(filtered-tr[:,20:24])));assert history_error<1e-9
    rng=EngineRandom(s['worldSeed']+2000000);noise=np.array([[rng.normal()*c['sensorNoise'] for _ in range(4)] for _ in range(round(duration/b)+1)])
    assert noise.shape==np.array(h['readoutNoise']).shape and np.max(abs(noise-h['readoutNoise']))<1e-12
    for index,sample in zip(indices,samples):
        values=np.clip(tr[index,20:24]+noise[round(sample['time']/b)],0,c['sensorSaturation'])
        assert abs(sample['value']-values.mean())<1e-12 and sample['hit']==(sample['value']>=.115) and sample['clipped']==bool(np.any(values>=c['sensorSaturation']-1e-9)) and sample['telemetryComplete']
    mismatch=tr[indices,20:24].mean(axis=1)-tr[indices,16:20].mean(axis=1)
    analytic_error=None
    if not s['field'].startswith('si-'):
        # Independent constant-target dwell solution, initialized at the actual
        # delayed arrival from the full preceding zero-order-held input history.
        arrivals={round(v['arrivedAt']/dt):i for i,v in enumerate(h['visits'])};initials={};state=np.zeros(4)
        for i,target in enumerate(tr[:,16:20]):
            if i:
                prev=tr[i-1,16:20];tau=np.where(prev>=state,p['riseTimeConstantSeconds'],p['recoveryTimeConstantSeconds']);state=prev+(state-prev)*np.exp(-dt/tau)
            if i in arrivals:initials[arrivals[i]]=state.copy()
        delay=math.pi*(p['tubeInnerDiameterMetres']/2)**2*p['tubeLengthMetres']/(p['flowLitresPerMinutePerChannel']/60000);analytic_error=0.
        for i,v in enumerate(h['visits']):
            target=tr[round(v['arrivedAt']/dt),16:20];initial=initials[i];tau=np.where(target>=initial,p['riseTimeConstantSeconds'],p['recoveryTimeConstantSeconds']);W=p['averagingSeconds']
            for sample in v['samples']:
                age=sample['time']-v['arrivedAt']-delay;assert age>=W
                expected=target+(initial-target)*tau/W*(np.exp(-(age-W)/tau)-np.exp(-age/tau))
                analytic_error=max(analytic_error,float(np.max(abs(expected-tr[round(sample['time']/dt),20:24]))))
        assert analytic_error<1e-9
    deltas=np.linalg.norm(np.diff(tr[:,2:4],axis=0),axis=1)*c['domainMeters'];moving=deltas>0
    distance=float(sum(deltas));assert abs(distance-h['summary']['pathLengthMetres'])<1e-8
    return dict(traceRows=n,fieldValuesChecked=field_count,inletGeometriesChecked=4*n,sensorValuesChecked=4*n,
                errors=dict(bodyGeometry=geometry_error,inletGeometry=inlet_error,fieldInput=field_error,sensorHistory=history_error,constantTargetDwell=analytic_error),
                memoryMismatch=dict(maxAbsoluteC0=float(np.max(abs(mismatch))),rmsC0=float(np.sqrt(np.mean(mismatch**2))),perVisitRmsC0=np.sqrt(np.mean(mismatch.reshape(17,5)**2,axis=1)).tolist()),
                actualMotion=dict(pathMetres=distance,movingSeconds=float(np.count_nonzero(moving)*dt),maximumSpeedMetresPerSecond=float(np.max(deltas)/dt),
                                  meanMovingSpeedMetresPerSecond=distance/(np.count_nonzero(moving)*dt),inspectionSeconds=duration,airLitres=h['summary']['airLitres']),
                retainedNoiselessChannelsC0=tr[indices,20:24].tolist(),retainedTimes=[v['time']/b for v in samples])


def read_record(path,item):
    body=Path(path).read_bytes();assert len(body)==item['bytes'] and sha(body)==item['sha256'];return json.loads(gzip.decompress(body))


def inspect_one(task):
    path,item,s,c,bc,out=task;base=read_record(path,item)
    prior.base.prior.inspect_record({**base,'schemaVersion':'si-stationary-dwell-run-v1'},base_spec(s),bc)
    ba=inspect_history(base,bc,base['trace'],.0625);levels=[];sampled=[];statuses=[]
    assert [h['referenceDt'] for h in item['histories']]==MESHES
    for entry in item['histories']:
        h=read_record(Path(path).parent/entry['file'],entry);assert len(h['trace'])==entry['traceRows'] and h['referenceDt']==entry['referenceDt']
        audit=inspect_replay(base,s,c,h);ds=decisions(h,s);sampled.append(np.array(audit['retainedNoiselessChannelsC0']));statuses.append([d['admission']['status'] for d in ds]);levels.append(dict(referenceDt=h['referenceDt'],audit=audit,decisions=ds))
    conv=prior.convergence(sampled,statuses,levels[0]['audit']['retainedTimes'])
    detail=dict(spec=s,baseAudit=ba,levels=levels,convergence=conv);body=gzip.compress(json.dumps(detail,sort_keys=True,separators=(',',':')).encode(),mtime=0);file=f'details/setting-{s["index"]:03d}.json.gz'
    with (Path(out)/file).open('xb') as f:f.write(body)
    # Compact outputs retain full fit coefficients/radii needed by similarity checks.
    compact=[]
    for level in levels:
        ds=[]
        for d in level['decisions']:
            v=d['admission']['candidate'];ds.append(dict(reporting=d['reporting'],status=v['status'],reason=v['reason'],coefficients=v.get('geometry',{}).get('coefficients'),referencePeakRadius=v.get('relativePeakRadiusMetres'),physicalPeakRadiusMetres=d['relativePeakRadiusPhysicalMetres'],audit=d['audit'],values=[s['value'] for w in d['observed']['visits'] for s in w['samples']]))
        compact.append(dict(referenceDt=level['referenceDt'],audit=level['audit'],decisions=ds))
    return dict(spec=s,baseAudit=ba,baseSha256=item['sha256'],levels=compact,convergence=conv,detail=dict(file=file,sha256=sha(body),bytes=len(body)))


def similarity_one(task):
    raw,item,reference,s,rs=task;comparisons=[]
    for a,b in zip(item['histories'],reference['histories']):
        x=read_record(Path(raw)/item['directory']/a['file'],a);y=read_record(Path(raw)/reference['directory']/b['file'],b)
        xt=np.array(x['trace']);yt=np.array(y['trace']);assert xt.shape==yt.shape
        errors=dict(clock=float(np.max(abs(xt[:,0]/s['timeScale']-yt[:,0]))),geometry=float(np.max(abs(xt[:,1:16]-yt[:,1:16]))),trueInput=float(np.max(abs(xt[:,16:20]-yt[:,16:20]))),filtered=float(np.max(abs(xt[:,20:24]-yt[:,20:24]))))
        observed=max(abs(v['value']-w['value']) for a,b in zip(x['visits'],y['visits']) for v,w in zip(a['samples'],b['samples']));errors['observed']=observed
        comparisons.append(dict(referenceDt=a['referenceDt'],errors=errors,passed=errors['clock']<=1e-12 and errors['geometry']<=1e-12 and all(errors[k]<=1e-9 for k in ['trueInput','filtered','observed'])))
    return dict(index=s['index'],referenceIndex=rs['index'],comparisons=comparisons,passed=all(c['passed'] for c in comparisons))


def main():
    if not __debug__:raise RuntimeError('Assertions required')
    ap=argparse.ArgumentParser();ap.add_argument('--raw',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);ap.add_argument('--node',required=True);args=ap.parse_args();start=time.perf_counter();raw=args.raw;out=args.output
    mb=(raw/'manifest.json').read_bytes();m=json.loads(mb);done=json.loads((raw/'complete.json').read_text())
    assert done['complete'] and not done['failures'] and done['manifestSha256']==sha(mb) and m['schemaVersion']=='si-scale-memory-pilot-v1'
    assert m['cases']==cases() and m['caseCount']==done['caseCount']==64 and m['historyCount']==done['historyCount']==192 and m['workerCount']==4 and m['referenceMeshes']==MESHES and m['reportingSeedBase']==1800101
    assert len(m['configs'])==len(m['configHashes'])==len(m['baseConfigs'])==len(m['groups'])==64
    for source in m['sources']:assert sha(Path(source['file']).read_bytes())==source['sha256']==sha((raw/'source-snapshot'/source['name']).read_bytes())
    js="""import{readFileSync}from'node:fs';import{createHash}from'node:crypto';const m=JSON.parse(readFileSync(process.argv[1],'utf8'));const c=v=>Array.isArray(v)?v.map(c):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,c(v)])):v;m.configs.forEach((v,i)=>{if(createHash('sha256').update(JSON.stringify(c(v),null,2)+'\\n').digest('hex')!==m.configHashes[i])throw Error('Config hash')});"""
    subprocess.run([args.node,'--input-type=module','-e',js,str(raw/'manifest.json')],check=True)
    refs=json.loads((prior.base.prior.REFERENCE/'manifest.json').read_text())['configs']
    for s,c,bc,g in zip(m['cases'],m['configs'],m['baseConfigs'],m['groups']):
        assert prior.base.prior.same_config(bc,prior.base.prior.expected_config(refs,base_spec(s)))
        assert prior.base.prior.same_config(c,expected_config(bc,s)) and prior.base.prior.same_config(g,groups(c,s))
    out.mkdir(parents=True,exist_ok=False);(out/'details').mkdir();inventory={};tasks=[];workers=[]
    assert len(list(raw.glob('worker-*')))==len(done['workers'])==4
    for worker in sorted(raw.glob('worker-*')):
        d=json.loads((worker/'complete.json').read_text());w=d['worker'];assert d['complete'] and worker.name==f'worker-{w}' and len(d['inventory'])==16 and len(list(worker.glob('*.json.gz')))==64
        assert done['workers'][w]['status']=='fulfilled' and done['workers'][w]['value']['code']==0 and done['workers'][w]['value']['pid']==d['pid']
        workers.append({k:d[k] for k in ['worker','pid','startedAt','finishedAt','elapsedSeconds','maxRssBytes']})
        for e in d['inventory']:
            i=e['index'];assert i not in inventory and i%4==w;inventory[i]={**e,'directory':worker.name}
            tasks.append((str(worker/e['file']),e,m['cases'][i],m['configs'][i],m['baseConfigs'][i],str(out)))
    assert set(inventory)==set(range(64));records=[]
    with ProcessPoolExecutor(max_workers=4) as pool:
        for record in pool.map(inspect_one,tasks):
            records.append(record)
            if len(records)%8==0:print(f'Independent audits: {len(records)}/64 settings, {len(records)*3}/192 histories',flush=True)
    records.sort(key=lambda r:r['spec']['index']);matched=defaultdict(set)
    for r in records:matched[r['spec']['field'],r['spec']['replicate']].add(r['baseSha256'])
    assert len(matched)==10 and all(len(v)==1 for v in matched.values())
    sim_tasks=[]
    for s in m['cases']:
        if s['variant'].startswith('similar-'):
            rs=next(r for r in m['cases'] if r['field']==s['field'] and r['replicate']==s['replicate'] and r['variant']=='reference')
            sim_tasks.append((str(raw),inventory[s['index']],inventory[rs['index']],s,rs))
    with ProcessPoolExecutor(max_workers=4) as pool:similarity=list(pool.map(similarity_one,sim_tasks))
    for pair in similarity:
        i,j=pair['index'],pair['referenceIndex'];g,h=m['groups'][i]['groups'],m['groups'][j]['groups'];group_error=max(abs(g[k]-h[k])/max(1,abs(h[k])) for k in g)
        decision_error=0.;same=True
        for a,b in zip(records[i]['levels'],records[j]['levels']):
            for x,y in zip(a['decisions'],b['decisions']):
                same=bool(same and x['status']==y['status'] and x['reason']==y['reason'])
                for key in ['coefficients','referencePeakRadius']:
                    if x[key] is None or y[key] is None:same=bool(same and x[key] is y[key])
                    else:decision_error=max(decision_error,float(np.max(abs(np.array(x[key])-y[key]))))
        pair.update(groupError=group_error,decisionQuantityError=decision_error,decisionsSame=same);pair['passed']=bool(pair['passed'] and group_error<=1e-10 and decision_error<=1e-8 and same)
    all_audits=[l['audit'] for r in records for l in r['levels']];da=[d['audit'] for r in records for l in r['levels'] for d in l['decisions']]
    assert len(all_audits)==192 and len(da)==384
    audit=dict(accepted=True,settings=64,responseHistories=192,baseRoutesAudited=64,uniqueBaseRoutes=10,decisionsChecked=384,
               inletGeometriesChecked=sum(q['inletGeometriesChecked'] for q in all_audits),sensorValuesChecked=sum(q['sensorValuesChecked'] for q in all_audits),fieldValuesChecked=sum(q['fieldValuesChecked'] for q in all_audits),
               maximumErrors={k:max(q['errors'].get(k) or 0 for q in all_audits) for k in ['bodyGeometry','inletGeometry','fieldInput','sensorHistory','constantTargetDwell']},maximumDecisionDifference=max(d['maximumNumericDifference'] for d in da),rawManifestSha256=sha(mb))
    control=[d for r in records if r['spec']['field'] in ['ridge','blank'] for l in r['levels'] for d in l['decisions']]
    gates=dict(responseResolution=all(r['convergence']['passed'] for r in records),physicalSimilarity=all(p['passed'] for p in similarity),staticControlsNotSupported=all(d['status']!='supported' for d in control))
    analysis=dict(schemaVersion='si-scale-memory-analysis-v1',integrityAccepted=True,scientificGates=gates,passed=all(gates.values()),settings=64,responseHistories=192,primaryEvaluations=384,
                  failedResolutionIndices=[r['spec']['index'] for r in records if not r['convergence']['passed']],similarity=similarity,staticControlEvaluations=len(control),staticControlSupports=sum(d['status']=='supported' for d in control),
                  workers=workers,rawInventory=list(inventory.values()),rawManifestSha256=sha(mb),physicalWallSeconds=done['elapsedSeconds'],analysisWallSeconds=time.perf_counter()-start)
    for name,data in [('analysis.json',analysis),('independent-audit.json',audit),('run-summaries.json',records)]:
        with (out/name).open('x') as f:f.write(json.dumps(data,sort_keys=True,indent=2)+'\n')
    with (out/'complete.json').open('x') as f:f.write(json.dumps(dict(complete=True,files={name:sha((out/name).read_bytes()) for name in ['analysis.json','independent-audit.json','run-summaries.json']}),indent=2)+'\n')
    print(json.dumps(dict(audit=audit,scientificGates=gates,passed=analysis['passed'],failedResolutionIndices=analysis['failedResolutionIndices'],physicalWallSeconds=done['elapsedSeconds'],analysisWallSeconds=analysis['analysisWallSeconds']),indent=2))


if __name__=='__main__':main()
