"""Offline package integrity and controller replay; never launches a simulation."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser(); p.add_argument('--node',required=True); p.add_argument('--receipt',type=Path,required=True); a=p.parse_args()
    root=Path(__file__).resolve().parents[1]; receipt=a.receipt.resolve()
    assert root not in receipt.parents,'Receipt must be outside the immutable package'
    assert not receipt.exists() and receipt.parent.is_dir()
    manifest=json.loads((root/'package-manifest.json').read_text())
    assert manifest['kind']=='local-controller-replay-scaffold-v1' and not manifest['publicRelease']
    for r in manifest['files']:
        target=(root/r['path']).resolve()
        assert root in target.parents and not (root/r['path']).is_symlink()
        assert target.stat().st_size==r['bytes'] and sha(target)==r['sha256'],r['path']
    env={**os.environ,'PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'}
    env.pop('PYTHONPATH',None); env.pop('NODE_OPTIONS',None); env.pop('NODE_PATH',None)
    commands=[]
    def run(command):
        result=subprocess.run(command,cwd=root,env=env,text=True,capture_output=True,timeout=60)
        commands.append(dict(command=command,exitCode=result.returncode,stdout=result.stdout,stderr=result.stderr))
        assert result.returncode==0,result.stderr
        return json.loads(result.stdout)
    with tempfile.TemporaryDirectory(prefix='plumenav-replay-audit-') as temporary:
        audit_path=Path(temporary)/'audit.json'
        audit=run([sys.executable,'scripts/audit-si-no-scan-controller.py','--input','fixtures/no-scan','--output',str(audit_path)])
        replay=run([str(Path(a.node).resolve()),'bin/replay.mjs','--fixtures','fixtures/no-scan'])
        assert audit['passed'] and replay['passed']
    for r in manifest['files']: assert sha(root/r['path'])==r['sha256']
    result=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),packageManifestSha256=sha(root/'package-manifest.json'),checkedFiles=len(manifest['files']),python=platform.python_version(),platform=platform.platform(),audit=audit,replay=replay,commands=commands,relocatedRoot=str(root),newSimulation=False,cleanInstall=False,crossPlatformValidated=False,publicRelease=False)
    with receipt.open('x') as f: json.dump(result,f,indent=2); f.write('\n')
    print(json.dumps(dict(passed=True,checkedFiles=len(manifest['files']),receipt=str(receipt),newSimulation=False)))

if __name__=='__main__': main()
