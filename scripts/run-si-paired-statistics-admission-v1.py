"""Two bounded local synthetic checks; no scientific missions."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    assert (datetime(2026,9,25,1,41,27,tzinfo=timezone.utc)-datetime.now(timezone.utc)).total_seconds()>=300
    paths=[Path(__file__),Path('scripts/test-si-paired-statistics-v1.py'),Path('scripts/audit-si-paired-statistics-v1.py'),Path('scripts/lib/si_paired_statistics_v1.py'),Path('scripts/lib/si_release_endpoint_v1.py'),Path('research/protocols/si_paired_statistics_synthetic_v1_2026-09-24.md')]
    a.output.mkdir(parents=True,exist_ok=False);start=time.monotonic();commands=[]
    def write(name,r):
        with (a.output/name).open('x') as f:json.dump(r,f,indent=2);f.write('\n')
    manifest=dict(createdAt=datetime.now(timezone.utc).isoformat(),sources=[dict(path=str(p),sha256=sha(p)) for p in paths],syntheticOnly=True,newMissions=0)
    write('execution_manifest.json',manifest)
    env={**os.environ,'PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'};env.pop('PYTHONPATH',None)
    try:
        for name,command in [('test',[sys.executable,'scripts/test-si-paired-statistics-v1.py','--output',str(a.output/'generated')]),('audit',[sys.executable,'scripts/audit-si-paired-statistics-v1.py','--input',str(a.output/'generated'),'--output',str(a.output/'independent_arithmetic_audit.json')])]:
            begin=time.monotonic()
            with (a.output/(name+'.log')).open('x') as log:
                try:
                    result=subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=60);terminal=dict(exitCode=result.returncode,timedOut=False)
                except subprocess.TimeoutExpired:terminal=dict(exitCode=None,timedOut=True)
            terminal.update(command=command,elapsedSeconds=time.monotonic()-begin);write(name+'_terminal.json',terminal);commands.append(terminal)
            assert terminal['exitCode']==0 and not terminal['timedOut'],name+' failed'
        audit=json.loads((a.output/'independent_arithmetic_audit.json').read_text());assert audit['passed']
        for row in manifest['sources']:assert sha(Path(row['path']))==row['sha256']
        receipt=dict(accepted=True,acceptedFor='synthetic complete-block paired statistics only',createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,executionManifestSha256=sha(a.output/'execution_manifest.json'),auditSha256=sha(a.output/'independent_arithmetic_audit.json'),commands=commands,newMissions=0,realCampaignAdmitted=False)
        write('acceptance.json',receipt);print(json.dumps(receipt))
    except BaseException as error:
        write('failure.json',dict(accepted=False,error=repr(error),createdAt=datetime.now(timezone.utc).isoformat(),commands=commands));raise

if __name__=='__main__':main()
