#!/usr/bin/env python3
"""Frozen, stratum-specific analysis for the stationary-dwell research pilot."""
import argparse
from collections import Counter, defaultdict
import copy
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import statistics
import subprocess
from lib.si_pose_temporal import evaluate as evaluate_v1
from lib.si_stationary_dwell import evaluate as evaluate_v2

FIELDS = ['peak','offset-peak','ridge','saddle','plateau','uniform','blank','clipped-peak','si-continuous','si-narrow','si-pulse']
POSITIVES = ['peak','offset-peak','si-continuous']
REFERENCE = Path('research/evidence/si_pose_aware_temporal_pilot_2026-09-16')
module_spec = importlib.util.spec_from_file_location('original_audit', Path(__file__).with_name('audit-stage1i-decisions.py'))
original_audit = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(original_audit)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def expected_cases():
    cases=[]
    def add(field,phase,radius,response,noise,rep,panel):
        cases.append(dict(index=len(cases),field=field,phaseSeconds=phase,radiusMetres=radius,
                          response=response,noiseC0=noise,replicate=rep,seed=920101+rep,worldSeed=98101+rep,panel=panel))
    for field in FIELDS:
        for phase in [0,5,10,15] if field=='si-pulse' else [0]:
            for radius in [0,.05]:
                for response in ['nominal','slow']:
                    for noise in [0,.001]:
                        for rep in [0] if radius==0 and noise==0 else range(4):
                            add(field,phase,radius,response,noise,rep,'core')
    for field in ['peak','offset-peak','si-continuous','si-pulse','uniform','blank']:
        for rep in range(4):
            add(field,0,.05,'nominal',.02,rep,'noise-stress')
    assert len(cases)==388
    return cases


def same_config(a,b):
    if isinstance(a,dict):
        return isinstance(b,dict) and a.keys()==b.keys() and all(same_config(a[k],b[k]) for k in a)
    if isinstance(a,list):
        return isinstance(b,list) and len(a)==len(b) and all(same_config(x,y) for x,y in zip(a,b))
    if isinstance(a,(int,float)) and not isinstance(a,bool):
        return isinstance(b,(int,float)) and math.isclose(a,b,rel_tol=1e-12,abs_tol=1e-14)
    return a==b


def expected_config(reference,s):
    c=copy.deepcopy(reference[s['field']]);p=c['localInletSampling'];at=c['physicalAtmosphere']
    c.update(seed=s['worldSeed'],durationSeconds=900,checkpointSeconds=[900],sensorNoise=s['noiseC0'])
    at['measurement']['noiseKgPerCubicMetre']=s['noiseC0']*at['measurement']['concentrationScaleKgPerCubicMetre']
    if 'pulse' in at:
        at['pulse']['phaseSeconds']=s['phaseSeconds']
    factor=4 if s['response']=='slow' else 1
    p['riseTimeConstantSeconds']*=factor;p['recoveryTimeConstantSeconds']*=factor
    c['sensorLag']=p['riseTimeConstantSeconds']
    delay=(math.pi*(p['tubeInnerDiameterMetres']/2)**2*p['tubeLengthMetres'])/(p['flowLitresPerMinutePerChannel']/1000/60)
    q=p['inspection']
    q['settlingSeconds']=delay-math.log(.05)*max(p['riseTimeConstantSeconds'],p['recoveryTimeConstantSeconds'])+p['averagingSeconds']
    q['dwellSeconds']=math.ceil(q['settlingSeconds'])+4
    q['maximumPairSeparationSeconds']=2*q['dwellSeconds']+2*q['offsetNormalized']/c['robotSpeed']
    c['activeSniffCycleSeconds']=q['dwellSeconds']
    return c


def inspect_record(r,s,c):
    assert r['spec']==s and r['schemaVersion']=='si-stationary-dwell-run-v1'
    summary=r['summary']
    assert summary['stopReason']=='inspection-complete' and summary['retainedSamples']==85
    assert 0<summary['completedAt']<=900 and 0<=summary['pathLengthMeters']<100
    assert not summary['nativeDeclaration'] and not summary['nativeAbstention']
    assert len(r['visits'])==len(r['actualSamples'])==len(r['actualTargets'])==len(r['nominalTargets'])==17
    p=c['localInletSampling'];q=p['inspection'];h=q['offsetNormalized'];domain=c['domainMeters']
    previous_close=-1
    for i,(v,actual) in enumerate(zip(r['visits'],r['actualSamples'])):
        assert v['arrivedAt']>previous_close and v['closedAt']-v['arrivedAt']==q['dwellSeconds']
        previous_close=v['closedAt']
        assert len(v['samples'])==len(actual)==5
        assert v['samples'][0]['time']==v['arrivedAt']+math.ceil(q['settlingSeconds'])
        assert v['samples'][-1]['time']==v['closedAt']
        offset=r['positionOffsetsMetres'][i]
        assert math.hypot(offset['x'],offset['y'])<=s['radiusMetres']+1e-12
        assert r['headingOffsetsRadians'][i]==0
        for k in ('x','y'):
            assert abs(r['actualTargets'][i][k]-r['nominalTargets'][i][k]-offset[k]/domain)<1e-12
        assert v['target']==r['actualTargets'][i]
        for j,(sample,physical) in enumerate(zip(v['samples'],actual)):
            assert all(math.isfinite(sample[k]) for k in ('time','value','x','y'))
            assert sample['time']==physical['time']==v['samples'][0]['time']+j
            assert sample['value']==physical['measurementConcentration']
            assert math.hypot(*(physical['position'][k]-v['target'][k] for k in ('x','y')))*domain<=.001+1e-9
            for k in ('x','y'):
                assert abs(sample[k]-(physical['position'][k]-r['nominalTargets'][0][k])/h)<1e-8
            channels=physical['localInletReadings']
            assert len(channels)==4 and {ch['channel'] for ch in channels}=={'front','aft','left','right'}
            assert all(math.isfinite(ch['concentration']) and 0<=ch['concentration']<=c['sensorSaturation'] for ch in channels)
            assert abs(sum(ch['concentration'] for ch in channels)/4-sample['value'])<1e-12
            assert sample['telemetryComplete'] and sample['clipped']==any(ch['saturated'] for ch in channels)
            assert c['sensorFalsePositiveRate']==c['sensorFalseNegativeRate']==0
            threshold=(c['sensorDetectionFloor'] if c['sensorDetectionFloor']>0 else {'open':.115,'obstructed':.105}[c['scenarioKind']])*c['sensorThresholdScale']
            assert sample['hit']==(sample['value']>=threshold)
    assert previous_close==summary['completedAt']
    original=original_audit.recompute(r['visits']);old=r['result']
    assert original['reason']==old['reason'] and original['gates']==old['gates']
    assert (old['status']=='supported')==(old['reason']=='local-quadratic-supported')
    assert max(abs(float(x)-y) for x,y in zip(original['coefficients'],old['coefficients']))<1e-9
    assert abs(original['rmse']-old['rmse'])<1e-9 and abs(original['eigenMax']-old['eigenMax'])<1e-9


def main():
    if not __debug__:
        raise RuntimeError('Do not disable audit assertions')
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--node',required=True);a=p.parse_args()
    manifest_bytes=(a.input/'manifest.json').read_bytes();manifest=json.loads(manifest_bytes)
    top=json.loads((a.input/'complete.json').read_text());expected=expected_cases()
    assert top['complete'] and not top['failures'] and top['manifestSha256']==sha(manifest_bytes)
    assert manifest['cases']==expected and manifest['caseCount']==top['caseCount']==388 and manifest['workerCount']==4
    assert len(manifest['configs'])==len(manifest['configHashes'])==388
    # Recreate the producer's exact JSON serialization rather than approximate its hashes in Python.
    js="""import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const m=JSON.parse(readFileSync(process.argv[1],'utf8'));
const c=v=>Array.isArray(v)?v.map(c):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,c(v)])):v;
m.configs.forEach((v,i)=>{if(createHash('sha256').update(JSON.stringify(c(v),null,2)+'\\n').digest('hex')!==m.configHashes[i])throw Error('Config checksum '+i)});"""
    subprocess.run([a.node,'--input-type=module','-e',js,str(a.input/'manifest.json')],check=True)
    amendments=[]
    for source in manifest['sources']:
        assert sha((a.input/'source-snapshot'/source['name']).read_bytes())==source['sha256']
        current=sha(Path(source['file']).read_bytes())
        if current!=source['sha256']:
            amendment=json.loads((a.input/'analysis-amendment.json').read_text())
            assert source['file']=='scripts/analyze-stage1k.py' and amendment['file']==source['file']
            assert amendment['originalSha256']==source['sha256'] and amendment['correctedSha256']==current
            amendments.append(amendment)
    reference_bytes=(REFERENCE/'manifest.json').read_bytes();reference=json.loads(reference_bytes)
    assert json.loads((REFERENCE/'complete.json').read_text())['manifestSha256']==sha(reference_bytes)
    for s,c in zip(expected,manifest['configs']):
        assert same_config(expected_config(reference['configs'],s),c), f"Configuration deviation {s}"
    records=[];seen=set();inventory=[];workers=[]
    assert len(list(a.input.glob('worker-*')))==4
    for worker in sorted(a.input.glob('worker-*')):
        marker=json.loads((worker/'complete.json').read_text());w=marker['worker'];workers.append(marker)
        assert marker['complete'] and worker.name==f'worker-{w}' and len(marker['inventory'])==97
        assert len(list(worker.glob('run-*.json.gz')))==97
        for item in marker['inventory']:
            i=item['index'];assert i not in seen and i%4==w;seen.add(i)
            raw=(worker/item['file']).read_bytes();assert sha(raw)==item['sha256'] and len(raw)==item['bytes']
            r=json.loads(gzip.decompress(raw));s=expected[i];c=manifest['configs'][i]
            assert r['configSha256']==manifest['configHashes'][i]
            inspect_record(r,s,c)
            v1=evaluate_v1(r['visits'],r['result']);v2=evaluate_v2(r['visits'],r['result'])
            assert v1['temporal']==v2['crossfit']
            inventory.append({'index':i,'file':str((worker/item['file']).relative_to(a.input)),'sha256':sha(raw)})
            records.append({'spec':s,'original':r['result'],'v1':v1,'v2':v2,'summary':r['summary'],
                            'clippedSamples':sum(x['clipped'] for v in r['visits'] for x in v['samples'])})
    assert seen==set(range(388)) and {w['worker'] for w in workers}==set(range(4))
    records.sort(key=lambda r:r['spec']['index']);groups=defaultdict(list)
    for r in records:
        s=r['spec'];groups[tuple(s[k] for k in ['field','phaseSeconds','radiusMetres','response','noiseC0','panel'])].append(r)
    strata=[]
    for key,rs in sorted(groups.items()):
        field,phase,radius,response,noise,panel=key;n=len(rs)
        assert n==(1 if radius==0 and noise==0 else 4)
        stratum=dict(field=field,phaseSeconds=phase,radiusMetres=radius,response=response,noiseC0=noise,panel=panel,n=n)
        for method in ['original','v1','v2']:
            stratum[method+'Support']=sum(r[method]['status']=='supported' for r in rs)
            stratum[method+'Reasons']=dict(Counter(r[method]['reason'] for r in rs))
        stratum.update(gains=sum(r['v2']['status']=='supported' and r['original']['status']!='supported' for r in rs),
                       losses=sum(r['v2']['status']!='supported' and r['original']['status']=='supported' for r in rs),
                       dwellStates=dict(Counter(r['v2']['dwell']['state'] for r in rs)),
                       crossfitStates=dict(Counter(r['v2']['crossfit']['state'] for r in rs)),
                       reasonTransitions=dict(Counter(r['original']['reason']+' -> '+r['v2']['reason'] for r in rs)),
                       clippedMissions=sum(r['clippedSamples']>0 for r in rs))
        for name in ['completedAt','pathLengthMeters']:
            v=[r['summary'][name] for r in rs];stratum[name]={'min':min(v),'median':statistics.median(v),'max':max(v)}
        strata.append(stratum)
    nominal=[r for r in records if r['spec']['response']=='nominal' and r['spec']['noiseC0']==0]
    baseline=[r for r in nominal if r['spec']['radiusMetres']==0]
    assert len(baseline)==14
    gate={
        'referenceStatusAndReasonsRetained':all(r['original']['status']==r['v2']['status'] and r['original']['reason']==r['v2']['reason'] for r in baseline),
        'positiveReferencesSupported':all(r['v2']['status']=='supported' for r in baseline if r['spec']['field'] in POSITIVES),
        'noControlSupportAnywhere':all(r['v2']['status']!='supported' for r in records if r['spec']['field'] not in POSITIVES),
        'noNominalCleanPositiveSupportLoss':all(not(r['original']['status']=='supported' and r['v2']['status']!='supported') for r in nominal if r['spec']['field'] in POSITIVES),
        'displacedNominalCleanPositiveGain':any(r['original']['status']!='supported' and r['v2']['status']=='supported' for r in nominal if r['spec']['field'] in POSITIVES and r['spec']['radiusMetres']>0),
        'allNominalCleanPulsePhasesDwellReject':all(r['v2']['status']=='abstained' and r['v2']['dwell']['state']=='reject' for r in nominal if r['spec']['field']=='si-pulse')}
    gate['passed']=all(gate.values())
    result={'schemaVersion':'si-stationary-dwell-analysis-v1','integrityAccepted':True,'records':len(records),
            'rawManifestSha256':sha(manifest_bytes),'referenceManifestSha256':sha(reference_bytes),
            'localScientificGate':gate,'independentAuditRequiredBeforeProgression':True,
            'sourceInventory':inventory,'analysisAmendments':amendments,'strata':strata,
            'workerExecution':[{k:w[k] for k in ['worker','pid','startedAt','finishedAt','elapsedSeconds','maxRssBytes']} for w in workers],
            'localElapsedSeconds':top['elapsedSeconds']}
    a.output.mkdir(parents=True,exist_ok=False)
    for name,data in [('analysis.json',result),('run-evaluations.json',records)]:
        (a.output/name).write_text(json.dumps(data,sort_keys=True,indent=2)+'\n')
    lines=['# Stage 1k stationary-dwell pilot','',f'Audited full inspections: {len(records)}; 85 retained scalar readings and 340 channel readings per inspection.',
           '', 'This is a supplied-candidate local-maximum verifier, not an end-to-end GSL benchmark. Four-seed counts are descriptive. Dwell rejection means non-steady measurement, not an identified physical cause.','',
           '| Field | Phase (s) | Error (mm) | Response | Channel noise / C0 | n | Original / v1 / v2 support | Gain / loss | Dwell pass / reject / indeterminate |',
           '|---|---:|---:|---|---:|---:|---|---|---|']
    for s in strata:
        d=s['dwellStates']
        lines.append(f"| {s['field']} | {s['phaseSeconds']} | {1000*s['radiusMetres']:g} | {s['response']} | {s['noiseC0']:g} | {s['n']} | {s['originalSupport']} / {s['v1Support']} / {s['v2Support']} | {s['gains']} / {s['losses']} | {d.get('pass',0)} / {d.get('reject',0)} / {d.get('indeterminate',0)} |")
    lines+=['','## Frozen scientific progression gate','','```json',json.dumps(gate,indent=2),'```','',
            'A passing scientific gate is conditional on an independent audit and regression tests. It does not authorize deployment or establish overall algorithm superiority.']
    (a.output/'results.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps({k:result[k] for k in ['records','integrityAccepted','localScientificGate','localElapsedSeconds']},indent=2))


if __name__=='__main__':
    main()
