#!/usr/bin/env python3
"""Integrity-first fresh resolution witness; preserves all prior failed gates."""
import argparse,copy,gzip,hashlib,importlib.util,json,math,random,statistics,subprocess,time
from collections import Counter,defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np
from lib.si_head_motion_audit import inspect_history
from lib.si_bounded_pose_v4 import evaluate
from lib.si_reported_pose import transform
from lib.si_v4_decision_audit import check_decision

sp=importlib.util.spec_from_file_location('stage1o_analysis','scripts/analyze-stage1o.py')
base=importlib.util.module_from_spec(sp);sp.loader.exec_module(base)
MESHES=[1/64,1/128,1/256]


def sha(b):return hashlib.sha256(b).hexdigest()


def cases():
    out=[]
    for field in ['peak','ridge','si-continuous','si-pulse']:
        for mode in [3,5]:
            for rep in range(4):
                out.append(dict(index=len(out),field=field,phaseSeconds=5 if field=='si-pulse' else 0,radiusMetres=.05,response='nominal',noiseC0=.001,replicate=rep,seed=970101+rep,worldSeed=101301+rep,panel='head-motion',mode=mode))
    return out


def variants(visits,spec):
    results=[];heading=math.pi/6 if spec['mode']==5 else 0.
    for model,amplitude in [('exact',0.),('readout-jitter',.001)]:
        observed=transform(visits,dict(model=model,amplitudeMetres=amplitude),spec['replicate']+400000)
        rng=random.Random(1700101+spec['replicate']);rng.random();draws=[]
        for _ in range(102):
            radius=math.sqrt(rng.random());angle=2*math.pi*rng.random();draws.append([radius*math.cos(angle),radius*math.sin(angle)])
        errors=np.array(draws[17:]).reshape(17,5,2)*amplitude
        for i,(old,new) in enumerate(zip(visits,observed['visits'])):
            for j,(a,b) in enumerate(zip(old['samples'],new['samples'])):
                assert np.max(abs(np.array([b['x']-a['x'],b['y']-a['y']])-errors[i,j]/.1))<1e-12
                assert {k:v for k,v in a.items() if k not in ['x','y']}=={k:v for k,v in b.items() if k not in ['x','y']}
        assert np.max(abs(np.array(observed['worldErrorsMetres'])-errors))<1e-12
        decision=evaluate(observed['visits'],amplitude,observation_model='fixed-orientation-local-quadratic',dwell_heading_span_radians=heading)
        audit=check_decision(observed['visits'],decision,amplitude,heading)
        results.append(dict(model=model,amplitudeMetres=amplitude,headingSpanBoundRadians=heading,**observed,v4=decision,independentDecisionAudit=audit))
    return results


def comparison(coarse,fine,times):
    delta=fine-coarse;scalar=delta.mean(axis=1);j=int(np.argmax(abs(scalar)))
    return dict(maxScalarChangeC0=float(np.max(abs(scalar))),rmsScalarChangeC0=float(np.sqrt(np.mean(scalar**2))),
                maxChannelChangeC0=float(np.max(abs(delta))),perChannelMaxChangeC0=np.max(abs(delta),axis=0).tolist(),
                rmsChannelChangeC0=float(np.sqrt(np.mean(delta**2))),timeAtMaxScalarChange=times[j],visitAtMaxScalarChange=j//5,
                channelChangesAtScalarMaximum=delta[j].tolist())


def convergence(sampled,statuses,times):
    comparisons=[comparison(a,b,times) for a,b in zip(sampled,sampled[1:])]
    coarse,fine=[c['maxScalarChangeC0'] for c in comparisons]
    gates=dict(fineBelowOneThirdSensitivityMargin=fine<=.001,contraction=fine<=.75*coarse+1e-8,
               primarySupportDecisionsStable=all(s==statuses[0] for s in statuses[1:]))
    return dict(comparisons=comparisons,**gates,passed=all(gates.values()))


def read_record(path,entry):
    b=Path(path).read_bytes();assert len(b)==entry['bytes'] and sha(b)==entry['sha256']
    return json.loads(gzip.decompress(b))


def inspect_one(task):
    raw_path,entry,spec,c,ch,out=task
    r=read_record(raw_path,entry);assert r['schemaVersion']=='si-head-motion-run-v1' and r['configSha256']==ch
    base.prior.inspect_record({**r,'schemaVersion':'si-stationary-dwell-run-v1'},spec,c)
    coarse=np.array(r['trace']);audits=[{'dt':c['fixedDt'],'role':'body-route-generator',**inspect_history(r,c,r['trace'],c['fixedDt'])}]
    times=[s['time'] for v in r['headVisits'] for s in v['samples']];assert len(times)==len(set(times))==85
    noises=base.noise_at_retained(r,c);datasets=[];levels=[];statuses=[];reason_codes=[];decision_audits=[]
    assert [e['dt'] for e in entry['refinements']]==MESHES
    for item,dt in zip(entry['refinements'],MESHES):
        f=read_record(Path(raw_path).parent/item['file'],item)
        assert f['dt']==dt and f['kind']=='prescribed-path-integration-refinement' and len(f['trace'])==item['traceRows']
        tr=np.array(f['trace']);k=np.minimum(np.floor(tr[:,0]/c['fixedDt']).astype(int),len(coarse)-1);end=np.minimum(k+1,len(coarse)-1)
        fraction=(tr[:,0]-coarse[k,0])/c['fixedDt']
        assert np.max(abs(tr[:,2:4]-coarse[k,2:4]-fraction[:,None]*(coarse[end,2:4]-coarse[k,2:4])))<1e-12
        assert np.array_equal(tr[:,1],coarse[k,1])
        angle=np.arctan2(np.sin(coarse[end,4]-coarse[k,4]),np.cos(coarse[end,4]-coarse[k,4]))
        assert np.max(abs(tr[:,4]-coarse[k,4]-fraction*angle))<1e-12
        audits.append({'dt':dt,'role':'response-integration-mesh',**inspect_history(r,c,f['trace'],dt,noisy=False)})
        visits=copy.deepcopy(r['headVisits']);threshold=c['physicalAtmosphere']['measurement']['thresholdKgPerCubicMetre']/c['physicalAtmosphere']['measurement']['concentrationScaleKgPerCubicMetre']
        for visit in visits:
            for sample in visit['samples']:
                values=np.clip(tr[round(sample['time']/dt),20:24]+noises[sample['time']],0,c['sensorSaturation'])
                sample['value']=float(values.mean());sample['clipped']=bool(np.any(values>=c['sensorSaturation']-1e-9));sample['hit']=sample['value']>=threshold
        vs=variants(visits,spec);statuses.append([v['v4']['status'] for v in vs]);reason_codes.append([v['v4']['reason'] for v in vs])
        decision_audits.extend(v['independentDecisionAudit'] for v in vs)
        sample=tr[[round(t/dt) for t in times],20:24];datasets.append(sample)
        levels.append(dict(dt=dt,retainedNoiselessChannelsC0=sample.tolist(),variants=vs))
    result=convergence(datasets,statuses,times)
    detail=dict(spec=spec,retainedTimes=times,levels=levels,audits=audits,convergence=result)
    b=gzip.compress(json.dumps(detail,sort_keys=True,separators=(',',':')).encode(),mtime=0)
    file=f'details/physical-{spec["index"]:03d}.json.gz'
    with (Path(out)/file).open('xb') as h:h.write(b)
    return dict(spec=spec,convergence=result,statusesByMesh=statuses,reasonsByMesh=reason_codes,reasonCodesStable=all(s==reason_codes[0] for s in reason_codes[1:]),
                audits=audits,decisionAudits=decision_audits,bodyTrajectorySha256=sha(coarse[:,:5].tobytes()),inspectionSeconds=r['summary']['completedAt'],
                detail=dict(file=file,sha256=sha(b),bytes=len(b)))


def main():
    if not __debug__:raise RuntimeError('Audit assertions must be enabled')
    ap=argparse.ArgumentParser();ap.add_argument('--raw',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);ap.add_argument('--node',required=True);a=ap.parse_args();start=time.perf_counter()
    mb=(a.raw/'manifest.json').read_bytes();m=json.loads(mb);done=json.loads((a.raw/'complete.json').read_text())
    assert done['complete'] and not done['failures'] and done['manifestSha256']==sha(mb)
    assert m['schemaVersion']=='si-fine-resolution-pilot-v1' and m['cases']==cases() and m['caseCount']==done['caseCount']==32
    assert m['replayCount']==done['replayCount']==96 and m['meshes']==MESHES and m['workerCount']==4 and m['reportingSeedBase']==1700101
    assert len(m['configs'])==len(m['configHashes'])==32
    assert len(done['workers'])==4 and all(w['status']=='fulfilled' and w['value']['code']==0 for w in done['workers'])
    for s in m['sources']:assert sha(Path(s['file']).read_bytes())==s['sha256']==sha((a.raw/'source-snapshot'/s['name']).read_bytes())
    previous=Path('research/evidence/si_head_motion_pilot_2026-09-16/manifest.json')
    assert sha(previous.read_bytes())==m['previousStageManifestSha256']
    js="""import{readFileSync}from'node:fs';import{createHash}from'node:crypto';const m=JSON.parse(readFileSync(process.argv[1],'utf8'));const c=v=>Array.isArray(v)?v.map(c):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,c(v)])):v;m.configs.forEach((v,i)=>{if(createHash('sha256').update(JSON.stringify(c(v),null,2)+'\\n').digest('hex')!==m.configHashes[i])throw Error('Config hash')});"""
    subprocess.run([a.node,'--input-type=module','-e',js,str(a.raw/'manifest.json')],check=True)
    reference=json.loads((base.prior.REFERENCE/'manifest.json').read_text())
    for spec,c in zip(m['cases'],m['configs']):assert base.prior.same_config(base.prior.expected_config(reference['configs'],spec),c)
    a.output.mkdir(parents=True,exist_ok=False);(a.output/'details').mkdir()
    tasks=[];seen=set();workers=[];inventory=[]
    assert len(list(a.raw.glob('worker-*')))==4
    for worker in sorted(a.raw.glob('worker-*')):
        d=json.loads((worker/'complete.json').read_text());w=d['worker']
        assert d['complete'] and worker.name==f'worker-{w}' and len(d['inventory'])==8 and len(list(worker.glob('run-*.json.gz')))==32
        assert done['workers'][w]['value']['pid']==d['pid']
        workers.append({k:d[k] for k in ['worker','pid','startedAt','finishedAt','elapsedSeconds','maxRssBytes']})
        for e in d['inventory']:
            i=e['index'];assert i not in seen and i%4==w;seen.add(i)
            tasks.append((str(worker/e['file']),e,m['cases'][i],m['configs'][i],m['configHashes'][i],str(a.output)))
            inventory.append({**e,'directory':str(worker.relative_to(a.raw))})
    assert seen==set(range(32))
    records=[]
    with ProcessPoolExecutor(max_workers=4) as pool:
        for r in pool.map(inspect_one,tasks):
            records.append(r)
            if len(records)%4==0:print(f'Independent audits {len(records)}/32 paths + {len(records)*3}/96 replays',flush=True)
    records.sort(key=lambda r:r['spec']['index'])
    bodies=defaultdict(set)
    for r in records:bodies[r['spec']['field'],r['spec']['replicate']].add(r['bodyTrajectorySha256'])
    assert len(bodies)==16 and all(len(v)==1 for v in bodies.values())
    audits=[q for r in records for q in r['audits']];da=[q for r in records for q in r['decisionAudits']]
    assert len(audits)==128 and len(da)==192
    audit=dict(accepted=True,physicalPaths=32,prescribedPathReplays=96,decisionEvaluationsChecked=192,
               inletGeometriesChecked=sum(q['inletGeometriesChecked'] for q in audits),fieldValuesChecked=sum(q['fieldValuesChecked'] for q in audits),
               sensorValuesChecked=sum(q['sensorValuesChecked'] for q in audits),
               maximumErrors={k:max(q['errors'].get(k,0) for q in audits) for k in ['motion','inletGeometry','fieldInput','sensorHistory','noisyReadout']},
               maximumDecisionNumericDifference=max(q['maximumNumericDifference'] for q in da),rawManifestSha256=sha(mb))
    failed=[r['spec']['index'] for r in records if not r['convergence']['passed']]
    strata=[]
    for field in ['peak','ridge','si-continuous','si-pulse']:
        for mode in [3,5]:
            rows=[r for r in records if r['spec']['field']==field and r['spec']['mode']==mode]
            for mi,dt in enumerate(MESHES):
                for vi,model in enumerate(['exact','readout-jitter']):
                    strata.append(dict(field=field,mode=mode,dt=dt,reporting=model,n=4,supported=sum(r['statusesByMesh'][mi][vi]=='supported' for r in rows),reasons=dict(Counter(r['reasonsByMesh'][mi][vi] for r in rows))))
    analysis=dict(schemaVersion='si-fine-resolution-analysis-v1',integrityAccepted=True,passed=not failed,failedPhysicalIndices=failed,
                  physicalPaths=32,prescribedPathReplays=96,primaryPairedEvaluations=192,rawInventory=inventory,workers=workers,strata=strata,
                  convergence=[dict(spec=r['spec'],**r['convergence']) for r in records],reasonCodeChanges=[r['spec']['index'] for r in records if not r['reasonCodesStable']],
                  physicalWallSeconds=done['elapsedSeconds'],analysisWallSeconds=time.perf_counter()-start,rawManifestSha256=sha(mb),
                  inspectionSeconds=dict(min=min(r['inspectionSeconds'] for r in records),median=statistics.median(r['inspectionSeconds'] for r in records),max=max(r['inspectionSeconds'] for r in records)),
                  priorStage1oFailurePreserved=True,nextAction='define-continuous-motion-observation-contract' if not failed else 'stop-expansion-and-revise-numerical-plan')
    for name,data in [('analysis.json',analysis),('independent-audit.json',audit),('run-summaries.json',records)]:
        with (a.output/name).open('x') as h:h.write(json.dumps(data,sort_keys=True,indent=2)+'\n')
    marker=dict(complete=True,files={n:sha((a.output/n).read_bytes()) for n in ['analysis.json','independent-audit.json','run-summaries.json']})
    with (a.output/'complete.json').open('x') as h:h.write(json.dumps(marker,indent=2)+'\n')
    print(json.dumps(dict(audit=audit,passed=not failed,failedPhysicalIndices=failed,physicalWallSeconds=done['elapsedSeconds'],analysisWallSeconds=analysis['analysisWallSeconds']),indent=2))


if __name__=='__main__':main()
