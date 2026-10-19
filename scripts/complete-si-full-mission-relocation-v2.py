"""Complete package-only checks, explicitly reusing the successful v1 mission/audit."""
import argparse
from datetime import datetime,timezone
import gzip
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
def load(p):return json.loads(p.read_text())
def write(p,r):
    with p.open('x') as f:json.dump(r,f,indent=2);f.write('\n')
def same_path(left,right):
    assert Path(left).resolve()==Path(right).resolve(),(left,right)
def main():
    p=argparse.ArgumentParser();p.add_argument('--node',required=True);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    assert (datetime(2026,9,25,1,41,27,tzinfo=timezone.utc)-datetime.now(timezone.utc)).total_seconds()>=300
    root=Path('research/reproducibility_scaffold_2026-09-24/local_full_mission_package_v1').resolve()
    prior=Path('research/reproducibility_scaffold_2026-09-24/full_mission_relocation_attempt01').resolve();rdir=prior/'reproduced'
    protocol=Path('research/protocols/si_full_mission_relocation_path_v2_2026-09-24.md')
    m=load(root/'package-manifest.json');assert sha(root/'package-manifest.json')=='1a41acf4226ee269010304f49c15e73f9599eec477482e0fac28515456a514c6'
    assert sha(rdir/'independent_audit.json')=='42cf9c77693622f6220123091082abb4f1f2360ac1ed46d9900b8801df7172b2'
    assert sha(rdir/'mission.json.gz')=='71dd14dc5001981ddbdd4c1bf59d5d9fc6330d002f17ffd3e8a87d24bc7da257'
    pins=[root/'package-manifest.json',protocol,Path(__file__).resolve(),*[p for p in prior.rglob('*') if p.is_file()]]
    a.output.mkdir(parents=True,exist_ok=False);out=a.output.resolve();start=time.monotonic();commands=[]
    manifest=dict(version='full-mission-path-v2',createdAt=datetime.now(timezone.utc).isoformat(),sources=[dict(path=str(p),sha256=sha(p)) for p in sorted(pins)],newMissions=0,newScientificAudits=0,maximumSeconds=120)
    write(out/'manifest.json',manifest)
    def protect():
        for f in m['files']:assert sha(root/f['path'])==f['sha256']
        for f in manifest['sources']:assert sha(Path(f['path']))==f['sha256']
    try:
        # Check the operating-system alias without creating or changing it.
        same_path('/var/folders','/private/var/folders')
        rejected=False
        try:same_path('/var/folders/plumenav-a','/private/var/folders/plumenav-b')
        except AssertionError:rejected=True
        assert rejected
        protect();old=load(prior/'failure.json');terminal=load(prior/'relocation_terminal.json')
        assert old['passed'] is False and len(old['commands'])==1 and terminal['exitCode']==0 and not terminal['timedOut']
        assert not (prior/'acceptance.json').exists()
        accepted=load(rdir/'acceptance.json');reproduced=load(rdir/'reproduction.json');audit=load(rdir/'independent_audit.json')
        assert accepted['passed'] and reproduced['passed'] and audit['passed']
        assert accepted['auditSha256']==sha(rdir/'independent_audit.json')
        assert all(x['packageManifestSha256']==sha(root/'package-manifest.json') for x in (accepted,reproduced,audit))
        assert all(x['historySha256']==sha(rdir/'mission.json.gz') for x in (accepted,reproduced,audit))
        assert reproduced['fullRecordMatched'] and reproduced['equalityExclusions']==['summary.rpcMilliseconds']
        assert reproduced['replay']['passed'] and reproduced['replay']['privateFieldQueries']==0
        assert reproduced['stage']=='inspection-complete' and audit['details']['scanDisabled']['inspectionPathExercised']
        assert all(x['exitCode']==0 and not x['timedOut'] for x in accepted['commands'])
        invoked=Path(terminal['command'][1]).parents[1];reported=Path(accepted['packageRoot']);same_path(invoked,reported)
        assert invoked!=reported,'Expected the saved v1 lexical alias mismatch'
        assert not invoked.exists() and not reported.exists(),'Original disposable copy should have been removed'
        current=json.loads(gzip.decompress((rdir/'mission.json.gz').read_bytes()));reference=json.loads(gzip.decompress((root/'fixtures/mission.json.gz').read_bytes()))
        assert sha(root/'fixtures/mission.json.gz')==reproduced['referenceHistorySha256']
        current['summary']['rpcMilliseconds']=reference['summary']['rpcMilliseconds']=0
        assert current==reference,'Saved full histories differ';del current,reference
        env={**os.environ,'PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'}
        for key in ('PYTHONPATH','NODE_OPTIONS','NODE_PATH'):env.pop(key,None)
        with tempfile.TemporaryDirectory(prefix='plumenav-full-package-checks-v2-') as temp:
            isolated=(Path(temp)/'package').resolve();shutil.copytree(root,isolated)
            assert not (isolated/'node_modules').exists() and not any(p.is_symlink() for p in isolated.rglob('*'))
            absent=(Path(temp)/'must-remain-absent').resolve();existing=Path(temp)/'existing';existing.mkdir();sentinel=existing/'sentinel.txt';sentinel.write_bytes(b'preserve this disposable sentinel\n');sentinel_sha=sha(sentinel)
            def reject(name,destination):
                remaining=120-(time.monotonic()-start);assert remaining>0
                command=[sys.executable,str(isolated/'scripts/verify-si-full-mission-package.py'),'--node',str(Path(a.node).resolve()),'--output',str(destination)]
                with (out/(name+'.log')).open('x') as log:r=subprocess.run(command,cwd=temp,env=env,text=True,stdout=log,stderr=subprocess.STDOUT,timeout=min(20,remaining))
                receipt=dict(name=name,command=command,exitCode=r.returncode);commands.append(receipt);write(out/(name+'_terminal.json'),receipt)
                assert r.returncode!=0 and not absent.exists()
                assert sorted(p.name for p in existing.iterdir())==['sentinel.txt'] and sha(sentinel)==sentinel_sha
            bundle=isolated/'bin/full-mission.mjs'
            with bundle.open('ab') as f:f.write(b'\n// deliberate corruption in disposable copy\n')
            reject('corrupted_bundle',absent);shutil.copyfile(root/'bin/full-mission.mjs',bundle)
            history=isolated/'fixtures/mission.json.gz';held=history.with_suffix('.held');history.rename(held)
            reject('missing_fixture',absent);held.rename(history)
            reject('existing_output',existing)
            for f in m['files']:assert sha(isolated/f['path'])==f['sha256']
        protect()
        receipt=dict(passed=True,acceptedFor='aggregate same-host relocation evidence; successful v1 mission and audit reused explicitly',createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,manifestSha256=sha(out/'manifest.json'),packageManifestSha256=sha(root/'package-manifest.json'),reusedMissionPath=str(rdir/'mission.json.gz'),reusedMissionSha256=sha(rdir/'mission.json.gz'),reusedAuditSha256=sha(rdir/'independent_audit.json'),v1OuterFailurePreserved=True,originalLexicalPath=str(invoked),originalCanonicalPath=str(reported),canonicalIdentityPassed=True,fullSavedJsonEqualityPassed=True,equalityExclusions=['summary.rpcMilliseconds'],negativePackageChecksRejected=3,commands=commands,packageFilesUnchanged=len(m['files']),newMissionCount=0,newScientificAuditExecutions=0,disposableCopyRemoved=True,cleanInstall=False,crossPlatformValidation=False,publicRelease=False,physicalValidation=False)
        write(out/'acceptance.json',receipt);print(json.dumps({k:v for k,v in receipt.items() if k!='commands'}))
    except BaseException as e:
        write(out/'failure.json',dict(passed=False,error=repr(e),at=datetime.now(timezone.utc).isoformat(),commands=commands));raise

if __name__=='__main__':main()
