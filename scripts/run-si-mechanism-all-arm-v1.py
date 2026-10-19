"""Bounded 23-mission/22-reuse development integration and analysis admission."""
import argparse
from datetime import datetime,timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from lib.si_mechanism_registry_v2 import validate,ARMS,FIELDS

ROOT=Path(__file__).resolve().parents[1]
PRIOR='research/results/si_mechanism_worker_admission_v2_attempt01_2026-09-25'
PRIOR_SHA='8500ceb2cbaf7b77a4a64799e3c080a36a3ad0f40a339ce7c9b1426efb8d96a8'
PROTOCOL='research/protocols/si_mechanism_all_arm_admission_v1_2026-09-25.md'
NEW=(PROTOCOL,'scripts/run-si-mechanism-all-arm-v1.py','scripts/lib/si_mechanism_registry_v2.py','scripts/si-mechanism-bridge-v2.py',
     'scripts/lib/si-mechanism-bridge-v2.ts','scripts/run-si-mechanism-case-v2.ts','scripts/check-si-mechanism-manifest-v2.py',
     'scripts/lib/si_mechanism_history_v1.py','scripts/audit-si-mechanism-all-arm-case-v1.py','scripts/close-si-mechanism-all-arm-v1.py',
     'scripts/test-si-mechanism-all-arm-contract-v1.py','scripts/lib/si_release_endpoint_v1.py','scripts/lib/si_release_endpoint_v2.py',
     'scripts/lib/si_paired_statistics_v2.py','scripts/lib/si_terminal_report_v1.py')
OLD_ROOTS={'si-continuous':'si_readout_four_arm_refinement_v1_attempt01_2026-09-24',
           'si-pulse':'si_readout_source_admission_v1_attempt01_2026-09-24',
           'blank':'si_readout_source_admission_v1_attempt01_2026-09-24','NS':'si_scan_disabled_mission_admission_v1_attempt01_2026-09-24'}

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def load(p):return json.loads(Path(p).read_text())
def write(p,v):
    with Path(p).open('x') as f:json.dump(v,f,indent=2,allow_nan=False);f.write('\n')
def pin(p):
    p=Path(p);return dict(path=str(p.relative_to(ROOT) if p.is_absolute() else p),sha256=sha(p))


def reference(c):
    arm=c['arm'];s=c['spec'];field=s['field'];n=round(1/s['navDt'])
    if n==64 and (arm,field) in (('GL','si-continuous'),('NS','blank')):
        slot=0 if arm=='GL' else 1;root=ROOT/PRIOR;folder=root/f'case-{slot}'
        paths=dict(history=folder/'mission.json.gz',completion=folder/'complete.json',child=folder/'manifest.json',
                   process=root/f'mission-{slot}_terminal.json',audit=root/f'audit-{slot}.json',parent=root/'development_manifest.json',acceptance=root/'acceptance.json')
    else:
        if field=='blank' and n!=64:return None
        root=ROOT/'research/results'/OLD_ROOTS['NS' if arm=='NS' else field]
        if arm=='NS':name=f'{field}-scan-disabled-n{n}'
        else:name=('' if field=='si-continuous' else field+'-')+f'{ARMS[arm][0]}-{ARMS[arm][1]}-n{n}'
        folder=root/name
        paths=dict(history=folder/'run/mission.json.gz',completion=folder/'run/complete.json',child=folder/'run/manifest.json',
                   process=folder/'process_terminal.json',audit=folder/'independent_audit.json',parent=root/'manifest.json',acceptance=root/'acceptance.json')
    return {k:pin(p) for k,p in paths.items()}


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--node',required=True);a=p.parse_args()
    out=a.output.resolve();assert out.is_relative_to(ROOT) and shutil.disk_usage(ROOT).free>=10*1024**3
    assert sha(ROOT/PRIOR/'prospective_manifest.json')==PRIOR_SHA
    prior=load(ROOT/PRIOR/'prospective_manifest.json');assert load(ROOT/PRIOR/'acceptance.json')['accepted'] is True
    sources={r['path']:r['sha256'] for r in prior['sources']}
    for path in NEW:
        digest=sha(ROOT/path)
        if path in sources:assert sources[path]==digest
        sources[path]=digest
    for name,digest in sources.items():assert sha(ROOT/name)==digest,name
    out.mkdir(exist_ok=False);(out/'logs').mkdir();(out/'terminals').mkdir();(out/'cases').mkdir();start=time.monotonic();commands=[]
    for name in NEW:
        dest=out/'source-snapshot'/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,dest)
    write(out/'preparation_sources.json',dict(createdAt=datetime.now(timezone.utc).isoformat(),sources=[dict(path=k,sha256=v) for k,v in sorted(sources.items())]))
    env=dict(os.environ,PYTHON=sys.executable,PYTHONNOUSERSITE='1',PYTHONDONTWRITEBYTECODE='1',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',MKL_NUM_THREADS='1',VECLIB_MAXIMUM_THREADS='1');env.pop('PYTHONPATH',None)
    def child(name,command,cap=180):
        left=2100-(time.monotonic()-start)
        if left<=0:raise TimeoutError('Overall admission guard')
        begin=time.monotonic();timed=False
        with (out/'logs'/(name+'.log')).open('x') as log:
            proc=subprocess.Popen(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try:code=proc.wait(timeout=min(left,cap))
            except subprocess.TimeoutExpired:timed=True;os.killpg(proc.pid,signal.SIGKILL);code=proc.wait()
            except BaseException:os.killpg(proc.pid,signal.SIGKILL);proc.wait();raise
        receipt=dict(command=command,pid=proc.pid,exitCode=code,timedOut=timed,elapsedSeconds=time.monotonic()-begin)
        commands.append(receipt);write(out/'terminals'/(name+'.json'),receipt)
        if code!=0 or timed:raise RuntimeError('Failed child: '+name)
    completed=[]
    try:
        bundle=out/'worker.mjs';meta=out/'worker.meta.json'
        child('build',[a.node,'node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild','scripts/run-si-mechanism-case-v2.ts','--bundle','--platform=node','--format=esm','--outfile='+str(bundle),'--metafile='+str(meta)],60)
        for name in load(meta)['inputs']:
            digest=sha(ROOT/name)
            if name in sources:assert sources[name]==digest
            sources[name]=digest
        sources[str(bundle.relative_to(ROOT))]=sha(bundle);sources[str(meta.relative_to(ROOT))]=sha(meta)
        rows=[dict(path=k,sha256=v) for k,v in sorted(sources.items())]
        dev=load(ROOT/PRIOR/'development_manifest.json');world=dev['worlds'][0];template=dev['cases'][0]['spec'];cases=[]
        for arm in ARMS:
            for field in FIELDS:
                for n in (16,32,64):
                    spec=dict(template,field=field,policy=ARMS[arm][0],navDt=1/n)
                    cases.append(dict(id=f'mechanism-development-3000-{arm}-{field}-n{n}',worldKey=world['key'],arm=arm,spec=spec))
        manifest=dict(dev,version='si-mechanism-cases-v2',purpose='full-development-worker-admission',cases=cases,sources=rows)
        validate(manifest);write(out/'development_manifest.json',manifest)
        fresh=dict(prior,version='si-mechanism-cases-v2',sources=rows);validate(fresh);write(out/'prospective_manifest_v2.json',fresh)
        # Neither case identities nor seed/spec assignments may change in packaging.
        assert fresh['cases']==prior['cases'] and fresh['worlds']==prior['worlds']
        entries={}
        for c in cases:
            ref=reference(c);s=c['spec'];reuse=s['navDt']!=1/64 and s['field']!='blank' or (s['navDt']==1/64 and (c['arm'],s['field']) in (('GL','si-continuous'),('NS','blank')))
            entries[c['id']]=dict(case=c,mode='reuse' if reuse else 'new',reference=ref)
        assert sum(e['mode']=='new' for e in entries.values())==23
        write(out/'binding_ledger.json',dict(version='mechanism-development-binding-v1',cases=entries))
        child('contract',[sys.executable,'-B','scripts/test-si-mechanism-all-arm-contract-v1.py','--root',str(out)])
        for c in cases:
            name=c['id'];entry=entries[name]
            if entry['mode']=='new':
                child(name+'-mission',[a.node,str(bundle),'--manifest',str(out/'development_manifest.json'),'--sha256',sha(out/'development_manifest.json'),'--case',name,'--output',str(out/'cases'/name)])
            child(name+'-binding',[sys.executable,'-B','scripts/audit-si-mechanism-all-arm-case-v1.py','--root',str(out),'--case',name])
            completed.append(name);print(f'BOUND {len(completed)}/45: {name} ({entry["mode"]})',flush=True)
        child('assembly',[sys.executable,'-B','scripts/close-si-mechanism-all-arm-v1.py','--root',str(out)])
        assembly=load(out/'assembly_acceptance.json');assert assembly['passed'] and len(assembly['triplets'])==15
        assert (assembly['newScientificAudits'],assembly['reusedScientificAudits'],assembly['exactHistoricalMatches'])==(23,22,13)
        for row in rows:assert sha(ROOT/row['path'])==row['sha256']
        for entry in entries.values():
            for row in (entry['reference'] or {}).values():assert sha(ROOT/row['path'])==row['sha256']
        nbytes=sum(p.stat().st_size for p in out.rglob('*') if p.is_file());assert nbytes<2*1024**3
        receipt=dict(accepted=True,acceptedFor='all-arm development worker, real endpoint binding and 15 numerical/endpoint triplets only',
                     createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,developmentManifestSha256=sha(out/'development_manifest.json'),
                     prospectiveManifestSha256=sha(out/'prospective_manifest_v2.json'),bindingLedgerSha256=sha(out/'binding_ledger.json'),assemblySha256=sha(out/'assembly_acceptance.json'),
                     contractSha256=sha(out/'contract_acceptance.json'),boundCases=45,newDevelopmentMissions=23,newScientificAudits=23,reusedScientificAudits=22,
                     exactHistoricalMatches=13,passedTriplets=15,freshReportingIdentities=128,newPerformanceWorlds=0,bytes=nbytes,
                     paidLaunchAuthorized=False,freshCampaignExecutionAdmitted=False,physicalValidation=False)
        write(out/'acceptance.json',receipt);print(json.dumps(receipt),flush=True)
    except BaseException as e:
        write(out/'failed.json',dict(accepted=False,error=type(e).__name__+': '+str(e),elapsedSeconds=time.monotonic()-start,completed=completed,commands=commands,diagnosticOnly=True));raise


if __name__=='__main__':main()
