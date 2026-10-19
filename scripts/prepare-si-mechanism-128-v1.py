"""Prospective identity preparation and bounded local integration admission only."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from lib.si_mechanism_registry_v1 import ARMS, FIELDS, ROLES, validate

ROOT = Path(__file__).resolve().parents[1]
PROTOCOL = 'research/protocols/si_readout_mechanism_128_v1_2026-09-25.md'
PARENT = 'research/results/si_absent_report_full_audit_v1_attempt01_2026-09-24/execution_manifest.json'
PARENT_SHA = '24a9dd7ddd66f70906cf36803a141152121b46071c4a3d40b056493bb4dbcdf5'
NEW = (PROTOCOL, 'scripts/prepare-si-mechanism-128-v1.py', 'scripts/lib/si_mechanism_registry_v1.py',
       'scripts/si-mechanism-bridge-v1.py', 'scripts/lib/si-mechanism-bridge-v1.ts',
       'scripts/run-si-mechanism-case-v1.ts', 'scripts/check-si-mechanism-manifest-v1.py',
       'scripts/test-si-mechanism-contract-v1.py', 'scripts/audit-si-mechanism-worker-v1.py',
       'research/analysis/si_availability_planning_v1_2026-09-24/prospective_design.md')


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def load(path): return json.loads(Path(path).read_text())
def write(path, value):
    with Path(path).open('x') as f:
        json.dump(value, f, indent=2, allow_nan=False); f.write('\n')


def inventory(out):
    paths = subprocess.run(['rg', '--files', 'research/results'], cwd=ROOT, check=True, text=True, capture_output=True).stdout.splitlines()
    paths = sorted(p for p in paths if Path(p).name in ('manifest.json', 'execution_manifest.json', 'plan.json', 'design.json') and not (ROOT/p).is_relative_to(out))
    values, records = set(), []
    keys = set(ROLES) | {'seed', 'noiseSeed', 'perturbationSeed', 'reportingReplicate', 'replicate'}
    def walk(v, found):
        if type(v) is dict:
            for k, x in v.items():
                if k in keys and type(x) is int and x >= 0:
                    found.add(x)
                    if k == 'worldSeed': found.add((x+3000000) & 0xffffffff)
                    if k == 'replicate': found.add(x+600000)
                elif type(x) in (dict, list): walk(x, found)
        elif type(v) is list:
            for x in v:
                if type(x) in (dict, list): walk(x, found)
    for path in paths:
        file = ROOT/path
        if file.stat().st_size > 32*1024**2:
            raise ValueError('Historical metadata unexpectedly large: '+path)
        found=set(); walk(load(file), found); values.update(found)
        records.append(dict(path=path, sha256=sha(file), extractedIdentityCount=len(found)))
    if not {281301, 281501, 281701, 281901, 181301, 181501, 181701, 181901} <= values:
        raise ValueError('Missing required previous development/Stage 2i identities')
    return dict(version='mechanism-declared-metadata-inventory-v1', scope='Existing research/results manifest, execution_manifest, plan and design JSON; no compressed histories', files=records, identities=sorted(values), outcomeBasedSelection=False)


def world(index, used):
    row=dict(key=f'mechanism-fresh-{index:03d}', index=index, replicate=510000+index, reportingReplicate=1110000+index)
    for identity in (row['replicate'], row['reportingReplicate']):
        if identity in used: raise ValueError('Replicate identity collision')
        used.add(identity)
    for role in ROLES:
        for counter in range(10000):
            label=f'plumenav-mechanism-128-v1-20260925:{index}:{role}:{counter}'
            value=int.from_bytes(hashlib.sha256(label.encode()).digest()[:4], 'big')
            reserved={value, value+3000000} if role == 'worldSeed' else {value}
            if all(0 < x < 2**32 for x in reserved) and not (reserved & used):
                used.update(reserved); row[role]=value; break
        else: raise ValueError('Seed allocation exhausted')
    return row


def case(w, arm, field, dt, index, development=False):
    return dict(id=f"{w['key']}-{arm}-{field}-n{round(1/dt)}", worldKey=w['key'], arm=arm,
                spec=dict(index=index, panel='linear-fresh', studyId='scheduling-response-replication-v1',
                          caseRole='diagnostic' if development else ('primary' if dt == 1/64 else 'resolution-witness'),
                          responseScale=1, worldIndex=w['index'], replicate=w['replicate'], field=field,
                          method='quad-sniff-refine', policy=ARMS[arm][0], navDt=dt, **{r:w[r] for r in ROLES}))


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--node',required=True);a=p.parse_args()
    out=a.output.resolve()
    if not out.is_relative_to(ROOT) or shutil.disk_usage(ROOT).free < 10*1024**3: raise ValueError('Output/disk preflight')
    if sha(ROOT/PARENT)!=PARENT_SHA: raise ValueError('Prior manifest pin mismatch')
    out.mkdir(exist_ok=False); start=time.monotonic(); commands=[]
    env=dict(os.environ,PYTHON=sys.executable,PYTHONNOUSERSITE='1',PYTHONDONTWRITEBYTECODE='1',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',MKL_NUM_THREADS='1',VECLIB_MAXIMUM_THREADS='1');env.pop('PYTHONPATH',None)
    sources={r['path']:r['sha256'] for r in load(ROOT/PARENT)['sources']}
    for path in (*NEW, PARENT): sources[path]=sha(ROOT/path)
    for path, expected in sources.items():
        if sha(ROOT/path)!=expected: raise ValueError('Changed inherited source: '+path)
    # Freeze source bytes as well as their pins before executing the build or fixtures.
    frozen=out/'source-snapshot';frozen.mkdir()
    for path in NEW:
        target=frozen/path;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/path,target)
    write(out/'preparation_sources.json',dict(createdAt=datetime.now(timezone.utc).isoformat(),sources=[dict(path=k,sha256=v) for k,v in sorted(sources.items())]))
    def child(name, command, cap=180):
        remaining=900-(time.monotonic()-start)
        if remaining<=0: raise TimeoutError('Admission time cap')
        begin=time.monotonic();timed=False
        with (out/(name+'.log')).open('x') as log:
            proc=subprocess.Popen(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try: code=proc.wait(timeout=min(cap,remaining))
            except subprocess.TimeoutExpired:
                timed=True;os.killpg(proc.pid,signal.SIGKILL);code=proc.wait()
            except BaseException:
                os.killpg(proc.pid,signal.SIGKILL);proc.wait();raise
        receipt=dict(command=command,pid=proc.pid,exitCode=code,timedOut=timed,elapsedSeconds=time.monotonic()-begin)
        write(out/(name+'_terminal.json'),receipt);commands.append(receipt)
        if code!=0 or timed: raise RuntimeError('Child failed: '+name)
    try:
        inv=inventory(out);write(out/'historical_identity_inventory.json',inv)
        used=set(inv['identities']); worlds=[world(i,used) for i in range(128)];cases=[]
        for w in worlds:
            for arm in ARMS:
                for field in FIELDS:
                    for dt in ((1/64,1/16,1/32) if w['index']%8==0 else (1/64,)):
                        cases.append(case(w,arm,field,dt,len(cases)))
        bundle=out/'worker.mjs';meta=out/'worker.meta.json'
        child('build',[a.node,'node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild','scripts/run-si-mechanism-case-v1.ts','--bundle','--platform=node','--format=esm','--outfile='+str(bundle),'--metafile='+str(meta)],60)
        for path in load(meta)['inputs']:
            pin=sha(ROOT/path)
            if path in sources and pin!=sources[path]: raise ValueError('Build input changed')
            sources[path]=pin
        for path in (bundle,meta): sources[str(path.relative_to(ROOT))]=sha(path)
        rows=[dict(path=k,sha256=v) for k,v in sorted(sources.items())]
        common=dict(version='si-mechanism-cases-v1',sources=rows,protocolSha256=sha(ROOT/PROTOCOL))
        fresh=dict(common,purpose='prospective-128-not-authorised-to-run',worlds=worlds,cases=cases)
        validate(fresh);write(out/'prospective_manifest.json',fresh)
        devworld=dict(key='mechanism-development-3000',index=0,replicate=3000,reportingReplicate=603000,worldSeed=281301,sourceSeed=281501,startSeed=281701,controllerSeed=281901)
        development=dict(common,purpose='development-worker-admission',worlds=[devworld],cases=[case(devworld,'GL','si-continuous',1/64,0,True),case(devworld,'NS','blank',1/64,0,True)])
        validate(development);write(out/'development_manifest.json',development)
        child('contract',[sys.executable,'-B','scripts/test-si-mechanism-contract-v1.py','--root',str(out)],60)
        freshpath=out/'prospective_manifest.json';devpath=out/'development_manifest.json'
        child('prospective-dry',[a.node,str(bundle),'--manifest',str(freshpath),'--sha256',sha(freshpath),'--dry-run'],60)
        for i,c in enumerate(development['cases']):
            child(f'mission-{i}',[a.node,str(bundle),'--manifest',str(devpath),'--sha256',sha(devpath),'--case',c['id'],'--output',str(out/f'case-{i}')])
            child(f'audit-{i}',[sys.executable,'-B','scripts/audit-si-mechanism-worker-v1.py','--root',str(out),'--slot',str(i)])
        for row in rows+inv['files']:
            if sha(ROOT/row['path'])!=row['sha256']: raise ValueError('Changed protected input')
        audits=[load(out/f'audit-{i}.json') for i in range(2)]
        if not all(r['passed'] and r['wholeReferenceMatched'] for r in audits): raise ValueError('Missing independent agreement')
        nbytes=sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
        if nbytes>1024**3: raise ValueError('Output exceeds cap')
        result=dict(accepted=True,acceptedFor='128-world metadata and case-bound worker on two fixed development regressions only',createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,
                    prospectiveWorlds=128,prospectiveHistories=2400,primaryHistories=1920,refinementHistories=480,witnessWorlds=16,resolutionTriplets=240,
                    historicalMetadataFiles=len(inv['files']),historicalIdentities=len(inv['identities']),newDevelopmentMissions=2,newFreshMissions=0,newScientificAudits=2,
                    prospectiveManifestSha256=sha(freshpath),developmentManifestSha256=sha(devpath),protocolSha256=sha(ROOT/PROTOCOL),
                    contractReceiptSha256=sha(out/'contract_acceptance.json'),auditReceiptSha256=[sha(out/f'audit-{i}.json') for i in range(2)],bytes=nbytes,
                    freshCampaignExecutionAdmitted=False,cloudPreflightLaunched=False,physicalValidation=False)
        write(out/'acceptance.json',result);print(json.dumps(result),flush=True)
    except BaseException as e:
        write(out/'failed.json',dict(accepted=False,error=type(e).__name__+': '+str(e),elapsedSeconds=time.monotonic()-start,commands=commands,diagnosticOnly=True));raise


if __name__=='__main__':main()
