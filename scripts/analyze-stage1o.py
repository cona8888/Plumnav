#!/usr/bin/env python3
"""Frozen Stage 1o integrity-first forward-motion challenge and analysis."""
import argparse,copy,gzip,hashlib,importlib.util,json,math,random,statistics,subprocess,time
from collections import Counter,defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np
from lib.si_head_motion_audit import cases,MODES,inspect_history,EngineRandom,engine_seed
from lib.si_bounded_pose_v4 import evaluate
from lib.si_reported_pose import transform
from lib.si_v4_decision_audit import check_decision

sp=importlib.util.spec_from_file_location('prior_integrity','scripts/analyze-stage1k.py')
prior=importlib.util.module_from_spec(sp);sp.loader.exec_module(prior)
POSITIVES={'peak','offset-peak','si-continuous'}


def sha(b):return hashlib.sha256(b).hexdigest()


def verify_reporting(original,reported,amplitude,rep):
    rng=random.Random(1600101+rep);rng.random()
    draws=[]
    for _ in range(102):
        radius=math.sqrt(rng.random());angle=2*math.pi*rng.random();draws.append([radius*math.cos(angle),radius*math.sin(angle)])
    errors=np.array(draws[17:]).reshape(17,5,2)*amplitude
    for i,(old,new) in enumerate(zip(original,reported['visits'])):
        for j,(a,b) in enumerate(zip(old['samples'],new['samples'])):
            assert np.max(abs(np.array([b['x']-a['x'],b['y']-a['y']])-errors[i,j]/.1))<1e-12
            assert {k:v for k,v in a.items() if k not in ['x','y']}=={k:v for k,v in b.items() if k not in ['x','y']}
    assert np.max(abs(np.array(reported['worldErrorsMetres'])-errors))<1e-12


def variants(visits,spec):
    results=[]
    for wrong_contract in [False,True] if spec['mode']>=4 else [False]:
        heading=0. if wrong_contract else 2*MODES[spec['mode']][2]
        for model,amplitude in [('exact',0.),('readout-jitter',.001)]:
            alternative={'model':model,'amplitudeMetres':amplitude}
            observed=transform(visits,alternative,spec['replicate']+300000)
            verify_reporting(visits,observed,amplitude,spec['replicate'])
            decision=evaluate(observed['visits'],amplitude,observation_model='fixed-orientation-local-quadratic',dwell_heading_span_radians=heading)
            audit=check_decision(observed['visits'],decision,amplitude,heading)
            results.append({**alternative,'contractClass':'deliberately-misspecified-zero-rotation' if wrong_contract else 'declared-motion',
                            'headingSpanBoundRadians':heading,**observed,'v4':decision,'independentDecisionAudit':audit})
    return results


def noise_at_retained(record,config):
    rng=EngineRandom(engine_seed(config['seed']));wanted={s['time'] for v in record['visits'] for s in v['samples']};out={}
    dt=config['fixedDt'];stride=round(config['localInletSampling']['sampleIntervalSeconds']/dt)
    for i,row in enumerate(record['trace']):
        if i%stride==0:
            noise=config['sensorNoise']*np.array([rng.normal() for _ in range(4)])
            if row[0] in wanted:out[row[0]]=noise
        rng.normal();rng.normal()
    assert len(out)==85
    return out


def inspect_one(task):
    raw_path,entry,spec,config,config_hash,out_path=task
    content=Path(raw_path).read_bytes();assert len(content)==entry['bytes'] and sha(content)==entry['sha256']
    r=json.loads(gzip.decompress(content));assert r['schemaVersion']=='si-head-motion-run-v1' and r['configSha256']==config_hash
    prior.inspect_record({**r,'schemaVersion':'si-stationary-dwell-run-v1'},spec,config)
    for actual in r['actualSamples']:
        assert all(s['position']==actual[0]['position'] and s['heading']==actual[0]['heading'] for s in actual)
    tr=np.array(r['trace']);audit=inspect_history(r,config,r['trace'],config['fixedDt'])
    if spec['mode']==0:
        reference=r['zeroMotionReference'];assert reference is not None and reference['configSha256']==config_hash
        prior.inspect_record({**reference,'schemaVersion':'si-stationary-dwell-run-v1'},spec,config)
        assert all(r[k]==reference[k] for k in ['visits','actualSamples','result','summary'])
    else:assert r['zeroMotionReference'] is None
    decisions=variants(r['headVisits'],spec)
    original=prior.original_audit.recompute(r['headVisits'])
    for decision in decisions:
        d=decision['v4'];diagnostic=None
        if d['status']=='supported' and original['peak'] is not None:
            distance=.1*float(np.linalg.norm(np.array(d['geometry']['peak'])-original['peak']))
            diagnostic={'distanceToExactCoordinateFitMetres':distance,'radiusMetres':d['relativePeakRadiusMetres'],'contained':distance<=d['relativePeakRadiusMetres']+1e-8}
        decision['pairedFitEnclosure']=diagnostic
        if d['status']=='supported' and spec['field'] in ['peak','offset-peak']:
            true_peak=np.array([0.,0.]) if spec['field']=='peak' else np.array([.03,-.02])
            decision['analyticFieldPeakErrorMetres']=float(np.linalg.norm(.1*np.array(d['geometry']['peak'])-true_peak))
        else:decision['analyticFieldPeakErrorMetres']=None
    motion=[]
    for visit in r['headVisits']:
        start=visit['samples'][0]['time'];end=visit['closedAt'];rows=tr[(tr[:,0]>=start)&(tr[:,0]<=end)]
        keep=tr[[round(s['time']/config['fixedDt']) for s in visit['samples']]]
        motion.append({'fullRateHeadDisplacementDiameterMetres':float(np.linalg.norm(np.ptp(rows[:,5:7],axis=0))),
                       'retainedHeadDisplacementDiameterMetres':float(np.linalg.norm(np.ptp(keep[:,5:7],axis=0))),
                       'fullRateAngularSpanRadians':float(np.ptp(rows[:,7])), 'retainedAngularSpanRadians':float(np.ptp(keep[:,7]))})
    refinement=[];should_refine=spec['replicate']==0 and spec['mode'] in [3,5] and (spec['field'] in ['peak','ridge','si-continuous'] or spec['field']=='si-pulse' and spec['phaseSeconds']==5)
    assert len(r['refinements'])==(2 if should_refine else 0)
    retained=[s['time'] for v in r['headVisits'] for s in v['samples']]
    mean_sets=[tr[[round(t/config['fixedDt']) for t in retained],20:24].mean(axis=1)]
    previous_keys=[(v['model'],v['contractClass'],v['v4']['status']) for v in decisions]
    fine_primary_stable=True
    noises=noise_at_retained(r,config) if should_refine else None
    for f,dt in zip(r['refinements'],[.03125,.015625]):
        assert f['dt']==dt and f['kind']=='prescribed-path-integration-refinement'
        ft=np.array(f['trace']);k=np.minimum(np.floor(ft[:,0]/config['fixedDt']).astype(int),len(tr)-1);next_k=np.minimum(k+1,len(tr)-1)
        fraction=(ft[:,0]-tr[k,0])/config['fixedDt'];expected=tr[k,2:4]+fraction[:,None]*(tr[next_k,2:4]-tr[k,2:4])
        assert np.max(abs(ft[:,2:4]-expected))<1e-12 and np.array_equal(ft[:,1],tr[k,1])
        delta=np.arctan2(np.sin(tr[next_k,4]-tr[k,4]),np.cos(tr[next_k,4]-tr[k,4]))
        assert np.max(abs(ft[:,4]-tr[k,4]-fraction*delta))<1e-12
        fa=inspect_history(r,config,f['trace'],dt,noisy=False)
        fv=copy.deepcopy(r['headVisits'])
        threshold=config['physicalAtmosphere']['measurement']['thresholdKgPerCubicMetre']/config['physicalAtmosphere']['measurement']['concentrationScaleKgPerCubicMetre']
        for v in fv:
            for sample in v['samples']:
                values=np.clip(ft[round(sample['time']/dt),20:24]+noises[sample['time']],0,config['sensorSaturation'])
                sample['value']=float(values.mean());sample['clipped']=bool(np.any(values>=config['sensorSaturation']-1e-9));sample['hit']=sample['value']>=threshold
        fine_decisions=variants(fv,spec)
        keys=[(v['model'],v['contractClass'],v['v4']['status']) for v in fine_decisions]
        fine_primary_stable=fine_primary_stable and all(a==b for a,b in zip(previous_keys,keys) if a[1]=='declared-motion')
        previous_keys=keys
        mean_sets.append(ft[[round(t/dt) for t in retained],20:24].mean(axis=1))
        refinement.append({'dt':dt,'audit':fa,'variants':fine_decisions})
    convergence=None
    if should_refine:
        coarse_difference=float(np.max(abs(mean_sets[1]-mean_sets[0])))
        fine_difference=float(np.max(abs(mean_sets[2]-mean_sets[1])))
        convergence={'coarseToMiddleMaxC0':coarse_difference,'middleToFineMaxC0':fine_difference,
                     'fineBelowOneThirdSensitivityMargin':fine_difference<=.001,
                     'contraction':fine_difference<=.75*coarse_difference+1e-8,'primarySupportDecisionsStable':fine_primary_stable}
        convergence['passed']=all(convergence[k] for k in ['fineBelowOneThirdSensitivityMargin','contraction','primarySupportDecisionsStable'])
    detail={'spec':spec,'variants':decisions,'motionWindows':motion,'forwardAudit':audit,'refinements':refinement,'convergence':convergence}
    data=gzip.compress(json.dumps(detail,sort_keys=True,separators=(',',':')).encode(),mtime=0)
    dest=Path(out_path)/'variants'/f"physical-{spec['index']:03d}.json.gz"
    with dest.open('xb') as handle:handle.write(data)
    compact=[{k:v for k,v in item.items() if k in ['model','amplitudeMetres','contractClass','headingSpanBoundRadians','pairedFitEnclosure','analyticFieldPeakErrorMetres','independentDecisionAudit']}|{'status':item['v4']['status'],'reason':item['v4']['reason']} for item in decisions]
    return {'spec':spec,'variants':compact,'forwardAudit':audit,'refinementAudits':[f['audit'] for f in refinement],
            'refinementDecisionAudits':[d['independentDecisionAudit'] for f in refinement for d in f['variants']],
            'convergence':convergence,'motionWindows':motion,'bodyTrajectorySha256':sha(tr[:,:5].tobytes()),
            'inspectionSeconds':r['summary']['completedAt'],'detail':{'file':str(dest.relative_to(out_path)),'sha256':sha(data),'bytes':len(data)}}


def main():
    if not __debug__:raise RuntimeError('Assertions required')
    ap=argparse.ArgumentParser();ap.add_argument('--raw',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);ap.add_argument('--node',required=True);a=ap.parse_args();start=time.perf_counter()
    mb=(a.raw/'manifest.json').read_bytes();m=json.loads(mb);done=json.loads((a.raw/'complete.json').read_text())
    assert done['complete'] and not done['failures'] and done['manifestSha256']==sha(mb)
    assert m['schemaVersion']=='si-head-motion-pilot-v1' and m['cases']==cases() and m['caseCount']==done['caseCount']==192
    assert m['workerCount']==4 and m['unwrappedReferences']==32 and m['prescribedPathRefinements']==16
    assert len(m['configs'])==len(m['configHashes'])==192 and len(m['modes'])==6
    for saved,expected in zip(m['modes'],MODES):
        assert saved['id']==expected[0] and np.max(abs(np.array([saved['translationMetres'],saved['rotationRadians'],saved['periodSeconds']])-expected[1:]))<1e-15
    for s in m['sources']:assert sha(Path(s['file']).read_bytes())==s['sha256']==sha((a.raw/'source-snapshot'/s['name']).read_bytes())
    js="""import{readFileSync}from'node:fs';import{createHash}from'node:crypto';const m=JSON.parse(readFileSync(process.argv[1],'utf8'));const c=v=>Array.isArray(v)?v.map(c):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,c(v)])):v;m.configs.forEach((v,i)=>{if(createHash('sha256').update(JSON.stringify(c(v),null,2)+'\\n').digest('hex')!==m.configHashes[i])throw Error('Config hash')});"""
    subprocess.run([a.node,'--input-type=module','-e',js,str(a.raw/'manifest.json')],check=True)
    reference=json.loads((prior.REFERENCE/'manifest.json').read_text())
    for s,c in zip(m['cases'],m['configs']):assert prior.same_config(prior.expected_config(reference['configs'],s),c)
    a.output.mkdir(parents=True,exist_ok=False);(a.output/'variants').mkdir()
    tasks=[];seen=set();workers=[];raw_inventory=[]
    assert len(list(a.raw.glob('worker-*')))==4
    for worker in sorted(a.raw.glob('worker-*')):
        d=json.loads((worker/'complete.json').read_text());w=d['worker'];assert d['complete'] and worker.name==f'worker-{w}'
        assert len(d['inventory'])==len(list(worker.glob('run-*.json.gz')))==48 and d['unwrappedReferences']==8 and d['prescribedPathRefinements']==[4,4,8,0][w]
        workers.append({k:d[k] for k in ['worker','pid','startedAt','finishedAt','elapsedSeconds','maxRssBytes']})
        for entry in d['inventory']:
            i=entry['index'];assert i not in seen and (i+i//24)%4==w;seen.add(i)
            path=worker/entry['file'];tasks.append((str(path),entry,m['cases'][i],m['configs'][i],m['configHashes'][i],str(a.output)))
            raw_inventory.append({**entry,'file':str(path.relative_to(a.raw))})
    assert seen==set(range(192))
    records=[]
    with ProcessPoolExecutor(max_workers=4) as pool:
        for record in pool.map(inspect_one,tasks):
            records.append(record)
            if len(records)%24==0:print(f'Independent forward/decision audits: {len(records)}/192',flush=True)
    records.sort(key=lambda r:r['spec']['index'])
    body=defaultdict(set)
    for r in records:body[r['spec']['field'],r['spec']['phaseSeconds'],r['spec']['replicate']].add(r['bodyTrajectorySha256'])
    assert len(body)==32 and all(len(v)==1 for v in body.values())
    primary=[(r,v) for r in records for v in r['variants'] if v['contractClass']=='declared-motion']
    assert len(primary)==384
    alias=[r for r in records if r['spec']['mode'] in [3,5]]
    alias_verified=all(max(w['retainedHeadDisplacementDiameterMetres'] for w in r['motionWindows'])<1e-10 and max(w['retainedAngularSpanRadians'] for w in r['motionWindows'])<1e-10 for r in alias)
    gates={'zeroMotionEquivalence':True,'bodyTrajectoryMatched':True,
           'noPrimaryControlSupport':all(v['status']!='supported' for r,v in primary if r['spec']['field'] not in POSITIVES),
           'stationaryCorePositivesSupported':all(v['status']=='supported' for r,v in primary if r['spec']['mode']==0 and r['spec']['field'] in POSITIVES),
           'declaredRotationFailsClosed':all(v['reason']=='unresolved-within-dwell-orientation' for r,v in primary if r['spec']['mode']>=4),
           'pairedFitEnclosure':all(v['pairedFitEnclosure']['contained'] for r,v in primary if v['pairedFitEnclosure'] is not None),
           'aliasingKinematicsVerified':alias_verified,'prescribedPathRefinement':all(r['convergence']['passed'] for r in records if r['convergence'] is not None)}
    strata=[]
    for field,phase,mode in sorted({(r['spec']['field'],r['spec']['phaseSeconds'],r['spec']['mode']) for r in records}):
        rs=[r for r in records if (r['spec']['field'],r['spec']['phaseSeconds'],r['spec']['mode'])==(field,phase,mode)];assert len(rs)==4
        for contract in ['declared-motion','deliberately-misspecified-zero-rotation'] if mode>=4 else ['declared-motion']:
            for reporting in ['exact','readout-jitter']:
                vs=[v for r in rs for v in r['variants'] if v['contractClass']==contract and v['model']==reporting]
                strata.append(dict(field=field,phaseSeconds=phase,mode=MODES[mode][0],contractClass=contract,reporting=reporting,n=4,supported=sum(v['status']=='supported' for v in vs),reasons=dict(Counter(v['reason'] for v in vs))))
    audits=[q for r in records for q in [r['forwardAudit'],*r['refinementAudits']]]
    da=[d for r in records for d in [*(v['independentDecisionAudit'] for v in r['variants']),*r['refinementDecisionAudits']]]
    audit={'accepted':True,'primaryPhysicalRecords':192,'unwrappedReferences':32,'prescribedPathRefinements':16,
           'inletGeometriesChecked':sum(q['inletGeometriesChecked'] for q in audits),'fieldValuesChecked':sum(q['fieldValuesChecked'] for q in audits),
           'sensorValuesChecked':sum(q['sensorValuesChecked'] for q in audits),'decisionEvaluationsChecked':len(da),
           'maximumErrors':{k:max(q['errors'].get(k,0) for q in audits) for k in ['motion','inletGeometry','fieldInput','sensorHistory','noisyReadout']},
           'maximumDecisionNumericDifference':max(d['maximumNumericDifference'] for d in da),'rawManifestSha256':sha(mb),
           'method':'Independent Python kinematics, prescribed-field spot checks for SI/all analytic inputs, accumulated-integral sensor replay, RNG/noise replay and separately coded v4 decision audit. Candidate is frozen; this does not validate real hardware.'}
    analysis={'schemaVersion':'si-head-motion-analysis-v1','integrityAccepted':True,'scientificGates':gates,'passed':all(gates.values()),
              'primaryPhysicalInspections':192,'primaryPairedEvaluations':384,'misspecifiedRotationEvaluations':128,
              'strata':strata,'rawInventory':raw_inventory,'rawManifestSha256':sha(mb),'workers':workers,
              'physicalWallSeconds':done['elapsedSeconds'],'analysisWallSeconds':time.perf_counter()-start,
              'inspectionSeconds':{'min':min(r['inspectionSeconds'] for r in records),'median':statistics.median(r['inspectionSeconds'] for r in records),'max':max(r['inspectionSeconds'] for r in records)},
              'convergence':[{'spec':r['spec'],**r['convergence']} for r in records if r['convergence'] is not None]}
    for name,data in [('analysis.json',analysis),('independent-audit.json',audit),('run-summaries.json',records)]:
        with (a.output/name).open('x') as f:f.write(json.dumps(data,sort_keys=True,indent=2)+'\n')
    marker={'complete':True,'files':{name:sha((a.output/name).read_bytes()) for name in ['analysis.json','independent-audit.json','run-summaries.json']}}
    with (a.output/'complete.json').open('x') as f:f.write(json.dumps(marker,indent=2)+'\n')
    print(json.dumps({'independentAudit':audit,'scientificGates':gates,'passed':analysis['passed'],'physicalWallSeconds':analysis['physicalWallSeconds'],'analysisWallSeconds':analysis['analysisWallSeconds']},indent=2))


if __name__=='__main__':main()
