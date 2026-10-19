#!/usr/bin/env python3
"""Audit/replay Stage 1j without changing any recorded Stage 1i decision."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import shutil
from lib.si_pose_temporal import evaluate

module_spec = importlib.util.spec_from_file_location('original_audit', Path(__file__).with_name('audit-stage1i-decisions.py'))
original_audit = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(original_audit)
FIELDS = ['peak','offset-peak','ridge','saddle','plateau','uniform','blank','clipped-peak','si-continuous','si-narrow','si-pulse']
POSITIVES = ['peak','offset-peak','si-continuous']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def expected_cases():
    cases = [dict(index=i,field=f,radiusMetres=0,geometry='independent',seed=810101,kind='baseline') for i,f in enumerate(FIELDS)]
    for seed in range(810101,810105):
        for radius in [.03,.05]:
            for geometry in ['independent','common-centre-target']:
                for f in FIELDS:
                    cases.append(dict(index=len(cases),field=f,radiusMetres=radius,geometry=geometry,seed=seed,kind='position'))
    return cases


def original_check(record):
    old = record['result']
    new = original_audit.recompute(record['visits'])
    if new['reason'] != old['reason'] or new['gates'] != old['gates']:
        raise ValueError(f"Original decision mismatch {record['spec']}")
    if max(abs(float(x)-y) for x,y in zip(new['coefficients'],old['coefficients'])) > 1e-9:
        raise ValueError('Original fit mismatch')


def fresh_check(record, expected, manifest):
    spec=record['spec']
    assert spec == expected[spec['index']]
    assert record['configSha256'] == manifest['configHashes'][spec['field']]
    config = manifest['configs'][spec['field']]
    assert config['domainMeters'] == 100 and config['fixedDt'] == .0625
    assert config['durationSeconds'] == 330
    assert len(record['visits']) == len(record['actualSamples']) == 17
    assert not record['summary']['nativeDeclaration'] and not record['summary']['nativeAbstention']
    assert record['summary']['completedAt'] <= 330
    for i,(visit,actual) in enumerate(zip(record['visits'],record['actualSamples'])):
        assert visit['closedAt'] is not None and len(visit['samples']) == len(actual) == 5
        offset=record['positionOffsetsMetres'][i]
        assert math.hypot(offset['x'],offset['y']) <= spec['radiusMetres']+1e-12
        for k in ('x','y'):
            assert abs(record['actualTargets'][i][k]-record['nominalTargets'][i][k]-offset[k]/100) < 1e-12
        assert visit['target'] == record['actualTargets'][i]
        for sample,physical in zip(visit['samples'],actual):
            assert sample['time'] == physical['time'] and sample['value'] == physical['measurementConcentration']
            assert math.dist(list(physical['position'].values()),list(visit['target'].values()))*100 <= .001+1e-9
            for k in ('x','y'):
                assert abs(sample[k]-(physical['position'][k]-record['nominalTargets'][0][k])/.001) < 1e-8
    if spec['geometry'] == 'common-centre-target':
        assert all(record['positionOffsetsMetres'][i] == record['positionOffsetsMetres'][0] for i in range(0,17,2))


def main():
    if not __debug__:
        raise RuntimeError('Do not disable audit assertions')
    p=argparse.ArgumentParser()
    p.add_argument('--mode',choices=['development','fresh'],required=True)
    p.add_argument('--input',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    a.output.mkdir(parents=True,exist_ok=False)
    sources=['scripts/lib/si_pose_temporal.py','scripts/analyze-stage1j.py','scripts/audit-stage1i-decisions.py','scripts/test-stage1j-temporal.py','research/protocols/si_pose_aware_temporal_pilot_2026-09-16.md']
    (a.output/'source-snapshot').mkdir()
    hashes={}
    for f in sources:
        hashes[f]=sha(Path(f).read_bytes())
        shutil.copyfile(f,a.output/'source-snapshot'/Path(f).name)
    (a.output/'analysis-freeze.json').write_text(json.dumps({'createdAt':datetime.now(timezone.utc).isoformat(),'mode':a.mode,'sources':hashes},indent=2)+'\n')
    expected=expected_cases()
    manifest=None
    if a.mode=='fresh':
        manifest=json.loads((a.input/'manifest.json').read_text())
        top=json.loads((a.input/'complete.json').read_text())
        assert top['complete'] and not top['failures'] and manifest['cases']==expected
        assert top['manifestSha256']==sha((a.input/'manifest.json').read_bytes())
        for source in manifest['sources']:
            assert sha((a.input/'source-snapshot'/source['name']).read_bytes()) == source['sha256']
            if source['file'] in hashes:
                assert hashes[source['file']]==source['sha256'], 'Frozen evaluator/protocol changed'
    records, inventory, physical_pairs, seen = [], [], defaultdict(dict), set()
    for worker in sorted(a.input.glob('worker-*')):
        complete=json.loads((worker/'complete.json').read_text())
        assert complete['complete']
        for item in complete['inventory']:
            raw=(worker/item['file']).read_bytes()
            assert sha(raw)==item['sha256'] and len(raw)==item['bytes']
            inventory.append({'file':str((worker/item['file']).relative_to(a.input)),'sha256':sha(raw)})
            block=json.loads(gzip.decompress(raw))
            for record in block['records'] if a.mode=='development' else [block]:
                if a.mode=='development':
                    s=record['spec'];u=s['uncertainty']
                    if not(s['kind']=='position' and u['registration']=='observed' and u['positionErrorStructure']=='independent' and u['positionRadiusMetres'] in [.03,.05]):
                        continue
                    spec={'index':s['index'],'field':s['field'],'radiusMetres':u['positionRadiusMetres'],'geometry':'independent','seed':u['perturbationSeed'],'kind':'position'}
                else:
                    spec=record['spec']
                    fresh_check(record,expected,manifest)
                    if spec['kind']=='position':
                        key=(spec['field'],spec['radiusMetres'],spec['seed'])
                        physical_pairs[key][spec['geometry']]=record['positionOffsetsMetres']
                assert spec['index'] not in seen
                seen.add(spec['index'])
                original_check(record)
                candidate=evaluate(record['visits'],record['result'])
                records.append({'spec':spec,'original':{'status':record['result']['status'],'reason':record['result']['reason'],'temporalState':'pass' if record['result']['gates']['stable'] else 'reject'},'candidate':candidate,'summary':record['summary']})
    assert len(records)==(1100 if a.mode=='development' else 187)
    if a.mode=='fresh':
        assert seen==set(range(187)) and len(physical_pairs)==88
        for pair in physical_pairs.values():
            independent,common=pair['independent'],pair['common-centre-target']
            assert all(common[i]==independent[i] for i in [0,*range(1,17,2)])
    groups=defaultdict(list)
    for r in records:
        s=r['spec'];groups[s['field'],s['radiusMetres'],s['geometry'],s['kind']].append(r)
    strata=[]
    for (field,radius,geometry,kind),rs in sorted(groups.items()):
        n=len(rs)
        assert n==(50 if a.mode=='development' else 1 if kind=='baseline' else 4)
        strata.append({'field':field,'radiusMetres':radius,'radiusOverReferenceWidth':radius/.15,'geometry':geometry,'kind':kind,'n':n,
            'originalSupport':sum(r['original']['status']=='supported' for r in rs),
            'candidateSupport':sum(r['candidate']['status']=='supported' for r in rs),
            'gains':sum(r['candidate']['status']=='supported' and r['original']['status']!='supported' for r in rs),
            'losses':sum(r['candidate']['status']!='supported' and r['original']['status']=='supported' for r in rs),
            'originalReasons':dict(Counter(r['original']['reason'] for r in rs)),
            'candidateReasons':dict(Counter(r['candidate']['reason'] for r in rs)),
            'candidateTemporalStates':dict(Counter(r['candidate']['temporal']['state'] for r in rs)),
            'originalTemporalStates':dict(Counter(r['original']['temporalState'] for r in rs))})
    gate=None
    if a.mode=='fresh':
        gate={'baselineDecisionsRetained':all(r['original']['reason']==r['candidate']['reason'] and ((r['candidate']['status']=='supported')==(r['spec']['field'] in POSITIVES)) for r in records if r['spec']['kind']=='baseline'),
              'noControlSupport':all(s['candidateSupport']==0 for s in strata if s['field'] not in POSITIVES),
              'noPositiveSupportLosses':all(s['losses']==0 for s in strata if s['field'] in POSITIVES),
              'independentPositiveGain':any(s['gains']>0 for s in strata if s['field'] in POSITIVES and s['geometry']=='independent')}
        gate['passed']=all(gate.values())
    result={'schemaVersion':'si-pose-aware-temporal-analysis-v1','mode':a.mode,'integrityAccepted':True,'records':len(records),'sources':hashes,'sourceInventory':inventory,'localProgressionGate':gate,'strata':strata}
    (a.output/'analysis.json').write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
    (a.output/'run-evaluations.json').write_text(json.dumps(records,sort_keys=True,separators=(',',':'))+'\n')
    lines=[f"# Stage 1j {a.mode} results",'',f"Audited records: {len(records)}. Same observations evaluated by both rules. Original saved decisions reproduced independently.",'',
           'Development replay is not fresh validation. Fresh nonzero strata have four seeds; counts are not precise population estimates. Common-centre targets change physical trajectory and timing. No AWS compute was used.','',
           '| Field | Radius (mm) | Geometry | n | Original support | Candidate support | Gains / losses | Candidate temporal pass / reject / indeterminate |',
           '|---|---:|---|---:|---:|---:|---|---|']
    for s in strata:
        t=s['candidateTemporalStates']
        lines.append(f"| {s['field']} | {s['radiusMetres']*1000:g} | {s['geometry']} | {s['n']} | {s['originalSupport']} | {s['candidateSupport']} | {s['gains']} / {s['losses']} | {t.get('pass',0)} / {t.get('reject',0)} / {t.get('indeterminate',0)} |")
    if gate:
        lines+=['','## Prespecified local progression gate','', '```json',json.dumps(gate,indent=2),'```']
    (a.output/'results.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps({'mode':a.mode,'records':len(records),'integrityAccepted':True,'localProgressionGate':gate,'output':str(a.output)},indent=2))


if __name__=='__main__':
    main()
