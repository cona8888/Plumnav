#!/usr/bin/env python3
"""Stage 1m frozen physical and paired-observation analysis."""
import argparse
from collections import Counter,defaultdict
from datetime import datetime,timezone
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import time
from lib.si_reported_pose import transform,MODELS
from lib.si_bounded_pose import evaluate as v3_evaluate
from lib.si_stationary_dwell import evaluate as v2_evaluate

spec=importlib.util.spec_from_file_location('stage1l','scripts/analyze-stage1l.py')
previous=importlib.util.module_from_spec(spec);spec.loader.exec_module(previous)
POSITIVES=previous.POSITIVES


def sha(data):return hashlib.sha256(data).hexdigest()


def cases():
    result=[]
    def add(field,phase,radius,rep,noise,panel):
        result.append(dict(index=len(result),field=field,phaseSeconds=phase,radiusMetres=radius,response='nominal',noiseC0=noise,replicate=rep,seed=940101+rep,worldSeed=98301+rep,panel=panel))
    for field in previous.prior.FIELDS:
        for phase in [5,15] if field=='si-pulse' else [0]:
            for radius in [0,.05]:
                for rep in range(4):add(field,phase,radius,rep,.001,'core')
    for field in ['peak','offset-peak','si-continuous','si-pulse','uniform','blank']:
        for rep in range(4):add(field,5 if field=='si-pulse' else 0,.05,rep,.02,'noise-stress')
    assert len(result)==120
    return result


def alternatives():
    return [dict(model='exact',amplitudeMetres=0)]+[dict(model=model,amplitudeMetres=a) for model in MODELS for a in [.0001,.001,.01]]


def candidate(visits,alternative):
    frame=alternative['model']=='frame-translation';amplitude=alternative['amplitudeMetres']
    return v3_evaluate(visits,0. if frame else amplitude,frame_radius_metres=amplitude if frame else 0.,
                       observation_model='fixed-orientation-local-quadratic',dwell_heading_span_radians=0.)


def main():
    if not __debug__:raise RuntimeError('Audit assertions required')
    p=argparse.ArgumentParser();p.add_argument('--raw',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--node',required=True)
    a=p.parse_args();start=time.perf_counter();mb=(a.raw/'manifest.json').read_bytes();m=json.loads(mb);top=json.loads((a.raw/'complete.json').read_text())
    assert top['complete'] and not top['failures'] and top['manifestSha256']==sha(mb)
    assert m['schemaVersion']=='si-bounded-pose-physical-pilot-v1' and m['cases']==cases() and m['caseCount']==top['caseCount']==120 and m['workerCount']==4
    for source in m['sources']:
        assert sha((a.raw/'source-snapshot'/source['name']).read_bytes())==source['sha256']==sha(Path(source['file']).read_bytes())
    js="""import{readFileSync}from'node:fs';import{createHash}from'node:crypto';const m=JSON.parse(readFileSync(process.argv[1],'utf8'));const c=v=>Array.isArray(v)?v.map(c):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,c(v)])):v;m.configs.forEach((v,i)=>{if(createHash('sha256').update(JSON.stringify(c(v),null,2)+'\\n').digest('hex')!==m.configHashes[i])throw Error('Config hash')});"""
    subprocess.run([a.node,'--input-type=module','-e',js,str(a.raw/'manifest.json')],check=True)
    reference=json.loads((previous.prior.REFERENCE/'manifest.json').read_text())
    physical=[];seen=set();raw_inventory=[];workers=[]
    assert len(list(a.raw.glob('worker-*')))==4
    for worker in sorted(a.raw.glob('worker-*')):
        done=json.loads((worker/'complete.json').read_text());w=done['worker']
        assert done['complete'] and worker.name==f'worker-{w}' and len(done['inventory'])==len(list(worker.glob('run-*.json.gz')))==30
        workers.append({k:done[k] for k in ['worker','pid','startedAt','finishedAt','elapsedSeconds','maxRssBytes']})
        for item in done['inventory']:
            i=item['index'];assert i not in seen and i%4==w;seen.add(i)
            raw=(worker/item['file']).read_bytes();assert sha(raw)==item['sha256'] and len(raw)==item['bytes']
            r=json.loads(gzip.decompress(raw));s=cases()[i];c=m['configs'][i]
            assert r['schemaVersion']=='si-bounded-pose-physical-run-v1' and r['configSha256']==m['configHashes'][i]
            assert previous.prior.same_config(previous.prior.expected_config(reference['configs'],s),c)
            previous.prior.inspect_record({**r,'schemaVersion':'si-stationary-dwell-run-v1'},s,c)
            assert all(all(s['heading']==window[0]['heading'] and s['position']==window[0]['position'] for s in window) for window in r['actualSamples'])
            physical.append(r);raw_inventory.append(dict(index=i,file=str((worker/item['file']).relative_to(a.raw)),sha256=sha(raw)))
    assert seen==set(range(120))
    a.output.mkdir(parents=True,exist_ok=False);(a.output/'variants').mkdir();summaries=[];inventory=[]
    for r in sorted(physical,key=lambda x:x['spec']['index']):
        baseline=previous.fit(r['visits']);exact=candidate(r['visits'],dict(model='exact',amplitudeMetres=0));variants=[]
        for j,alternative in enumerate(alternatives()):
            transformed=transform(r['visits'],alternative,r['spec']['replicate']+100000)
            fitted=previous.fit(transformed['visits']);v2=v2_evaluate(transformed['visits'],fitted);v3=candidate(transformed['visits'],alternative)
            coverage=None
            if v3['status']=='supported' and r['spec']['field'] in POSITIVES and baseline['peak'] is not None:
                peak=v3['geometry']['peak'];distance=.1*math.hypot(peak[0]-baseline['peak']['x'],peak[1]-baseline['peak']['y'])
                coverage={'pairedFitDistanceMetres':distance,'radiusMetres':v3['relativePeakRadiusMetres'],'contained':distance<=v3['relativePeakRadiusMetres']+1e-8}
            variants.append({'alternativeIndex':j,**alternative,**transformed,'originalRefit':fitted,'v2':v2,'v3':v3,'coverageDiagnostic':coverage})
            summaries.append({'physicalSpec':r['spec'],'alternativeIndex':j,**alternative,'v2':previous.compact(v2),'v3':previous.compact(v3),
                              'exactV3':previous.compact(exact),'dwellState':v3.get('dwell',{}).get('state','not-evaluated'),
                              'crossfitState':v3.get('crossfit',{}).get('state','not-evaluated'),'coverageDiagnostic':coverage})
        content=gzip.compress(json.dumps({'physicalSpec':r['spec'],'variants':variants},sort_keys=True,separators=(',',':')).encode(),mtime=0)
        file=f"variants/physical-{r['spec']['index']:03d}.json.gz"
        with (a.output/file).open('xb') as handle:handle.write(content)
        inventory.append(dict(physicalIndex=r['spec']['index'],file=file,sha256=sha(content),bytes=len(content)))
    assert len(summaries)==2280
    groups=defaultdict(list)
    for r in summaries:
        s=r['physicalSpec'];groups[s['field'],s['phaseSeconds'],s['radiusMetres'],s['noiseC0'],s['panel'],r['model'],r['amplitudeMetres']].append(r)
    strata=[]
    for key,rs in sorted(groups.items()):
        assert len(rs)==4
        field,phase,radius,noise,panel,model,amplitude=key
        out=dict(field=field,phaseSeconds=phase,waypointErrorRadiusMetres=radius,noiseC0=noise,panel=panel,model=model,amplitudeMetres=amplitude,n=4)
        for method in ['v2','v3']:
            out[method+'Support']=sum(r[method]['status']=='supported' for r in rs);out[method+'Reasons']=dict(Counter(r[method]['reason'] for r in rs))
        out.update(dwellStates=dict(Counter(r['dwellState'] for r in rs)),crossfitStates=dict(Counter(r['crossfitState'] for r in rs)))
        strata.append(out)
    core=[r for r in summaries if r['physicalSpec']['panel']=='core'];positives=[r for r in core if r['physicalSpec']['field'] in POSITIVES]
    gates={'noControlSupport':all(r['v3']['status']!='supported' for r in summaries if r['physicalSpec']['field'] not in POSITIVES),
           'coreExactPositivesSupported':all(r['v3']['status']=='supported' for r in positives if r['model']=='exact'),
           'coreSmallBoundPositivesSupported':all(r['v3']['status']=='supported' for r in positives if r['model'] not in ['exact','frame-translation'] and r['amplitudeMetres'] in [.0001,.001]),
           'frameInvariance':all(r['v3']==r['exactV3'] for r in summaries if r['model']=='frame-translation'),
           'supportedPairedFitEnclosure':all(r['coverageDiagnostic']['contained'] for r in summaries if r['coverageDiagnostic'] is not None)}
    result={'schemaVersion':'si-bounded-pose-analysis-v1','physicalIntegrityAccepted':True,'physicalInspections':120,'pairedEvaluations':2280,
            'rawManifestSha256':sha(mb),'rawInventory':raw_inventory,'variantInventory':inventory,'scientificGate':gates,'passed':all(gates.values()),
            'independentAuditRequired':True,'strata':strata,'workerExecution':workers,'physicalWallSeconds':top['elapsedSeconds'],'analysisWallSeconds':time.perf_counter()-start,
            'claimBoundary':'Fitted-quadratic coordinate robustness only; no validated physical gradient/motion model or field calibration.'}
    for name,data in [('analysis.json',result),('run-summaries.json',summaries)]:
        with (a.output/name).open('x') as handle:handle.write(json.dumps(data,sort_keys=True,indent=2)+'\n')
    lines=['# Stage 1m fresh bounded-pose pilot','', '120 physical inspections; 2,280 paired reporting alternatives. Four seeds per stratum; conditional surrogate-model results, not population performance estimates.','',
           '| Field | Phase | Waypoint radius (mm) | Noise / C0 | Reporting model | Bound (mm) | v2 support | v3 support | v3 reasons |','|---|---:|---:|---:|---|---:|---:|---:|---|']
    for s in strata:lines.append(f"| {s['field']} | {s['phaseSeconds']} | {s['waypointErrorRadiusMetres']*1000:g} | {s['noiseC0']} | {s['model']} | {s['amplitudeMetres']*1000:g} | {s['v2Support']}/4 | {s['v3Support']}/4 | {s['v3Reasons']} |")
    lines+=['','```json',json.dumps(gates,indent=2),'```'];(a.output/'results.md').write_text('\n'.join(lines)+'\n')
    (a.output/'complete.json').write_text(json.dumps({'complete':True,'analysisSha256':sha((a.output/'analysis.json').read_bytes()),'summarySha256':sha((a.output/'run-summaries.json').read_bytes())},indent=2)+'\n')
    print(json.dumps({k:result[k] for k in ['physicalIntegrityAccepted','physicalInspections','pairedEvaluations','scientificGate','passed','physicalWallSeconds','analysisWallSeconds']},indent=2))


if __name__=='__main__':main()
