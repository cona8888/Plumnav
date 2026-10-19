#!/usr/bin/env python3
"""Frozen Stage 1l physical-integrity audit and paired observation simulation."""
import argparse
from collections import Counter,defaultdict
from datetime import datetime,timezone
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import statistics
import subprocess
import time
from lib.si_reported_pose import alternatives,transform,MODELS,AMPLITUDES
from lib.si_pose_temporal import evaluate as evaluate_v1
from lib.si_stationary_dwell import evaluate as evaluate_v2


def load_module(name,filename):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


prior=load_module('stage1k_integrity','analyze-stage1k.py')
original_audit=load_module('stage1i_fit','audit-stage1i-decisions.py')
POSITIVES=prior.POSITIVES


def sha(data):
    return hashlib.sha256(data).hexdigest()


def expected_cases():
    cases=[]
    for field in prior.FIELDS:
        for phase in [0,10] if field=='si-pulse' else [0]:
            for radius in [0,.05]:
                for rep in range(4):
                    cases.append(dict(index=len(cases),field=field,phaseSeconds=phase,radiusMetres=radius,
                                      response='nominal',noiseC0=.001,replicate=rep,seed=930101+rep,worldSeed=98201+rep,panel='core'))
    assert len(cases)==96
    return cases


def fit(visits):
    r=original_audit.recompute(visits)
    return {**r,'coefficients':r['coefficients'].tolist(),'medians':r['medians'].tolist(),
            'peak':None if r['peak'] is None else dict(x=float(r['peak'][0]),y=float(r['peak'][1])),
            'status':'supported' if r['reason']=='local-quadratic-supported' else 'abstained'}


def peak_diagnostic(field,exact,current,anchor):
    if field not in POSITIVES or exact['peak'] is None or current['peak'] is None:
        return None
    relative=[.1*(current['peak'][axis]-exact['peak'][axis]) for axis in ('x','y')]
    world=[x+b for x,b in zip(relative,anchor)]
    return {'worldPeakDeltaMetres':world,'worldPeakDisplacementMetres':math.hypot(*world),
            'frameCorrectedPeakDisplacementMetres':math.hypot(*relative),
            'interpretation':'Paired fitted-peak displacement, not source error; fitted coordinates are not declarations.'}


def compact(v):
    return {'status':v['status'],'reason':v['reason']}


def main():
    if not __debug__:
        raise RuntimeError('Audit requires enabled assertions')
    p=argparse.ArgumentParser();p.add_argument('--raw',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--node',required=True)
    a=p.parse_args();start=time.perf_counter();mb=(a.raw/'manifest.json').read_bytes();m=json.loads(mb);top=json.loads((a.raw/'complete.json').read_text())
    expected=expected_cases()
    assert m['schemaVersion']=='si-reported-pose-physical-pilot-v1' and m['cases']==expected
    assert top['complete'] and not top['failures'] and top['manifestSha256']==sha(mb)
    assert m['caseCount']==top['caseCount']==96 and m['workerCount']==4
    assert len(m['configs'])==len(m['configHashes'])==96
    for source in m['sources']:
        assert sha((a.raw/'source-snapshot'/source['name']).read_bytes())==source['sha256']
        assert sha(Path(source['file']).read_bytes())==source['sha256'], 'Frozen source changed'
    js="""import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const m=JSON.parse(readFileSync(process.argv[1],'utf8'));
const c=v=>Array.isArray(v)?v.map(c):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,c(v)])):v;
m.configs.forEach((v,i)=>{if(createHash('sha256').update(JSON.stringify(c(v),null,2)+'\\n').digest('hex')!==m.configHashes[i])throw Error('Config checksum '+i)});"""
    subprocess.run([a.node,'--input-type=module','-e',js,str(a.raw/'manifest.json')],check=True)
    rb=(prior.REFERENCE/'manifest.json').read_bytes();reference=json.loads(rb)
    assert json.loads((prior.REFERENCE/'complete.json').read_text())['manifestSha256']==sha(rb)
    for s,c in zip(expected,m['configs']):
        assert prior.same_config(prior.expected_config(reference['configs'],s),c)
    physical=[];seen=set();raw_inventory=[];worker_times=[]
    assert len(list(a.raw.glob('worker-*')))==4
    for worker in sorted(a.raw.glob('worker-*')):
        marker=json.loads((worker/'complete.json').read_text());w=marker['worker']
        assert marker['complete'] and worker.name==f'worker-{w}' and len(marker['inventory'])==24
        assert len(list(worker.glob('run-*.json.gz')))==24
        worker_times.append({k:marker[k] for k in ['worker','pid','startedAt','finishedAt','elapsedSeconds','maxRssBytes']})
        for item in marker['inventory']:
            i=item['index'];assert i not in seen and i%4==w;seen.add(i)
            raw=(worker/item['file']).read_bytes();assert sha(raw)==item['sha256'] and len(raw)==item['bytes']
            r=json.loads(gzip.decompress(raw));assert r['schemaVersion']=='si-reported-pose-physical-run-v1'
            assert r['configSha256']==m['configHashes'][i]
            # The prior routine checks the common physical-record structure, not the campaign label.
            prior.inspect_record({**r,'schemaVersion':'si-stationary-dwell-run-v1'},expected[i],m['configs'][i])
            for window in r['actualSamples']:
                assert all(s['position']==window[0]['position'] and s['heading']==window[0]['heading'] for s in window)
            physical.append(r);raw_inventory.append({'index':i,'file':str((worker/item['file']).relative_to(a.raw)),'sha256':sha(raw)})
    assert seen==set(range(96))
    a.output.mkdir(parents=True,exist_ok=False);(a.output/'variants').mkdir()
    all_summaries=[];variant_inventory=[];gauge_checks=[]
    for r in sorted(physical,key=lambda r:r['spec']['index']):
        exact_fit=fit(r['visits']);exact_v2=evaluate_v2(r['visits'],exact_fit);variants=[]
        for j,alternative in enumerate(alternatives()):
            changed=transform(r['visits'],alternative,r['spec']['replicate']);fitted=fit(changed['visits'])
            v1=evaluate_v1(changed['visits'],fitted);v2=evaluate_v2(changed['visits'],fitted)
            assert v1['temporal']==v2['crossfit']
            for old,new in zip(r['visits'],changed['visits']):
                assert old['closedAt']==new['closedAt'] and old['arrivedAt']==new['arrivedAt']
                for s,t in zip(old['samples'],new['samples']):
                    assert {k:v for k,v in s.items() if k not in ('x','y')}=={k:v for k,v in t.items() if k not in ('x','y')}
            diagnostic=peak_diagnostic(r['spec']['field'],exact_fit,fitted,changed['anchorErrorMetres'])
            variant={'alternativeIndex':j,**alternative,**changed,'originalRefit':fitted,'v1':v1,'v2':v2,'peakDiagnostic':diagnostic}
            variants.append(variant)
            summary={'physicalSpec':r['spec'],'alternativeIndex':j,**alternative,
                     'exactV2':compact(exact_v2),'original':compact(fitted),'v1':compact(v1),'v2':compact(v2),
                     'dwellState':v2['dwell']['state'],'crossfitState':v2['crossfit']['state'],'peakDiagnostic':diagnostic}
            all_summaries.append(summary)
            if alternative['model']=='frame-translation':
                gauge_checks.append(compact(v2)==compact(exact_v2) and (diagnostic is None or diagnostic['frameCorrectedPeakDisplacementMetres']<=1e-8))
        content=gzip.compress(json.dumps({'physicalSpec':r['spec'],'variants':variants},sort_keys=True,separators=(',',':')).encode(),mtime=0)
        file=f"variants/physical-{r['spec']['index']:03d}.json.gz"
        with (a.output/file).open('xb') as handle:handle.write(content)
        variant_inventory.append({'physicalIndex':r['spec']['index'],'file':file,'sha256':sha(content),'bytes':len(content)})
    assert len(all_summaries)==2976 and len(variant_inventory)==96
    groups=defaultdict(list)
    for r in all_summaries:
        s=r['physicalSpec'];groups[s['field'],s['phaseSeconds'],s['radiusMetres'],r['model'],r['amplitudeMetres']].append(r)
    strata=[]
    for (field,phase,radius,model,amplitude),rs in sorted(groups.items()):
        assert len(rs)==4
        out=dict(field=field,phaseSeconds=phase,waypointErrorRadiusMetres=radius,model=model,reportingAmplitudeMetres=amplitude,n=4)
        for method in ['exactV2','original','v1','v2']:
            out[method+'Support']=sum(r[method]['status']=='supported' for r in rs)
            out[method+'Reasons']=dict(Counter(r[method]['reason'] for r in rs))
        out.update(losses=sum(r['exactV2']['status']=='supported' and r['v2']['status']!='supported' for r in rs),
                   gains=sum(r['exactV2']['status']!='supported' and r['v2']['status']=='supported' for r in rs),
                   dwellStates=dict(Counter(r['dwellState'] for r in rs)),crossfitStates=dict(Counter(r['crossfitState'] for r in rs)),
                   reasonTransitions=dict(Counter(r['exactV2']['reason']+' -> '+r['v2']['reason'] for r in rs)))
        diagnostics=[r['peakDiagnostic'] for r in rs if r['v2']['status']=='supported' and r['peakDiagnostic'] is not None]
        out['supportedPeakDiagnostics']={'n':len(diagnostics)}
        for quantity in ['worldPeakDisplacementMetres','frameCorrectedPeakDisplacementMetres']:
            values=[d[quantity] for d in diagnostics]
            out['supportedPeakDiagnostics'][quantity]={'median':statistics.median(values),'max':max(values)} if values else None
        strata.append(out)
    exact=[r for r in all_summaries if r['model']=='exact']
    losses=[r for r in all_summaries if r['physicalSpec']['field'] in POSITIVES and r['model'] not in ['exact','frame-translation'] and r['amplitudeMetres'] in [.0001,.001] and r['exactV2']['status']=='supported' and r['v2']['status']!='supported']
    control_support=[r for r in all_summaries if r['physicalSpec']['field'] not in POSITIVES and r['v2']['status']=='supported']
    gates={'freshExactPositiveSupport':all(r['v2']['status']=='supported' for r in exact if r['physicalSpec']['field'] in POSITIVES),
           'noControlSupportAnywhere':not control_support,'coherentFrameInvariance':all(gauge_checks),
           'smallErrorPositiveSupportRetained':not losses}
    result={'schemaVersion':'si-reported-pose-analysis-v1','createdAt':datetime.now(timezone.utc).isoformat(),
            'physicalIntegrityAccepted':True,'physicalInspections':96,'pairedReportingEvaluations':2976,
            'rawManifestSha256':sha(mb),'referenceManifestSha256':sha(rb),'rawInventory':raw_inventory,'variantInventory':variant_inventory,
            'scientificPlanningChecks':gates,'planChangeRequired':not all(gates.values()),
            'independentAuditRequiredBeforeInterpretation':True,'smallErrorSupportLosses':losses,'controlSupports':control_support,
            'strata':strata,'workerExecution':worker_times,'physicalWallSeconds':top['elapsedSeconds'],
            'analysisWallSeconds':time.perf_counter()-start}
    for name,data in [('analysis.json',result),('run-summaries.json',all_summaries)]:
        with (a.output/name).open('x') as handle:handle.write(json.dumps(data,sort_keys=True,indent=2)+'\n')
    lines=['# Stage 1l reported-pose simulation','', '96 fresh physical inspections; 2,976 paired reporting alternatives. Each table row has four paired replicates, not independent repeated trajectories for each alternative.','',
           '| Field | Pulse phase (s) | Waypoint error (mm) | Reporting model | Amplitude (mm) | Exact-pose support | Reported-pose v2 support | Loss / gain | Dwell states |',
           '|---|---:|---:|---|---:|---:|---:|---|---|']
    for s in strata:
        lines.append(f"| {s['field']} | {s['phaseSeconds']} | {s['waypointErrorRadiusMetres']*1000:g} | {s['model']} | {s['reportingAmplitudeMetres']*1000:g} | {s['exactV2Support']}/4 | {s['v2Support']}/4 | {s['losses']} / {s['gains']} | {s['dwellStates']} |")
    lines+=['','## Prespecified planning checks','','```json',json.dumps(gates,indent=2),'```','',f"Plan change required (subject to independent audit): {result['planChangeRequired']}. No rule was retuned."]
    (a.output/'results.md').write_text('\n'.join(lines)+'\n')
    (a.output/'complete.json').write_text(json.dumps({'complete':True,'physicalInspections':96,'pairedReportingEvaluations':2976,
        'analysisSha256':sha((a.output/'analysis.json').read_bytes()),'summarySha256':sha((a.output/'run-summaries.json').read_bytes())},indent=2)+'\n')
    print(json.dumps({k:result[k] for k in ['physicalIntegrityAccepted','physicalInspections','pairedReportingEvaluations','scientificPlanningChecks','planChangeRequired','physicalWallSeconds','analysisWallSeconds']},indent=2))


if __name__=='__main__':main()
