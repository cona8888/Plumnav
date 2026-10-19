"""Run one bounded local development gate, preserving logs and partial output."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

def main():
    p=argparse.ArgumentParser();p.add_argument('--node',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    deadline=datetime.fromisoformat('2026-09-25T01:41:27+00:00')
    if (deadline-datetime.now(timezone.utc)).total_seconds()<240:
        raise RuntimeError('Insufficient time within authorisation window')
    a.output.mkdir(parents=True,exist_ok=False)
    bundle=Path('outputs/si-readout-positive-admission-v1.mjs')
    command=[a.node,str(bundle),'--output',str(a.output/'run')]
    started=datetime.now(timezone.utc).isoformat();timer=time.monotonic()
    invocation=dict(command=command,python=sys.executable,node=a.node,bundleSha256=hashlib.sha256(bundle.read_bytes()).hexdigest(),startedAt=started,timeoutSeconds=180,singleWorker=True)
    (a.output/'invocation.json').open('x').write(json.dumps(invocation,indent=2)+'\n')
    env={**os.environ,'PYTHON':sys.executable,'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1'}
    timed_out=False
    with (a.output/'runner.log').open('x') as log:
        process=subprocess.Popen(command,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        print(f'Local analytic admission PID {process.pid}; maximum 180 seconds',flush=True)
        try:
            code=process.wait(timeout=180)
        except subprocess.TimeoutExpired:
            timed_out=True
            # Only the process group created by this invocation is signalled.
            os.killpg(process.pid,signal.SIGTERM)
            try:code=process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGKILL);code=process.wait()
    terminal=dict(exitCode=code,timedOut=timed_out,pid=process.pid,elapsedSeconds=time.monotonic()-timer,finishedAt=datetime.now(timezone.utc).isoformat(),completeMarker=(a.output/'run/complete.json').is_file(),scientificAcceptance=False)
    (a.output/'process_terminal.json').open('x').write(json.dumps(terminal,indent=2)+'\n')
    print((a.output/'runner.log').read_text(),flush=True)
    print(json.dumps(terminal),flush=True)
    if code!=0 or timed_out or not terminal['completeMarker']:
        raise SystemExit(1)

if __name__=='__main__':main()
