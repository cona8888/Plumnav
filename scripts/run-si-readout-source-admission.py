"""Single-worker, no-retry launcher for the frozen pulsed/absent development gate."""
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
from lib.si_readout_terminal_audit import self_test


DEADLINE=datetime.fromisoformat('2026-09-25T01:41:27+00:00')
PROTOCOL=Path('research/protocols/si_readout_source_admission_v1_2026-09-24.md')
TIMING=Path('research/results/si_readout_emitting_timing_v1_attempt01_2026-09-24')
PARENT=Path('aws/build/stage2i-20260921-v2')
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p): return json.loads(p.read_text())
def write(p,v):
    with p.open('x') as f: json.dump(v,f,indent=2); f.write('\n')


def main():
    p=argparse.ArgumentParser(); p.add_argument('--node',required=True); p.add_argument('--output',type=Path,required=True); a=p.parse_args()
    assert (DEADLINE-datetime.now(timezone.utc)).total_seconds()>=2400,'Less than 40 minutes remaining'
    assert shutil.disk_usage('.').free>=2*1024**3,'Insufficient disk'
    assert sha(PROTOCOL)=='e0b0dbf6f3aae44800bc1b932cb18e810bf108941afd75102ed9d0d4420ec021'
    assert sha(PARENT/'bundle.json')=='25eb9e00a783e4d6e8b96f20ec241520407ca86ce15004ef8259425f7e68626a'
    parent=load(PARENT/'bundle.json'); protected=parent['frozenSources']+parent['inheritedAdditions']+parent['additions']; assert len(protected)==179
    sources={str(PROTOCOL),str(PARENT/'bundle.json'),'scripts/run-si-readout-source-admission.py','scripts/audit-si-readout-source-admission.py','scripts/run-si-readout-source-admission-case.ts','scripts/audit-si-readout-full-history.py','scripts/si-readout-exact-bridge.py','scripts/audit-stage1n-candidate.py'}
    for r in protected:
        assert sha(PARENT/r['file'])==r['sha256']; sources.add(str(PARENT/r['file']))
        if r['file'].endswith('.ts'): assert sha(Path(r['file']))==r['sha256']; sources.add(r['file'])
    prior=load(TIMING/'independent_audit.json')
    assert prior['historySha256']==sha(TIMING/'run/mission.json.gz')
    assert prior['completeSha256']==sha(TIMING/'run/complete.json')
    for r in prior['sources']: assert sha(Path(r['path']))==r['sha256']; sources.add(r['path'])
    for r in load(TIMING/'run/manifest.json')['sources']: assert sha(Path(r['path']))==r['sha256']; sources.add(r['path'])
    for r in load(Path('research/results/si_readout_positive_admission_v1_attempt01_2026-09-24/run/manifest.json'))['sources']:
        assert sha(Path(r['path']))==r['sha256']; sources.add(r['path'])
    continuous=Path('research/results/si_readout_four_arm_refinement_v1_attempt01_2026-09-24')
    accepted=load(continuous/'acceptance.json')
    assert accepted['accepted'] and accepted['manifestSha256']==sha(continuous/'manifest.json')=='d5857f3ee86af1dd079e5d12c2cae36b12a5134fed8e3aa41b9ea7535785df5d'
    previous=load(continuous/'manifest.json')['sources']; assert len(previous)==308
    for r in previous: assert sha(Path(r['path']))==r['sha256']; sources.add(r['path'])
    sources.update((str(continuous/'manifest.json'),str(continuous/'acceptance.json')))
    adapter_fixtures=self_test()
    bundle=Path('outputs/si-readout-source-admission-v1.mjs'); meta=bundle.with_suffix('.meta.json')
    sources.update((str(bundle),str(meta))); sources.update(load(meta)['inputs']); sources.update(str(x) for x in Path('scripts/lib').glob('*.py'))
    base=load(TIMING/'run/manifest.json')['spec']; cases=[]
    for field in ('blank','si-pulse'):
        for policy in ('reference','encounter-gated'):
            cases.append(dict(id=f'{field}-{policy}-parent-n64',kind='parent',spec=dict(base,field=field,policy=policy,navDt=1/64)))
    for field in ('blank','si-pulse'):
        for policy in ('reference','encounter-gated'):
            for availability in ('original-withheld','live-passive'):
                for n in ((64,) if field=='blank' else (64,32,16)):
                    cases.append(dict(id=f'{field}-{policy}-{availability}-n{n}',kind='candidate',spec=dict(base,field=field,policy=policy,navDt=1/n),availability=availability))
    assert len(cases)==20 and sum(x['kind']=='parent' for x in cases)==4
    a.output.mkdir(parents=True,exist_ok=False)
    started=time.monotonic(); started_at=datetime.now(timezone.utc).isoformat(); commands=[]
    source_rows=[dict(path=x,sha256=sha(Path(x))) for x in sorted(sources)]
    write(a.output/'manifest.json',dict(version='readout-source-admission-v1',startedAt=started_at,overallCapSeconds=2100,individualMissionCapSeconds=180,individualAuditCapSeconds=240,deadline=DEADLINE.isoformat(),cases=cases,sources=source_rows,node=a.node,python=sys.executable,singleWorker=True,performanceCampaign=False,terminalAuditAdapterFixtures=adapter_fixtures))
    env={**os.environ,'PYTHON':sys.executable,'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1'}
    def run(command,folder,stem,cap):
        remaining=min(2100-(time.monotonic()-started),(DEADLINE-datetime.now(timezone.utc)).total_seconds())
        assert remaining>=cap+5,'Insufficient overall/deadline headroom for next bounded process'
        for r in source_rows: assert sha(Path(r['path']))==r['sha256'],r['path']
        t=time.monotonic(); now=datetime.now(timezone.utc).isoformat(); timeout=False
        with (folder/(stem+'.log')).open('x') as log:
            child=subprocess.Popen(command,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            print(f'START {stem}: PID {child.pid}',flush=True)
            try: code=child.wait(timeout=cap)
            except subprocess.TimeoutExpired:
                timeout=True; os.killpg(child.pid,signal.SIGTERM)
                try: code=child.wait(timeout=5)
                except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL); code=child.wait()
        receipt=dict(command=command,pid=child.pid,startedAt=now,finishedAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-t,exitCode=code,timedOut=timeout,capSeconds=cap)
        write(folder/(('process_terminal' if stem=='worker' else stem+'_terminal')+'.json'),receipt); commands.append(receipt)
        print(f'END {stem}: exit {code}; {receipt["elapsedSeconds"]:.2f} s',flush=True)
        assert code==0 and not timeout,f'{stem} failed; see retained log'
    try:
        for item in cases:
            if item.get('reused'): continue
            folder=a.output/item['id']; folder.mkdir()
            run([a.node,str(bundle),'--root',str(a.output),'--case',item['id']],folder,'worker',180)
            assert (folder/'run/complete.json').is_file()
            if item['kind']=='candidate':
                run([sys.executable,'scripts/audit-si-readout-source-admission.py','--root',str(a.output),'--case',item['id']],folder,'audit',240)
                if item['spec']['navDt']==1/16:
                    arm=item['spec']['field']+'-'+item['spec']['policy']+'-'+item['availability']
                    run([sys.executable,'scripts/audit-si-readout-source-admission.py','--root',str(a.output),'--triplet',arm],a.output,arm+'-comparison',120)
        run([sys.executable,'scripts/audit-si-readout-source-admission.py','--root',str(a.output),'--closeout'],a.output,'closeout',120)
        write(a.output/'complete.json',dict(completed=True,accepted=load(a.output/'acceptance.json')['accepted'],elapsedSeconds=time.monotonic()-started,finishedAt=datetime.now(timezone.utc).isoformat(),commands=commands,newMissions=20,reusedMissions=0,performanceCampaign=False))
        print('COMPLETE: admitted four-arm pulsed/absent development',flush=True)
    except BaseException as error:
        write(a.output/'failed.json',dict(completed=False,error=str(error),failedAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-started,commands=commands,diagnosticOnly=True,noAutomaticRetry=True))
        raise


if __name__=='__main__': main()
