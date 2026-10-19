"""Bounded synthetic Python and TypeScript registry transport admission."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);p.add_argument('--node',required=True);a=p.parse_args()
    assert (datetime(2026,9,25,1,41,27,tzinfo=timezone.utc)-datetime.now(timezone.utc)).total_seconds()>=300
    a.output.mkdir(parents=True,exist_ok=False);start=time.monotonic();commands=[]
    paths=['scripts/run-si-registry-synthetic-v1.py','scripts/lib/si_exact_registry_v1.py','scripts/si-registry-exact-bridge-v1.py','scripts/lib/si-registry-exact-bridge-v1.ts','scripts/test-si-registry-exact-v1.py','scripts/test-si-registry-client-v1.ts','scripts/si-readout-exact-bridge.py','scripts/lib/si_stationary_head_contract.py','scripts/lib/si_bounded_pose_v4.py','scripts/lib/si_bounded_pose.py','research/protocols/si_registry_exact_synthetic_v1_2026-09-24.md']
    def write(name,data):
        with (a.output/name).open('x') as f:json.dump(data,f,indent=2);f.write('\n')
    manifest=dict(createdAt=datetime.now(timezone.utc).isoformat(),sources=[dict(path=name,sha256=sha(name)) for name in paths],syntheticOnly=True,newMissions=0)
    write('execution_manifest.json',manifest)
    env={**os.environ,'PYTHON':sys.executable,'PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','MKL_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'};env.pop('PYTHONPATH',None)
    bundle=a.output/'registry-client-test.mjs'
    tasks=[('build',[a.node,'node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild','scripts/test-si-registry-client-v1.ts','--bundle','--platform=node','--format=esm','--outfile='+str(bundle),'--metafile='+str(a.output/'bundle.meta.json')]),
           ('python',[sys.executable,'scripts/test-si-registry-exact-v1.py','--output',str(a.output/'generated')]),
           ('typescript',[a.node,str(bundle),'--input',str(a.output/'generated/fixtures.json'),'--output',str(a.output/'typescript_receipt.json')])]
    try:
        for name,command in tasks:
            begin=time.monotonic()
            with (a.output/(name+'.log')).open('x') as log:
                try:
                    result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=60,env=env);terminal=dict(exitCode=result.returncode,timedOut=False)
                except subprocess.TimeoutExpired:terminal=dict(exitCode=None,timedOut=True)
            terminal.update(command=command,elapsedSeconds=time.monotonic()-begin);commands.append(terminal);write(name+'_terminal.json',terminal)
            assert terminal['exitCode']==0 and not terminal['timedOut'],name+' failed'
        py=json.loads((a.output/'generated/complete.json').read_text());ts=json.loads((a.output/'typescript_receipt.json').read_text())
        assert py['passed'] and ts['passed'] and py['fullDecisionEquivalenceComparisons']==ts['comparisons']==120
        for row in manifest['sources']:assert sha(row['path'])==row['sha256']
        receipt=dict(accepted=True,acceptedFor='artificial registry/transport equivalence only',createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,executionManifestSha256=sha(a.output/'execution_manifest.json'),pythonReceiptSha256=sha(a.output/'generated/complete.json'),typescriptReceiptSha256=sha(a.output/'typescript_receipt.json'),bundleSha256=sha(bundle),commands=commands,newMissions=0,freshSeedRegistryAdmitted=False,freshRunnerAdmitted=False,realCampaignAdmitted=False)
        write('acceptance.json',receipt);print(json.dumps(receipt))
    except BaseException as error:
        write('failure.json',dict(accepted=False,error=repr(error),commands=commands));raise

if __name__=='__main__':main()
