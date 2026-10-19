"""Bounded synthetic blank-control admission; all prior sources remain frozen."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    assert (datetime(2026,9,25,1,41,27,tzinfo=timezone.utc)-datetime.now(timezone.utc)).total_seconds()>=300
    paths=['scripts/run-si-blank-controls-v2.py','scripts/test-si-blank-controls-v2.py','scripts/audit-si-blank-controls-v2.py','scripts/lib/si_release_endpoint_v1.py','scripts/lib/si_release_endpoint_v2.py','scripts/lib/si_paired_statistics_v1.py','scripts/lib/si_paired_statistics_v2.py','scripts/lib/si_blank_statistics_delta_v2.py','research/protocols/si_blank_controls_synthetic_v2_2026-09-24.md']
    a.output.mkdir(parents=True,exist_ok=False);start=time.monotonic();commands=[]
    def write(name,value):
        with (a.output/name).open('x') as f:json.dump(value,f,indent=2);f.write('\n')
    manifest=dict(createdAt=datetime.now(timezone.utc).isoformat(),sources=[dict(path=path,sha256=sha(path)) for path in paths],syntheticOnly=True,newMissions=0)
    write('execution_manifest.json',manifest)
    env={**os.environ,'PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','MKL_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'};env.pop('PYTHONPATH',None)
    tasks=[('test',[sys.executable,'scripts/test-si-blank-controls-v2.py','--output',str(a.output/'generated')]),('audit',[sys.executable,'scripts/audit-si-blank-controls-v2.py','--input',str(a.output/'generated'),'--manifest',str(a.output/'execution_manifest.json'),'--output',str(a.output/'independent_audit.json')])]
    try:
        for name,command in tasks:
            begin=time.monotonic()
            with (a.output/(name+'.log')).open('x') as log:
                try:result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,env=env,timeout=60);terminal=dict(exitCode=result.returncode,timedOut=False)
                except subprocess.TimeoutExpired:terminal=dict(exitCode=None,timedOut=True)
            terminal.update(command=command,elapsedSeconds=time.monotonic()-begin);commands.append(terminal);write(name+'_terminal.json',terminal)
            assert terminal['exitCode']==0 and not terminal['timedOut'],name+' failed'
        audit=json.loads((a.output/'independent_audit.json').read_text());assert audit['passed']
        for row in manifest['sources']:assert sha(row['path'])==row['sha256']
        receipt=dict(accepted=True,acceptedFor='synthetic blank-control metadata, refinement and paired accounting only',createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,executionManifestSha256=sha(a.output/'execution_manifest.json'),auditSha256=sha(a.output/'independent_audit.json'),commands=commands,newMissions=0,realCampaignAdmitted=False)
        write('acceptance.json',receipt);print(json.dumps(receipt))
    except BaseException as error:
        write('failure.json',dict(accepted=False,error=repr(error),createdAt=datetime.now(timezone.utc).isoformat(),commands=commands));raise

if __name__=='__main__':main()
