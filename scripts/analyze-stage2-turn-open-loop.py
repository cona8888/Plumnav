#!/usr/bin/env python3
"""Independent response audit on one unchanged, previously audited body path."""
import gzip
import hashlib
import json
from pathlib import Path
import numpy as np
from lib.si_head_motion_audit import filtered_history,EngineRandom


def sha(b):return hashlib.sha256(b).hexdigest()


if __name__=='__main__':
    root=Path('research/evidence/si_turn_fixed_path_diagnosis_2026-09-17');out=Path('research/results/si_turn_fixed_path_diagnosis_2026-09-17');m=json.loads((root/'complete.json').read_text());assert m['complete']
    canonical=Path(m['canonicalRawFile']).read_bytes();assert sha(canonical)==m['canonicalRawSha256'];r=json.loads(gzip.decompress(canonical));reference=np.array(r['trace']);histories=[];checks=[]
    for item in m['histories']:
        body=(root/item['file']).read_bytes();assert sha(body)==item['sha256'];d=json.loads(gzip.decompress(body));assert d['fixedPathRawSha256']==sha(canonical);tr=np.array(d['trace']);dt=d['sensorDt'];stride=round(dt/(r['config']['fixedDt']/4))
        assert np.array_equal(tr[:,:16],reference[::stride,:16]) # Every field input and pose is identical at shared physical clocks.
        filtered=filtered_history(tr[:,0],tr[:,12:16],d['config']['localInletSampling']);error=float(abs(filtered-tr[:,16:20]).max());assert error<=1e-9
        hardware=np.arange(0,len(tr),round(1/dt));rng=EngineRandom(d['spec']['worldSeed']+3000000);noise=np.array([[rng.normal() for _ in range(4)] for _ in hardware])*d['config']['sensorNoise']
        noisy=np.clip(filtered[hardware]+noise,0,d['config']['sensorSaturation']);readout_error=float(abs(noisy-tr[hardware,20:24]).max());assert readout_error<=1e-9
        if dt==1/256:assert np.array_equal(tr,reference)
        checks.append(dict(sensorDt=dt,traceRows=len(tr),sensorHistoryErrorC0=error,readoutErrorC0=readout_error,allSharedPathAndFieldInputsExact=True))
        histories.append(tr[::round((1/64)/dt)])
    pairs=[]
    for a,b in [(0,1),(1,2)]:
        x,y=histories[a],histories[b];assert np.array_equal(x[:,:12],y[:,:12])
        pairs.append(dict(meshPair=[m['histories'][a]['sensorDt'],m['histories'][b]['sensorDt']],filteredC0=abs(x[:,16:20]-y[:,16:20]).max(axis=0).tolist(),readoutC0=abs(x[:,20:24]-y[:,20:24]).max(axis=0).tolist(),scalarC0=float(abs(x[:,20:24].mean(axis=1)-y[:,20:24].mean(axis=1)).max())))
    ratios={k:[b/a if a else None for a,b in zip(pairs[0][k],pairs[1][k])] for k in ['filteredC0','readoutC0']}
    result=dict(postHoc=True,doesNotOverrideAcceptance=True,integrityPassed=True,canonicalRawSha256=sha(canonical),checks=checks,pairs=pairs,contractionRatios=ratios,meaning='Response integration on one fixed saved trajectory, not an autonomous convergence pass or global controller robustness result.')
    out.mkdir();body=(json.dumps(result,indent=2,allow_nan=False)+'\n').encode()
    with (out/'analysis.json').open('xb') as f:f.write(body)
    with (out/'complete.json').open('x') as f:json.dump(dict(complete=True,analysisSha256=sha(body),sourceSha256=sha(Path(__file__).read_bytes())),f,indent=2)
    print(body.decode())
