"""Independent all-history audit driver for an already downloaded campaign.

No AWS client or mission-generation command. Default validates saved input only.
Explicit audit execution requires the pinned Linux x86 runtime and a fresh
output mount. Outputs are candidates until separate terminal launch/download
provenance is independently verified; this script never certifies that provenance.
"""
import argparse
from datetime import datetime,timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import threading
import time

MANIFEST_SHA='625706ed07b9be7415f81d214272348d1f5757cb32833f14cf4272aecddb7e6d'
SOURCE_PINS={
    'aws/mechanism-campaign-v1/check_release.py':'a1af5e282ae23465cd0ca31de85a54ca81525a0b44dcfaa0c6b89889cc80ffbf',
    'aws/mechanism-campaign-v1/context.py':'557ffdfd570654f652bd4251d55b7bf0646095e3b08f6a8cda0c433708a1ee64',
    'aws/mechanism-campaign-v1/audit.py':'6799aeb7f976bc96a911377d247c5a4623e536bc953976e4beaca1b0e4d45008',
    'aws/mechanism-campaign-v1/run.py':'555e4a0dd75ee0070dab644bd7cb35dba356cbac30cdd14c32b84acf89d23502',
    'aws/mechanism-campaign-v1/resource_meter.py':'ddea445ce18dcc3a8900ec61f5b170c436ca5b2cdaeac393d96a9f104c4f5bbf',
    'aws/mechanism-campaign-v1/verification_manifest_v2.py':'e53e00e5f5e3d3d66e3ca3bb76d368c1ca3d5e4bfc5dc553582fa5859bf4d058',
    'scripts/lib/si_mechanism_campaign_assembly_v1.py':'67e6dc3d92a04c22a44d9f9da79916b107030826be3c3ae3e6979921d4f7d4bd',
}
RUNTIME=dict(python='3.12.13',numpy='1.26.4',scipy='1.16.3',node='v20.19.6',architecture='x86_64',cpus=48)


def need(ok,why):
    if not ok:raise ValueError(why)


def sha(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x') as f:json.dump(value,f,indent=2,sort_keys=True,allow_nan=False);f.write('\n')


def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


def payloads(case_ids):
    ids=list(case_ids)
    need(len(ids)==2400 and len(set(ids))==2400,'All 2400 independent audit cases required')
    for cid in ids:need(type(cid) is str and cid and cid.replace('-','').isalnum(),'Unsafe case identity')
    names={'start.json','runtime.json','complete.json','case-index.json','assembly.json','resource-profile.json'}
    for cid in ids:
        names|={'audits/'+cid+suffix for suffix in ('.json','-diagnostics.json','-arrays.npz')}
        names|={directory+'/'+cid+suffix for directory,suffix in (('logs','.log'),('terminals','.json'),('resources','.json'))}
    need(len(names)==14406,'Independent audit fixed membership')
    return names


def audit_command(science,producer,out,cid,release_sha):
    need(type(cid) is str and cid and cid.replace('-','').isalnum(),'Unsafe case identity')
    return [sys.executable,'-B',str(science/'aws/mechanism-campaign-v1/audit.py'),
        '--science',str(science),'--manifest',str(science/'metadata/prospective_manifest_portable_v1.json'),
        '--release',str(science/'metadata/campaign-release.json'),'--release-sha256',release_sha,
        '--worker',str(science/'aws/mechanism-campaign-v1/worker_v4.mjs'),
        '--run',str(producer/'run'),'--case',cid,'--audit-output',str(out/'audits')]


def check_completion(done,release_sha):
    need(done['executionMode']=='campaign' and type(done['reservedWorldsExecuted']) is int
         and done['reservedWorldsExecuted']==128 and done['completed'] is True and type(done['histories']) is int and done['histories']==2400
         and type(done['worlds']) is int and done['worlds']==128
         and done['allProducerFullAuditsPassed'] is True
         and done['refinementTripletsAudited'] is False and done['scientificallyAccepted'] is False
         and done['independentDownloadedAuditRequired'] is True
         and done['manifestSha256']==MANIFEST_SHA and done['releaseSha256']==release_sha,
         'Saved producer numerical completion contract')


def runtime():
    import numpy,scipy
    from threadpoolctl import threadpool_info
    result=dict(python=platform.python_version(),numpy=numpy.__version__,scipy=scipy.__version__,
        node=subprocess.check_output(['node','--version'],text=True).strip(),architecture=platform.machine(),cpus=os.cpu_count())
    need(result==RUNTIME,'Exact saved-history audit runtime required')
    settings={k:os.environ.get(k) for k in ('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS')}
    pools=threadpool_info()
    need(all(v=='1' for v in settings.values()) and all(p['num_threads']==1 for p in pools),'Single-thread numerical audit libraries required')
    return dict(**result,threadSettings=settings,threadpoolInfo=pools)


def main():
    p=argparse.ArgumentParser()
    for name in ('science','producer','output'):p.add_argument('--'+name,type=Path,required=True)
    for name in ('release-sha256','producer-ledger-sha256'):p.add_argument('--'+name,required=True)
    p.add_argument('--execute-approved-audit',action='store_true')
    p.add_argument('--internal-runtime-seconds',type=int)
    a=p.parse_args();science=a.science.resolve();producer=a.producer.resolve()
    need(not a.science.is_symlink() and not a.producer.is_symlink(),'Unsafely linked input root')
    need(sys.flags.optimize==0,'Assertions must remain enabled')
    for name,h in SOURCE_PINS.items():
        path=science/name;need(path.is_file() and not path.is_symlink() and sha(path)==h,'Independent audit source changed: '+name)
    # CLI starts a fresh interpreter: no registry imported with another ROOT.
    sys.path[:0]=[str(science/'aws/mechanism-campaign-v1'),str(science/'scripts')]
    from lib.si_exact_registry_v1 import strict_json
    from context import context
    from verification_manifest_v2 import verify_manifest,write_manifest
    from resource_meter import measure,snapshot,descendants
    from lib.si_mechanism_campaign_assembly_v1 import frozen,bind_saved_case,assemble_rows
    runner=module('saved_campaign_runner',science/'aws/mechanism-campaign-v1/run.py')
    manifest=science/'metadata/prospective_manifest_portable_v1.json';release=science/'metadata/campaign-release.json'
    worker=science/'aws/mechanism-campaign-v1/worker_v4.mjs'
    _,registry,execution,resources=context(science,manifest,release,a.release_sha256,worker)
    def load(path):return strict_json(path.read_bytes())
    ledger=producer/'PAYLOAD_SHA256SUMS_V1'
    need(ledger.is_file() and not ledger.is_symlink() and sha(ledger)==a.producer_ledger_sha256,'Downloaded producer ledger hash')
    names=runner.required_payloads(registry);verify_manifest(producer,names)
    need(load(producer/'payload-index.json')==dict(version='mechanism-campaign-output-v1',payloads=sorted(names)),
         'Exact saved producer index')
    check_completion(load(producer/'complete.json'),a.release_sha256)
    need(load(producer/'release.json')==execution,'Saved producer release differs')
    saved_runtime=load(producer/'runtime.json')
    need({k:saved_runtime[k] for k in RUNTIME}==RUNTIME
         and all(v=='1' for v in saved_runtime['threadSettings'].values())
         and all(t['num_threads']==1 for t in saved_runtime['threadpoolInfo']),'Saved producer runtime differs')
    index=science/'aws/mechanism-campaign-v1/audit-index.json'
    analysis=science/'research/protocols/si_mechanism_campaign_analysis_v1_2026-09-30.json'
    document,routing,config=frozen(science,manifest,index,analysis)
    expected=payloads(registry.cases)
    if not a.execute_approved_audit:
        print(json.dumps(dict(savedInputChecksPassed=True,histories=2400,triplets=240,newMissions=0,
            independentFullAuditsExecuted=0,awsCalls=0,terminalProvenanceVerified=False,scientificallyAccepted=False)),flush=True);return
    need(sys.platform=='linux' and platform.machine()=='x86_64'
         and os.environ.get('MECHANISM_SAVED_CAMPAIGN_AUDIT_APPROVED')=='YES','Explicit Linux x86 saved-audit approval required')
    need(type(a.internal_runtime_seconds) is int and 0<a.internal_runtime_seconds<=resources['internalRuntimeSeconds'],
         'Explicit bounded audit runtime required')
    rt=runtime();out=a.output.absolute()
    need(out.is_dir() and not out.is_symlink() and os.access(out,os.W_OK) and not any(out.iterdir()),'Fresh writable independent output mount')
    need(not out.resolve().is_relative_to(producer) and not producer.is_relative_to(out.resolve())
         and not out.resolve().is_relative_to(science) and not science.is_relative_to(out.resolve()),'Independent output must not overlap saved inputs')
    need(shutil.disk_usage(out).free>=resources['plannedOutputBytes']+resources['minimumFreeDiskBytes'],
         'Independent audit storage planning margin')
    started=time.monotonic();stop=threading.Event();finished=threading.Event()
    state=dict(samples=0,sampledPeakRssBytes=0,minimumObservedFreeMemoryBytes=None,minimumObservedFreeDiskBytes=None,monitorError=None)
    write(out/'start.json',dict(startedAt=datetime.now(timezone.utc).isoformat(),newMissions=0,histories=2400,
        manifestSha256=MANIFEST_SHA,releaseSha256=a.release_sha256,producerLedgerSha256=a.producer_ledger_sha256,
        sourceScriptSha256=sha(Path(__file__)),terminalProvenanceVerified=False,scientificallyAccepted=False))
    write(out/'runtime.json',rt)
    (out/'logs').mkdir()
    def monitor():
        try:
            while not finished.wait(.5):
                rows=snapshot();rss=sum(rows[pid]['rssBytes'] for pid in descendants(os.getpid(),rows))
                memory=dict(line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())
                free=int(memory['MemAvailable'].split()[0])*1024;disk=shutil.disk_usage(out).free
                state['samples']+=1;state['sampledPeakRssBytes']=max(state['sampledPeakRssBytes'],rss)
                for key,value in (('minimumObservedFreeMemoryBytes',free),('minimumObservedFreeDiskBytes',disk)):
                    state[key]=value if state[key] is None else min(state[key],value)
                need(rss<=resources['rssGuardBytes'] and free>=resources['minimumFreeMemoryBytes']
                     and disk>=resources['minimumFreeDiskBytes'] and time.monotonic()-started<a.internal_runtime_seconds,
                     'Independent audit resource/runtime guard')
        except BaseException as error:state['monitorError']=type(error).__name__+': '+str(error);stop.set()
    sampler=threading.Thread(target=monitor,daemon=True);sampler.start()
    env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1');env.pop('PYTHONPATH',None)
    def task(cid):
        need(not stop.is_set(),'Independent audit cancelled before case start')
        command=audit_command(science,producer,out,cid,a.release_sha256)
        cap=min(resources['taskTimeoutSeconds'],a.internal_runtime_seconds-(time.monotonic()-started))
        result=measure(command,science,env,out/'logs'/(cid+'.log'),cap,interval_seconds=1,cancelled=stop.is_set)
        write(out/'resources'/(cid+'.json'),result)
        write(out/'terminals'/(cid+'.json'),dict(command=command,exitCode=result['exitCode'],timedOut=result['timedOut'],cancelled=result['cancelled']))
        need(result['exitCode']==0 and result['timedOut'] is False and result['cancelled'] is False,
             'Independent full-history audit failed: '+cid)
        need(result['samples']>0 and result['sampledTreePeakRssBytes']>0,'Missing independent task sampling')
    task.abort=stop.set
    def interrupt(sig,frame):stop.set();raise RuntimeError('Independent audit interrupted: '+str(sig))
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    try:
        completed=runner.execute_cases(registry,resources['workers'],task)
        need(not stop.is_set() and not state['monitorError'],'Independent resource monitor failed')
        rows={cid:bind_saved_case(producer,out,registry.cases[cid],a.release_sha256) for cid in completed}
        result=assemble_rows(document,routing,config,rows)
        need(not stop.is_set(),'Independent audit cancelled during assembly')
        write(out/'assembly.json',result)
        case_index={cid:rows[cid]['bindings'] for cid in sorted(rows)}
        write(out/'case-index.json',dict(version='mechanism-campaign-independent-case-index-v1',histories=2400,cases=case_index))
        verify_manifest(producer,names);need(sha(ledger)==a.producer_ledger_sha256,'Producer ledger changed during audit')
        registry.protect();context(science,manifest,release,a.release_sha256,worker)
        for name,h in SOURCE_PINS.items():need(sha(science/name)==h,'Audit source changed during execution')
        finished.set();sampler.join(timeout=2)
        need(not state['monitorError'] and state['samples']>0,'Independent aggregate sampling failed')
        write(out/'resource-profile.json',dict(**state,workers=resources['workers'],histories=2400,
            elapsedSeconds=time.monotonic()-started,sampleIntervalSeconds=.5,absolutePeakBound=False))
        write(out/'complete.json',dict(completed=True,independentFullAuditsExecuted=2400,refinementTripletsAudited=240,
            componentPassed=result['componentPassed'],failedTriplets=result['failedTriplets'],newMissions=0,
            terminalProvenanceVerified=False,scientificallyAccepted=False,awsCalls=0,
            manifestSha256=MANIFEST_SHA,releaseSha256=a.release_sha256,producerLedgerSha256=a.producer_ledger_sha256))
        write_manifest(out,sorted(expected));verify_manifest(out,expected,allow_local_markers=True)
        print('CAMPAIGN_INDEPENDENT_AUDITS_COMPLETE_TERMINAL_PROVENANCE_STILL_REQUIRED',flush=True)
    except BaseException as error:
        stop.set();finished.set();sampler.join(timeout=2)
        write(out/'failed.json',dict(completed=False,error=type(error).__name__+': '+str(error),
            monitorError=state['monitorError'],newMissions=0,diagnosticOnly=True,scientificallyAccepted=False))
        raise


if __name__=='__main__':main()

