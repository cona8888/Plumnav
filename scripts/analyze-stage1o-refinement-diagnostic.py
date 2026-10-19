#!/usr/bin/env python3
"""Post-hoc mesh diagnosis only; cannot overturn the frozen Stage 1o failure."""
import copy,gzip,hashlib,importlib.util,json
from pathlib import Path
import numpy as np
from lib.si_head_motion_audit import inspect_history

sp=importlib.util.spec_from_file_location('stage1o_analysis','scripts/analyze-stage1o.py')
base=importlib.util.module_from_spec(sp);sp.loader.exec_module(base)


def sha(b):return hashlib.sha256(b).hexdigest()


def main():
    directory=Path('research/evidence/si_head_motion_refinement_diagnostic_2026-09-16')
    m=json.loads((directory/'manifest.json').read_text());d=json.loads((directory/'complete.json').read_text())
    assert d['complete'] and m['dt']==[.0078125,.00390625]
    assert sha(Path('scripts/lib/si-head-motion.ts').read_bytes())==m['basisSourceSha256']
    assert sha(Path('scripts/stage1o-refinement-diagnostic.ts').read_bytes())==m['scriptSha256']
    assert sha((directory/'runner.mjs').read_bytes())==m['bundleSha256']
    raw=Path('research/evidence/si_head_motion_pilot_2026-09-16');original_manifest=json.loads((raw/'manifest.json').read_text())
    assert sha((raw/'manifest.json').read_bytes())==m['originalManifestSha256']
    original_analysis=json.loads(Path('research/results/si_head_motion_pilot_2026-09-16/analysis.json').read_text())
    assert original_analysis['passed'] is False
    item=next(x for x in original_analysis['rawInventory'] if x['index']==68)
    content=(raw/item['file']).read_bytes();assert sha(content)==item['sha256']==m['originalRawSha256']
    record=json.loads(gzip.decompress(content));c=original_manifest['configs'][68];coarse=np.array(record['trace'])
    retained=[s['time'] for v in record['headVisits'] for s in v['samples']]
    datasets=[(.0625,record['trace'])]+[(f['dt'],f['trace']) for f in record['refinements']]
    audits=[];fine_decisions=[];noises=base.noise_at_retained(record,c)
    for item in d['inventory']:
        content=(directory/item['file']).read_bytes();assert sha(content)==item['sha256'] and len(content)==item['bytes']
        f=json.loads(gzip.decompress(content));dt=f['dt'];assert dt==item['dt'];tr=np.array(f['trace'])
        k=np.minimum(np.floor(tr[:,0]/.0625).astype(int),len(coarse)-1);end=np.minimum(k+1,len(coarse)-1);fraction=(tr[:,0]-coarse[k,0])/.0625
        assert np.max(abs(tr[:,2:4]-coarse[k,2:4]-fraction[:,None]*(coarse[end,2:4]-coarse[k,2:4])))<1e-12
        assert np.array_equal(tr[:,1],coarse[k,1])
        angular=np.arctan2(np.sin(coarse[end,4]-coarse[k,4]),np.cos(coarse[end,4]-coarse[k,4]))
        assert np.max(abs(tr[:,4]-coarse[k,4]-fraction*angular))<1e-12
        audits.append({'dt':dt,**inspect_history(record,c,f['trace'],dt,noisy=False)})
        visits=copy.deepcopy(record['headVisits'])
        for visit in visits:
            for sample in visit['samples']:
                channels=np.clip(tr[round(sample['time']/dt),20:24]+noises[sample['time']],0,c['sensorSaturation'])
                sample['value']=float(channels.mean());sample['clipped']=bool(np.any(channels>=c['sensorSaturation']-1e-9));sample['hit']=sample['value']>=.115
        fine_decisions.append({'dt':dt,'variants':base.variants(visits,record['spec'])})
        datasets.append((dt,f['trace']))
    sampled=[np.array(tr)[[round(t/dt) for t in retained],20:24] for dt,tr in datasets]
    comparisons=[]
    for i in range(1,len(sampled)):
        change=sampled[i]-sampled[i-1];scalar=change.mean(axis=1);j=int(np.argmax(abs(scalar)))
        comparisons.append({'coarseDt':datasets[i-1][0],'fineDt':datasets[i][0],'maxScalarChangeC0':float(max(abs(scalar))),
                            'rmsScalarChangeC0':float(np.sqrt(np.mean(scalar**2))), 'maxChannelChangeC0':float(np.max(abs(change))),
                            'timeAtMaxScalarChange':retained[j],'visitAtMaxScalarChange':j//5,'channelChangesAtScalarMaximum':change[j].tolist()})
    out={'evidenceClass':'post-hoc numerical diagnosis, not a fresh confirmation or replacement gate','integrityAccepted':True,
         'originalStage1oGateStillFailed':True,'originalPhysicalIndex':68,'comparisons':comparisons,'audits':audits,
         'fineDecisions':fine_decisions,'manifestSha256':sha((directory/'manifest.json').read_bytes()),
         'scriptSha256':sha(Path(__file__).read_bytes()),'physicalDiagnosticSeconds':d['elapsedSeconds']}
    dest=Path('research/results/si_head_motion_refinement_diagnostic_2026-09-16');dest.mkdir(exist_ok=False)
    with (dest/'analysis.json').open('x') as f:f.write(json.dumps(out,sort_keys=True,indent=2)+'\n')
    print(json.dumps({k:v for k,v in out.items() if k!='fineDecisions'},indent=2))


if __name__=='__main__':main()
