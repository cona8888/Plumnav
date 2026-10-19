"""Pin and assemble a private one-fixture full-mission package."""
import argparse
import ast
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import numpy as np

FROZEN_PYTHON=[
 'scripts/si-readout-exact-bridge.py','scripts/audit-si-readout-full-history.py','scripts/audit-stage1n-candidate.py',
 *['scripts/lib/'+n+'.py' for n in ('si_stationary_head_contract','si_bounded_pose_v4','si_bounded_pose','si_scan_disabled_audit','si_readout_terminal_audit','si_turn_motion_audit','si_head_motion_audit','si_linear_response_audit','si_v4_decision_audit')]]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):return json.loads(p.read_text())
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);p.add_argument('--node',required=True);a=p.parse_args()
    parent=Path('research/results/si_scan_disabled_mission_admission_v1_attempt01_2026-09-24');case_id='si-continuous-scan-disabled-n64';folder=parent/case_id
    assert sha(parent/'manifest.json')=='fd074f85c1c7f88ce883180b7610a9a9c59e2f130f6288e37d188fdb2ed520d1'
    m=load(parent/'manifest.json');done=load(folder/'run/complete.json');audit=load(folder/'independent_audit.json')
    index={r['path']:r['sha256'] for r in m['sources']}
    def protect():
        for name,expected in index.items():assert sha(Path(name))==expected,name
    protect();assert load(parent/'acceptance.json')['accepted']
    history_sha=sha(folder/'run/mission.json.gz');assert history_sha=='a5496fa9d85a907175c23c6db7e91a3f813a3e6ef8211c8f905701fb5a0a4ba3'
    assert done['completed'] and done['historySha256']==history_sha and audit['passed'] and audit['historySha256']==history_sha
    assert audit['manifestSha256']==sha(parent/'manifest.json')
    meta_path=Path('outputs/si-full-mission-portable-v1.meta.json');bundle=Path('outputs/si-full-mission-portable-v1.mjs');meta=load(meta_path)
    imports=[r for out in meta['outputs'].values() for r in out['imports']]
    assert all(r['external'] and r['path'].startswith('node:') for r in imports),imports
    pairs={name:name for name in meta['inputs']}
    assert all(not Path(name).is_absolute() and '..' not in Path(name).parts for name in pairs)
    for name in FROZEN_PYTHON:
        assert name in index and sha(Path(name))==index[name]
        pairs[name]=name
    local_imports=[];dynamic=[]
    for name in FROZEN_PYTHON:
        tree=ast.parse(Path(name).read_text())
        for node in ast.walk(tree):
            if isinstance(node,ast.ImportFrom) and node.module and node.module.startswith('lib.'):
                target='scripts/'+node.module.replace('.','/')+'.py';assert target in FROZEN_PYTHON,target
                local_imports.append(dict(source=name,target=target))
            if isinstance(node,ast.Constant) and isinstance(node.value,str) and node.value.endswith('.py'):
                targets=[p for p in FROZEN_PYTHON if Path(p).name==node.value]
                assert len(targets)==1,(name,node.value,targets)
                dynamic.append(dict(source=name,literal=node.value,target=targets[0],resolution='unique copied filename; original runtime path code unchanged'))
    for name in ('build-si-full-mission-package.py','verify-si-full-mission-package.py','audit-si-full-mission-portable.py','test-si-full-mission-package.py'):
        pairs['scripts/'+name]='scripts/'+name
    pairs[str(bundle)]='bin/full-mission.mjs';pairs[str(meta_path)]='build/full-mission.meta.json'
    protocol=Path('research/protocols/si_full_mission_relocation_v1_2026-09-24.md');pairs[str(protocol)]='provenance/relocation_protocol.md'
    pairs['research/reproducibility_scaffold_2026-09-24/full_mission_README.md']='README.md'
    for source,target in ((folder/'run/mission.json.gz','fixtures/mission.json.gz'),(folder/'run/complete.json','provenance/original_complete.json'),(folder/'independent_audit.json','provenance/original_independent_audit.json'),(parent/'manifest.json','provenance/original_manifest.json'),(parent/'acceptance.json','provenance/original_acceptance.json')):pairs[str(source)]=target
    assert len(set(pairs.values()))==len(pairs)
    a.output.mkdir(parents=True,exist_ok=False);files=[]
    def inventory(target,source=None):
        files.append(dict(path=str(target.relative_to(a.output)),bytes=target.stat().st_size,sha256=sha(target),sourcePath=source))
    for source,destination in sorted(pairs.items(),key=lambda x:x[1]):
        origin=Path(source);target=a.output/destination;assert origin.is_file() and not origin.is_symlink()
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(origin,target);assert sha(origin)==sha(target);inventory(target,source)
    def generated(name,value):
        target=a.output/name
        with target.open('x') as f:json.dump(value,f,indent=2);f.write('\n')
        inventory(target)
    runtime=dict(python=platform.python_version(),numpy=np.__version__,node=subprocess.run([a.node,'--version'],capture_output=True,text=True,check=True,timeout=10).stdout.strip(),platform=platform.platform())
    generated('contract.json',dict(version='full-mission-relocation-v1',case=done['item'],referenceHistorySha256=history_sha,bridgeSha256=index['scripts/si-readout-exact-bridge.py'],parentManifestSha256=sha(parent/'manifest.json'),equalityExclusions=['summary.rpcMilliseconds'],testedRuntime=runtime,maximumMissions=1,newPerformanceCase=False,physicalValidation=False))
    generated('dependency-inventory.json',dict(testedRuntime=runtime,pythonExternalPackages={'numpy':np.__version__},pythonFrozenFiles=FROZEN_PYTHON,pythonLocalImportEdges=local_imports,pythonDynamicFileEdges=dynamic,typescriptSourceInputs=list(meta['inputs']),bundleExternalImports=imports,buildDependency={'esbuild':load(Path('node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/package.json'))['version']},cleanInstallTested=False,sourceBuildInstallationIncluded=False))
    protect()
    manifest=dict(kind='local-full-mission-scaffold-v1',createdAt=datetime.now(timezone.utc).isoformat(),files=files,protocolSha256=sha(protocol),parentManifestSha256=sha(parent/'manifest.json'),parentSourceFilesVerified=len(index),referenceHistorySha256=history_sha,sourceBundleSha256=sha(bundle),publicRelease=False,cleanInstall=False,dependencyBoundary='Bundled Node runtime plus unchanged Python/NumPy modules; same-host installed runtimes. No dependency installation or cross-platform claim.')
    with (a.output/'package-manifest.json').open('x') as f:json.dump(manifest,f,indent=2);f.write('\n')
    print(json.dumps(dict(output=str(a.output),files=len(files),payloadBytes=sum(f['bytes'] for f in files),manifestSha256=sha(a.output/'package-manifest.json'),parentSourceFilesVerified=len(index))))

if __name__=='__main__':main()
