"""One bounded local relocation reproduction, retaining all test receipts."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,r):
    with p.open('x') as f:json.dump(r,f,indent=2);f.write('\n')
def main():
    p=argparse.ArgumentParser();p.add_argument('--package',required=True,type=Path);p.add_argument('--node',required=True);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    deadline=datetime(2026,9,25,1,41,27,tzinfo=timezone.utc)
    assert (deadline-datetime.now(timezone.utc)).total_seconds()>=600,'Insufficient authorisation time'
    root=a.package.resolve();out=a.output.resolve();assert root not in out.parents and out!=root
    m=json.loads((root/'package-manifest.json').read_text());before=sha(root/'package-manifest.json')
    assert m['kind']=='local-full-mission-scaffold-v1'
    out.mkdir(parents=True,exist_ok=False);start=time.monotonic();commands=[]
    env={**os.environ,'PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1','NUMEXPR_NUM_THREADS':'1'}
    for key in ('PYTHONPATH','NODE_OPTIONS','NODE_PATH'):env.pop(key,None)
    write(out/'started.json',dict(startedAt=datetime.now(timezone.utc).isoformat(),packageManifestSha256=before,scriptSha256=sha(Path(__file__)),maximumMissions=1,maximumWallSeconds=480))
    try:
        with tempfile.TemporaryDirectory(prefix='plumenav-isolated-full-mission-') as tmp:
            isolated=Path(tmp)/'package';shutil.copytree(root,isolated)
            assert not (isolated/'node_modules').exists() and not any(p.is_symlink() for p in isolated.rglob('*'))
            def invoke(name,destination):
                remaining=480-(time.monotonic()-start);assert remaining>0
                command=[sys.executable,str(isolated/'scripts/verify-si-full-mission-package.py'),'--node',str(Path(a.node).resolve()),'--output',str(destination)]
                with (out/(name+'.log')).open('x') as log:
                    try:
                        r=subprocess.run(command,cwd=tmp,env=env,text=True,stdout=log,stderr=subprocess.STDOUT,timeout=min(380,remaining))
                        terminal=dict(exitCode=r.returncode,timedOut=False)
                    except subprocess.TimeoutExpired:terminal=dict(exitCode=None,timedOut=True)
                terminal.update(command=command,name=name);commands.append(terminal);write(out/(name+'_terminal.json'),terminal)
                assert not terminal['timedOut'],'Test timed out'
                return terminal['exitCode']
            reproduced=out/'reproduced';assert invoke('relocation',reproduced)==0,'Reproduction failed; see saved output'
            accepted=json.loads((reproduced/'acceptance.json').read_text())
            assert accepted['passed'] and accepted['packageManifestSha256']==before and Path(accepted['packageRoot'])==isolated
            failure_output=Path(tmp)/'must-not-be-created'
            bundle=isolated/'bin/full-mission.mjs'
            with bundle.open('ab') as f:f.write(b'\n// deliberate corruption in disposable copy\n')
            assert invoke('corrupted_bundle',failure_output)!=0 and not failure_output.exists()
            shutil.copyfile(root/'bin/full-mission.mjs',bundle)
            assert invoke('existing_output',reproduced)!=0 and json.loads((reproduced/'acceptance.json').read_text())==accepted
            history=isolated/'fixtures/mission.json.gz';held=history.with_suffix('.held');history.rename(held)
            assert invoke('missing_fixture',failure_output)!=0 and not failure_output.exists();held.rename(history)
            for row in m['files']:assert sha(isolated/row['path'])==sha(root/row['path'])==row['sha256']
        assert sha(root/'package-manifest.json')==before
        receipt=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,packageManifestSha256=before,checkedFiles=len(m['files']),negativePackageChecksRejected=3,commands=commands,newMissionCount=1,newPerformanceCases=0,isolatedCopyRemoved=True,originalPackageUnchanged=True,noDependencyInstallation=True,cleanInstall=False,crossPlatformValidation=False,publicRelease=False)
        write(out/'acceptance.json',receipt);print(json.dumps({k:v for k,v in receipt.items() if k!='commands'}))
    except BaseException as e:
        write(out/'failure.json',dict(passed=False,error=str(e),at=datetime.now(timezone.utc).isoformat(),commands=commands));raise

if __name__=='__main__':main()
