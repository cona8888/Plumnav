"""Assemble a new local-only replay scaffold without editing accepted evidence."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def load(path):return json.loads(path.read_text())
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    source=Path('research/results/si_no_scan_controller_admission_v1_attempt01_2026-09-24')
    manifest=load(source/'manifest.json');done=load(source/'complete.json');audit=load(source/'independent_audit.json')
    assert done['passed'] and audit['passed'] and audit['manifestSha256']==sha(source/'manifest.json') and audit['completeSha256']==sha(source/'complete.json')
    for r in manifest['sources']:assert sha(Path(r['path']))==r['sha256']
    for r in done['inventory']:assert sha(source/r['file'])==r['sha256']
    meta=Path('outputs/si-no-scan-portable-v1.meta.json');bundle=Path('outputs/si-no-scan-portable-v1.mjs')
    inputs=load(meta)['inputs'];assert all(not p.startswith('/') and '..' not in Path(p).parts for p in inputs)
    pairs={p:p for p in inputs}
    pairs.update({r['path']:r['path'] for r in manifest['sources']})
    for p in ('scripts/audit-si-no-scan-controller.py','scripts/verify-si-replay-package.py','scripts/build-si-replay-package.py'):
        pairs[p]=p
    pairs[str(bundle)]='bin/replay.mjs';pairs[str(meta)]='build/replay.meta.json'
    pairs['research/reproducibility_scaffold_2026-09-24/README.md']='README.md'
    pairs['research/reproducibility_scaffold_2026-09-24/contract.json']='contract.json'
    for p in ('manifest.json','complete.json','independent_audit.json','blank.json.gz','positive.json.gz','pulsed.json.gz'):
        pairs[str(source/p)]='fixtures/no-scan/'+p
    assert len(set(pairs.values()))==len(pairs)
    a.output.mkdir(parents=True,exist_ok=False);files=[]
    for original,destination in sorted(pairs.items(),key=lambda x:x[1]):
        origin=Path(original);target=a.output/destination
        assert origin.is_file() and not origin.is_symlink()
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(origin,target)
        assert sha(origin)==sha(target)
        files.append(dict(path=destination,bytes=target.stat().st_size,sha256=sha(target),sourcePath=original))
    value=dict(kind='local-controller-replay-scaffold-v1',createdAt=datetime.now(timezone.utc).isoformat(),files=files,fixtureManifestSha256=sha(source/'manifest.json'),sourceBundleSha256=sha(bundle),sourceBuildMetadataSha256=sha(meta),dependencyBoundary='Runtime JavaScript is bundled; Node built-ins and Python standard library only. Build-time dependency installation is not included or tested.',publicRelease=False,newSimulation=False,cleanInstall=False)
    with (a.output/'package-manifest.json').open('x') as f:json.dump(value,f,indent=2);f.write('\n')
    print(json.dumps(dict(output=str(a.output),files=len(files),bytes=sum(r['bytes'] for r in files),manifestSha256=sha(a.output/'package-manifest.json'),publicRelease=False)))

if __name__=='__main__':main()
