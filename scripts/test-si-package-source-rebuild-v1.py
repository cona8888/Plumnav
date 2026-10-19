"""Compile the pinned package's source in isolation; never run a mission."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

PACKAGE_SHA='1a41acf4226ee269010304f49c15e73f9599eec477482e0fac28515456a514c6'
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def load(path):return json.loads(Path(path).read_text())

def verify(package,expected):
    if sha(package/'package-manifest.json')!=expected:raise ValueError('Package manifest hash mismatch')
    manifest=load(package/'package-manifest.json');seen=set()
    for row in manifest['files']:
        name=row['path'];path=package/name
        assert not Path(name).is_absolute() and '..' not in Path(name).parts and name not in seen;seen.add(name)
        assert path.is_file() and not path.is_symlink() and path.stat().st_size==row['bytes'] and sha(path)==row['sha256'],name
    assert len(seen)==80
    return manifest

def main():
    p=argparse.ArgumentParser();p.add_argument('--package',required=True,type=Path);p.add_argument('--esbuild',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    assert (datetime(2026,9,25,1,41,27,tzinfo=timezone.utc)-datetime.now(timezone.utc)).total_seconds()>=300
    a.output.mkdir(parents=True,exist_ok=False);start=time.monotonic();commands=[]
    def write(name,value):
        with (a.output/name).open('x') as f:json.dump(value,f,indent=2);f.write('\n')
    tool=a.esbuild.resolve();package=a.package.resolve()
    paths=[Path(__file__),Path('research/protocols/si_package_source_rebuild_v1_2026-09-24.md')]
    freeze=dict(createdAt=datetime.now(timezone.utc).isoformat(),sources=[dict(path=str(path),sha256=sha(path)) for path in paths],packageManifestSha256=PACKAGE_SHA,buildTool=dict(path=str(tool),sha256=sha(tool)),newMissions=0)
    write('execution_manifest.json',freeze)
    try:
        manifest=verify(package,PACKAGE_SHA)
        try:verify(package,'0'*64)
        except ValueError:wrong_pin=True
        else:raise AssertionError('Wrong package pin accepted')
        version=subprocess.run([str(tool),'--version'],capture_output=True,text=True,check=True,timeout=10).stdout.strip();assert version=='0.28.1'
        metadata=load(package/'build/full-mission.meta.json');dependency=load(package/'dependency-inventory.json')
        inputs=metadata['inputs'];assert set(inputs)==set(dependency['typescriptSourceInputs'])
        assert 'src/sim/engine.ts' in inputs
        assert len(metadata['outputs'])==1
        output_name=next(iter(metadata['outputs']));entry=metadata['outputs'][output_name]['entryPoint']
        assert output_name=='outputs/si-full-mission-portable-v1.mjs' and entry in inputs
        source_inventory=[dict(path=name,sha256=sha(package/name),bytes=(package/name).stat().st_size) for name in sorted(inputs)]
        listed={r['path']:r for r in manifest['files']}
        for row in source_inventory:assert listed[row['path']]['sha256']==row['sha256'] and listed[row['path']]['bytes']==row['bytes']
        write('source_inventory.json',dict(entryPoint=entry,sources=source_inventory,toolVersion=version,sourceCount=len(inputs)))
        reference_sha=sha(package/'bin/full-mission.mjs');runs=[]
        with tempfile.TemporaryDirectory(prefix='plumenav-source-rebuild-') as temporary:
            base=Path(temporary).resolve();assert not base.is_relative_to(Path.cwd().resolve())
            for label,missing in [('rebuild01',None),('rebuild02',None),('missing_source','src/sim/engine.ts')]:
                root=base/label;root.mkdir()
                for row in source_inventory:
                    if row['path']==missing:continue
                    target=root/row['path'];target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(package/row['path'],target)
                    assert sha(target)==row['sha256']
                assert not (root/'node_modules').exists() and not (root/'fixtures').exists() and not (root/'bin').exists()
                command=[str(tool),entry,'--bundle','--platform=node','--format=esm','--outfile='+output_name,'--metafile=outputs/rebuild.meta.json']
                begin=time.monotonic()
                with (a.output/(label+'.log')).open('x') as log:
                    try:child=subprocess.run(command,cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=60);terminal=dict(exitCode=child.returncode,timedOut=False)
                    except subprocess.TimeoutExpired:terminal=dict(exitCode=None,timedOut=True)
                terminal.update(command=command,workingDirectory=str(root),elapsedSeconds=time.monotonic()-begin);commands.append(terminal);write(label+'_terminal.json',terminal)
                assert not terminal['timedOut']
                compiled=root/output_name
                if missing:
                    assert terminal['exitCode']!=0 and not compiled.exists()
                    runs.append(dict(label=label,omittedSource=missing,compileRejected=True,executableCreated=False));continue
                assert terminal['exitCode']==0 and sha(compiled)==reference_sha,'Rebuilt executable differs'
                actual=load(root/'outputs/rebuild.meta.json');assert actual==metadata,'Build metadata differs'
                for row in source_inventory:assert sha(root/row['path'])==row['sha256']
                shutil.copyfile(compiled,a.output/(label+'.mjs'));shutil.copyfile(root/'outputs/rebuild.meta.json',a.output/(label+'.meta.json'))
                runs.append(dict(label=label,executableSha256=sha(compiled),metadataSha256=sha(root/'outputs/rebuild.meta.json'),sourceGraphExact=True,sourceCount=len(inputs),noInstalledDependencies=True))
        verify(package,PACKAGE_SHA)
        for row in freeze['sources']:assert sha(row['path'])==row['sha256']
        assert sha(tool)==freeze['buildTool']['sha256']
        receipt=dict(accepted=True,acceptedFor='isolated same-host no-install source rebuild only',createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,executionManifestSha256=sha(a.output/'execution_manifest.json'),packageManifestSha256=PACKAGE_SHA,unchangedPackageFiles=80,sourceCount=len(inputs),toolVersion=version,toolSha256=sha(tool),referenceExecutableSha256=reference_sha,runs=runs,wrongPinRejected=wrong_pin,commands=commands,newMissions=0,scientificAuditsRun=0,dependencyInstallation=False,cleanMachineTested=False,crossPlatformTested=False,temporaryCopiesRemoved=True)
        write('acceptance.json',receipt);print(json.dumps(receipt))
    except BaseException as error:
        write('failure.json',dict(accepted=False,error=repr(error),createdAt=datetime.now(timezone.utc).isoformat(),commands=commands));raise

if __name__=='__main__':main()
