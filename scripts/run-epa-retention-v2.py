"""Bounded local generation/audit with retained process logs and no retry."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,r):
    with p.open('x') as f:json.dump(r,f,indent=2);f.write('\n')
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    assert (datetime.fromisoformat('2026-09-25T01:41:27+00:00')-datetime.now(timezone.utc)).total_seconds()>300
    sources=[Path(x) for x in ('scripts/analyze-epa-sample-retention-v2.py','scripts/audit-epa-sample-retention-v2.py','scripts/epa_exact_numeric.py','scripts/epa_retention_decimal.py','scripts/run-epa-retention-v2.py','research/protocols/epa_sample_index_retention_v1_2026-09-24.md','research/protocols/epa_sample_index_retention_v2_arithmetic_2026-09-24.md')]
    pins=[dict(path=str(x),sha256=sha(x)) for x in sources]
    a.output.mkdir(parents=True,exist_ok=False)
    write(a.output/'execution_manifest.json',dict(createdAt=datetime.now(timezone.utc).isoformat(),sources=pins,python=sys.executable,perProcessCapSeconds=120,noAutomaticRetry=True,newSimulation=False))
    commands=[('generation',[sys.executable,'scripts/analyze-epa-sample-retention-v2.py','--output',str(a.output/'generated')]),('audit',[sys.executable,'scripts/audit-epa-sample-retention-v2.py','--input',str(a.output/'generated'),'--output',str(a.output/'independent_audit.json')])]
    begin=time.monotonic();receipts=[]
    try:
        for name,command in commands:
            for r in pins:assert sha(Path(r['path']))==r['sha256']
            now=datetime.now(timezone.utc).isoformat();start=time.monotonic();timed_out=False
            with (a.output/(name+'.log')).open('x') as log:
                try:result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=120);code=result.returncode
                except subprocess.TimeoutExpired:timed_out=True;code=None
            r=dict(command=command,startedAt=now,finishedAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,exitCode=code,timedOut=timed_out)
            write(a.output/(name+'_terminal.json'),r);receipts.append(r);assert code==0 and not timed_out,f'{name} failed; retained log'
        audit=json.loads((a.output/'independent_audit.json').read_text());assert audit['passed']
        for r in pins:assert sha(Path(r['path']))==r['sha256']
        write(a.output/'acceptance.json',dict(accepted=True,acceptedFor='retrospective exact stored-decimal sample-index retention only',createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-begin,executionManifestSha256=sha(a.output/'execution_manifest.json'),auditSha256=sha(a.output/'independent_audit.json'),commands=receipts,hardwareValidation=False,exactTimeAvailable=False,newSimulation=False))
        print('ACCEPTED: exact-decimal sample-index calculation; physical claims unchanged')
    except BaseException as error:
        write(a.output/'failed.json',dict(accepted=False,createdAt=datetime.now(timezone.utc).isoformat(),error=str(error),commands=receipts,diagnosticOnly=True));raise

if __name__=='__main__':main()
