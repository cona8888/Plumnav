#!/usr/bin/env python3
import gzip
import hashlib
import json
import math
from pathlib import Path
import numpy as np
from lib.si_linear_response_audit import filtered_history as linear_history
from lib.si_head_motion_audit import filtered_history as held_history,EngineRandom


def sha(b):return hashlib.sha256(b).hexdigest()


if __name__=='__main__':
    root=Path('research/evidence/si_linear_fixed_2026-09-17');out=Path('research/results/si_linear_fixed_2026-09-17');mb=(root/'manifest.json').read_bytes();m=json.loads(mb);done=json.loads((root/'complete.json').read_text());assert done['complete'] and done['manifestSha256']==sha(mb)
    for s in m['sources']:
        assert sha(Path(s['file']).read_bytes())==s['sha256'],s['file'];assert sha((root/'source-snapshot'/s['name']).read_bytes())==s['sha256']
    raw=Path(m['canonicalRawFile']).read_bytes();assert sha(raw)==m['canonicalRawSha256'];canonical=json.loads(gzip.decompress(raw));ctr=np.array(canonical['trace']);records={};checks=[]
    for item in done['histories']:
        b=(root/item['file']).read_bytes();assert sha(b)==item['sha256'];r=json.loads(gzip.decompress(b));dt=r['dt'];times=np.array(r['times']);u=np.array(r['inputs']);f=np.array(r['filtered']);v=np.array(r['readouts']);c=r['config']
        assert np.array_equal(times,np.arange(len(times))*dt)
        expected=(linear_history if r['model']=='linear' else held_history)(times,u,c['localInletSampling']);error=float(abs(f-expected).max());assert error<=1e-9
        hardware=np.arange(0,len(times),round(1/dt));rng=EngineRandom(r['noiseSeed']);noise=np.array([[rng.normal() for _ in range(4)] for _ in hardware])*c['sensorNoise'];noisy=np.clip(expected[hardware]+noise,0,c['sensorSaturation']);readout_error=float(abs(noisy[times.astype(int)]-v).max());assert readout_error<=1e-9
        if r['kind']=='canonical':
            tr=np.array(r['trace']);stride=round(dt/(1/256));assert np.array_equal(tr[:,:16],ctr[::stride,:16])
        elif r['kind']=='smooth':assert np.max(abs(u-(.6+.2*np.sin(.7*times[:,None]+np.arange(4)*np.pi/2))))<1e-14
        else:
            tr=np.array(r['trace']);points=tr[:,4:12].reshape(-1,4,2);field=.6+.18*np.sin(20*(points[:,:,0]-.5))+.12*np.cos(20*(points[:,:,1]-.5));assert np.max(abs(u-field))<1e-14
        stride=round((1/64)/dt);records[(r['kind'],r['model'],dt)]=dict(filtered=f[::stride],readouts=v[::stride],inputs=u[::stride],bearings=r['bearings'])
        checks.append(dict(file=item['file'],filterErrorC0=error,readoutErrorC0=readout_error));print('audited',item['file'],flush=True)
    # Historical held-input canonical traces are retained, independently audited prior evidence.
    old=Path('research/evidence/si_turn_fixed_path_diagnosis_2026-09-17');om=json.loads((old/'complete.json').read_text());assert om['complete'] and om['canonicalRawSha256']==m['canonicalRawSha256']
    for i in om['histories']:
        b=(old/i['file']).read_bytes();assert sha(b)==i['sha256'];r=json.loads(gzip.decompress(b));dt=r['sensorDt'];tr=np.array(r['trace'])[::round((1/64)/dt)];records[('canonical','held',dt)]=dict(filtered=tr[:,16:20],readouts=tr[:,20:24],inputs=tr[:,12:16],bearings=None)
    results=[]
    for kind in ['canonical','smooth','turn-stop']:
        for model in ['held','linear']:
            triple=[records[(kind,model,dt)] for dt in m['meshes']];pairs=[]
            for a,b in [(0,1),(1,2)]:
                assert np.array_equal(triple[a]['inputs'],triple[b]['inputs'])
                pairs.append({k:abs(triple[a][k]-triple[b][k]).max(axis=0).tolist() for k in ['filtered','readouts']})
            gates={}
            if model=='linear':
                for name in ['filtered','readouts']:
                    for channel in range(4):
                        coarse=pairs[0][name][channel];fine=pairs[1][name][channel];gates[f'{name}:{channel}:absolute']=fine<=1e-5;gates[f'{name}:{channel}:contraction']=fine<=1e-8 or fine<=.8*coarse
                        if kind=='smooth':gates[f'{name}:{channel}:smoothOrder']=fine<=1e-9 or fine<=.35*coarse
            bearing=None
            if model=='linear' and kind=='canonical':
                lists=[t['bearings'] for t in triple];assert [r['time'] for r in lists[0]]==[r['time'] for r in lists[1]]==[r['time'] for r in lists[2]]
                gates['cueValidityStable']=all(len({l[i]['usable'] for l in lists})==1 for i in range(len(lists[0])))
                errors=[]
                for a,b in zip(lists[1],lists[2]):
                    if a['usable'] and b['usable']:
                        x=a['gradient']['direction'];y=b['gradient']['direction'];errors.append(abs(math.atan2(x['x']*y['y']-x['y']*y['x'],x['x']*y['x']+x['y']*y['y'])))
                bearing=max(errors,default=0.);gates['bearingDifference']=bearing<=.002
            results.append(dict(kind=kind,model=model,pairs=pairs,gates=gates,passed=all(gates.values()) if gates else None,maximumUsableBearingDifferenceRadians=bearing))
    result=dict(integrityPassed=True,numericalPassed=all(r['passed'] for r in results if r['model']=='linear'),manifestSha256=sha(mb),checks=checks,comparisons=results,performance=None)
    out.mkdir();b=(json.dumps(result,indent=2,allow_nan=False)+'\n').encode()
    with (out/'analysis.json').open('xb') as f:f.write(b)
    with (out/'complete.json').open('x') as f:json.dump(dict(complete=True,integrityPassed=True,numericalPassed=result['numericalPassed'],analysisSha256=sha(b)),f,indent=2)
    print(json.dumps(result,indent=2),flush=True)
