#!/usr/bin/env python3
"""Bounded four-process execution and separate audit of a frozen candidate."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def write(p,data):
    with p.open('x') as f:json.dump(data,f,indent=2,allow_nan=False);f.write('\n')


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--bundle',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--audit',type=Path,required=True)
    p.add_argument('--node',required=True)
    p.add_argument('--mode',choices=['nominal-preflight','nominal-only'],default='nominal-preflight')
    p.add_argument('--reference-root',type=Path)
    p.add_argument('--accepted-preflight',type=Path)
    a=p.parse_args();a.bundle=a.bundle.resolve();a.output=a.output.resolve();a.audit=a.audit.resolve()
    if a.reference_root:a.reference_root=a.reference_root.resolve()
    bundle=json.loads((a.bundle/'bundle.json').read_text())
    for line in (a.bundle/'SHA256SUMS').read_text().splitlines():
        digest,name=line.split('  ',1);assert sha(a.bundle/name)==digest,name
    if a.mode=='nominal-preflight':assert a.reference_root and not a.accepted_preflight
    else:
        assert a.accepted_preflight,'Production requires independent preflight acceptance'
        check=json.loads((a.accepted_preflight/'analysis.json').read_text());done=json.loads((a.accepted_preflight/'complete.json').read_text())
        assert done['accepted'] and done['analysisSha256']==sha(a.accepted_preflight/'analysis.json')
        assert check['accepted'] and check['mode']=='nominal-preflight' and check['compatibilityCount']==12 and check['bundleSha256']==sha(a.bundle/'bundle.json')
    a.output.mkdir(parents=True)
    plan=bundle['plan'][a.mode]
    write(a.output/'manifest.json',dict(schemaVersion='stage2i-run-v1',mode=a.mode,bundleSha256=sha(a.bundle/'bundle.json'),**plan))
    fixture=bundle['reportingFixture']
    env={**os.environ,'PYTHON':sys.executable,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','PYTHONDONTWRITEBYTECODE':'1',
         'REPORTING_FIXTURE_FILE':str(a.bundle/fixture['file']),'REPORTING_FIXTURE_SHA256':fixture['sha256']}
    launched=datetime.now(timezone.utc).isoformat();start=time.monotonic()
    def worker(w):
        command=[a.node,str(a.bundle/'scripts/stage2i-runner.mjs'),'--mode',a.mode,'--worker',str(w),'--output',str(a.output)]
        if a.reference_root:command+=['--reference-root',str(a.reference_root)]
        with (a.output/f'worker-{w}.log').open('x') as log:
            child=subprocess.Popen(command,cwd=a.bundle,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            print(f'launched worker {w} pid {child.pid}',flush=True)
            try:code=child.wait(timeout=7200)
            except BaseException:
                import signal
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=15)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
                raise
        print(f'worker {w} exited {code}',flush=True)
        return dict(worker=w,pid=child.pid,code=code)
    with ThreadPoolExecutor(max_workers=4) as pool:workers=list(pool.map(worker,range(4)))
    failures=[w for w in workers if w['code']!=0]
    write(a.output/'complete.json',dict(complete=not failures,failures=failures,workers=workers,launchedAt=launched,finishedAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,manifestSha256=sha(a.output/'manifest.json')))
    assert not failures,failures
    command=[sys.executable,str(a.bundle/'scripts/analyze-stage2i.py'),'--bundle',str(a.bundle),'--root',str(a.output),'--output',str(a.audit)]
    if a.reference_root:command+=['--reference-root',str(a.reference_root)]
    with (a.output/'audit.log').open('x') as log:
        child=subprocess.Popen(command,cwd=a.bundle,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        for line in child.stdout:log.write(line);log.flush();print(line,end='',flush=True)
        assert child.wait()==0,'Independent audit failed; retain outputs and do not promote'
    print('COMPLETE: independently accepted',a.mode,flush=True)


if __name__=='__main__':main()
