"""Bounded one-fixture reproduction from an immutable relocated package."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import numpy as np

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,r):
    with p.open('x') as f:json.dump(r,f,indent=2);f.write('\n')
def main():
    p=argparse.ArgumentParser();p.add_argument('--node',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    root=Path(__file__).resolve().parents[1];out=a.output.resolve();node=str(Path(a.node).resolve())
    assert out!=root and root not in out.parents and not out.exists() and out.parent.is_dir()
    m=json.loads((root/'package-manifest.json').read_text());assert m['kind']=='local-full-mission-scaffold-v1' and not m['publicRelease']
    def protect():
        for row in m['files']:
            target=(root/row['path']).resolve();assert root in target.parents and not (root/row['path']).is_symlink()
            assert target.stat().st_size==row['bytes'] and sha(target)==row['sha256'],row['path']
    protect();contract=json.loads((root/'contract.json').read_text())
    env={**os.environ,'PYTHON':sys.executable,'PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1','NUMEXPR_NUM_THREADS':'1'}
    for key in ('PYTHONPATH','NODE_OPTIONS','NODE_PATH'):env.pop(key,None)
    node_version=subprocess.run([node,'--version'],env=env,capture_output=True,text=True,timeout=10,check=True).stdout.strip()
    assert node_version==contract['testedRuntime']['node']
    assert platform.python_version()==contract['testedRuntime']['python'] and np.__version__==contract['testedRuntime']['numpy']
    out.mkdir();start=time.monotonic();commands=[]
    write(out/'started.json',dict(startedAt=datetime.now(timezone.utc).isoformat(),packageRoot=str(root),packageManifestSha256=sha(root/'package-manifest.json'),node=node_version,python=platform.python_version(),numpy=np.__version__,platform=platform.platform(),maximumMissions=1))
    def run(name,command):
        begin=time.monotonic()
        with (out/(name+'.log')).open('x') as log:
            try:
                r=subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,text=True,timeout=180)
                terminal=dict(exitCode=r.returncode,timedOut=False)
            except subprocess.TimeoutExpired:
                terminal=dict(exitCode=None,timedOut=True)
        terminal.update(command=command,elapsedSeconds=time.monotonic()-begin)
        write(out/(name+'_terminal.json'),terminal);commands.append(terminal)
        assert terminal['exitCode']==0 and not terminal['timedOut'],name+' failed; see saved log'
    try:
        run('mission',[node,'bin/full-mission.mjs','--package-root',str(root),'--output',str(out)])
        run('audit',[sys.executable,'scripts/audit-si-full-mission-portable.py','--output',str(out)])
        reproduction=json.loads((out/'reproduction.json').read_text());audit=json.loads((out/'independent_audit.json').read_text())
        assert reproduction['passed'] and audit['passed'] and reproduction['historySha256']==audit['historySha256']
        protect()
        write(out/'acceptance.json',dict(passed=True,acceptedFor='same-host full-mission relocation reproduction only',createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,packageManifestSha256=sha(root/'package-manifest.json'),checkedFiles=len(m['files']),historySha256=reproduction['historySha256'],auditSha256=sha(out/'independent_audit.json'),commands=commands,packageRoot=str(root),newMissionCount=1,newPerformanceCases=0,cleanInstall=False,crossPlatformValidated=False,publicRelease=False,physicalValidation=False))
        print(json.dumps(dict(passed=True,output=str(out),elapsedSeconds=time.monotonic()-start,checkedFiles=len(m['files']),fullRecordMatched=True)))
    except BaseException as e:
        write(out/'failure.json',dict(passed=False,error=str(e),at=datetime.now(timezone.utc).isoformat(),commands=commands));raise

if __name__=='__main__':main()
