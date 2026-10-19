"""Bounded relocation test on a disposable copy, with negative integrity checks."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--package',type=Path,required=True);p.add_argument('--node',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    root=a.package.resolve();a.output.mkdir(parents=True,exist_ok=False)
    manifest=json.loads((root/'package-manifest.json').read_text());before=sha(root/'package-manifest.json')
    started=time.monotonic();commands=[]
    with tempfile.TemporaryDirectory(prefix='plumenav-isolated-replay-') as temporary:
        isolated=Path(temporary)/'package';shutil.copytree(root,isolated)
        report=(a.output/'relocated_replay.json').resolve()
        def invoke(output):
            command=[sys.executable,str(isolated/'scripts/verify-si-replay-package.py'),'--node',str(Path(a.node).resolve()),'--receipt',str(output)]
            r=subprocess.run(command,cwd=temporary,text=True,capture_output=True,timeout=65)
            commands.append(dict(command=command,exitCode=r.returncode,stdout=r.stdout,stderr=r.stderr))
            return r
        good=invoke(report);assert good.returncode==0,good.stderr
        replay=json.loads(report.read_text());assert replay['passed'] and replay['packageManifestSha256']==before
        assert Path(replay['relocatedRoot']).resolve()==isolated.resolve() and not (isolated/'node_modules').exists()
        bad_path=Path(temporary)/'should-not-exist.json'
        bundle=isolated/'bin/replay.mjs'
        with bundle.open('ab') as f:f.write(b'\n// deliberate corruption in disposable copy\n')
        bad=invoke(bad_path);assert bad.returncode!=0 and not bad_path.exists()
        shutil.copyfile(root/'bin/replay.mjs',bundle)
        existing=invoke(report);assert existing.returncode!=0
        assert json.loads(report.read_text())==replay
        absent=isolated/'fixtures/no-scan/blank.json.gz';moved=absent.with_suffix('.held')
        absent.rename(moved)
        missing=invoke(bad_path);assert missing.returncode!=0 and not bad_path.exists()
        moved.rename(absent)
        for r in manifest['files']:assert sha(isolated/r['path'])==sha(root/r['path'])==r['sha256']
    assert sha(root/'package-manifest.json')==before
    receipt=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-started,scriptSha256=sha(Path(__file__)),packageManifestSha256=before,filesUnchanged=len(manifest['files']),decisionsReplayed=sum(x['decisionsMatched'] for x in replay['replay']['results']),negativePackageChecksRejected=3,commands=commands,isolatedCopyRemoved=True,originalPackageUnchanged=True,noDependencyInstallation=True,newSimulation=False,cleanInstall=False,crossPlatformValidation=False,publicRelease=False)
    with (a.output/'acceptance.json').open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
    print(json.dumps({k:v for k,v in receipt.items() if k!='commands'}))

if __name__=='__main__':main()
