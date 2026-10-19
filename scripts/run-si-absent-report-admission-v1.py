"""Bounded local branch admission and four saved-history full-audit regressions."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from lib.si_saved_development_binding_v1 import PARENT, PARENT_SHA, CASES, checked_path

ROOT=Path(__file__).resolve().parents[1]
PROTOCOL='research/protocols/si_absent_report_full_audit_v1_2026-09-24.md'
PROTOCOL_SHA='f375e1548282cdf41b6ad2981ad09d7af17b33384825aec749c36e6879cafb87'
TIMING='research/results/si_readout_emitting_timing_v1_attempt01_2026-09-24'
NEW_SOURCES=(PROTOCOL,'scripts/run-si-absent-report-admission-v1.py','scripts/audit-si-absent-report-regression-v1.py',
             'scripts/test-si-absent-report-branch-v1.py','scripts/lib/si_absent_report_full_audit_v1.py',
             'scripts/lib/si_saved_development_binding_v1.py','scripts/lib/si_exact_registry_v1.py',
             'scripts/lib/si_terminal_report_v1.py','scripts/lib/si_release_endpoint_v1.py','scripts/lib/si_release_endpoint_v2.py')


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()


def pin(name):return dict(path=name,sha256=sha(checked_path(ROOT,name)))


def write(path,data):
    with path.open('x') as f:json.dump(data,f,indent=2);f.write('\n')


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args();now=datetime.now(timezone.utc)
    if (datetime.fromisoformat('2026-09-25T01:41:27+00:00')-now).total_seconds()<900:raise ValueError('Not enough authorised time')
    assert sha(ROOT/PROTOCOL)==PROTOCOL_SHA and sha(ROOT/PARENT/'manifest.json')==PARENT_SHA
    out=a.output.resolve();assert out.is_relative_to(ROOT);out.mkdir(exist_ok=False)
    parents={name:pin(PARENT+'/'+filename) for name,filename in (('parent','manifest.json'),('acceptance','acceptance.json'),('batchComplete','complete.json'))}
    sources=json.loads((ROOT/PARENT/'manifest.json').read_text())['sources']+[pin(name) for name in NEW_SOURCES]
    cases={'timing-gated-live':dict(kind='timing',files={name:pin(TIMING+'/'+filename) for name,filename in (
        ('manifest','run/manifest.json'),('completion','run/complete.json'),('process','process_terminal.json'),
        ('audit','independent_audit.json'),('history','run/mission.json.gz'))})}
    for case in CASES:
        cases[case]=dict(kind='scan-disabled',files={name:pin(PARENT+'/'+case+'/'+filename) for name,filename in (
            ('childManifest','run/manifest.json'),('completion','run/complete.json'),('process','process_terminal.json'),
            ('auditProcess','audit_terminal.json'),('audit','independent_audit.json'),('history','run/mission.json.gz'))})
    inputs=list(parents.values())+[row for case in cases.values() for row in case['files'].values()]
    for row in sources+inputs:assert sha(ROOT/row['path'])==row['sha256']
    manifest=dict(version='absent-report-full-audit-admission-v1',createdAt=now.isoformat(),protocolSha256=PROTOCOL_SHA,
                  sources=sources,inputs=inputs,parentFiles=parents,cases=cases,newMissions=0,plannedScientificAudits=4,
                  python=sys.version,numpyVersion=__import__('numpy').__version__,overallCapSeconds=600,individualAuditCapSeconds=300)
    write(out/'execution_manifest.json',manifest);start=time.monotonic();terminals=[];completed=[]
    def child(name,script,arguments,cap):
        remaining=600-(time.monotonic()-start)
        if remaining<=0:raise TimeoutError('Overall cap exhausted')
        command=[sys.executable,script,*arguments];t=time.monotonic();timed=False
        env=dict(os.environ,OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1')
        with (out/(name+'.log')).open('x') as log:
            process=subprocess.Popen(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
            try:code=process.wait(timeout=min(cap,remaining))
            except subprocess.TimeoutExpired:process.kill();process.wait();code=process.returncode;timed=True
        terminal=dict(command=command,pid=process.pid,exitCode=code,timedOut=timed,elapsedSeconds=time.monotonic()-t,capSeconds=min(cap,remaining))
        terminals.append(terminal);write(out/(name+'_terminal.json'),terminal)
        if code!=0 or timed:raise RuntimeError('Failed child: '+name)
    try:
        child('branch','scripts/test-si-absent-report-branch-v1.py',['--output',str(out/'branch')],60)
        branch=json.loads((out/'branch/branch_acceptance.json').read_text());assert branch['passed'] is True
        for case in cases:
            child(case,'scripts/audit-si-absent-report-regression-v1.py',['--manifest',str(out/'execution_manifest.json'),'--case',case,'--output',str(out/(case+'.json'))],300)
            receipt=json.loads((out/(case+'.json')).read_text());assert receipt['passed'] is True and receipt['exactReferenceDetailsMatched'] is True
            completed.append(case)
            print('AUDIT REGRESSION PASSED '+case,flush=True)
        for row in sources+inputs:assert sha(ROOT/row['path'])==row['sha256'],row['path']
        assert sum(p.stat().st_size for p in out.rglob('*') if p.is_file())<10*1024**2
        receipt=dict(accepted=True,acceptedFor='minimal source-absent report branch and four existing development full-audit regressions',
                     createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,
                     executionManifestSha256=sha(out/'execution_manifest.json'),branchReceiptSha256=sha(out/'branch/branch_acceptance.json'),
                     derivedAuditorSha256=sha(out/'branch/derived_full_auditor.py'),
                     caseAudits=[dict(caseId=case,path=case+'.json',sha256=sha(out/(case+'.json'))) for case in cases],
                     newScientificAuditsExecuted=4,newMissions=0,allInputsUnchanged=True,
                     supportedBlankBranchTestedWithArtificialArguments=True,physicallyValidSupportedBlankHistoryTested=False,
                     freshPerformanceCampaignAdmitted=False,physicalValidation=False)
        write(out/'acceptance.json',receipt)
        print(json.dumps(dict(accepted=True,elapsedSeconds=receipt['elapsedSeconds'],newScientificAuditsExecuted=4,newMissions=0,
              acceptanceSha256=sha(out/'acceptance.json'),executionManifestSha256=sha(out/'execution_manifest.json'))),flush=True)
    except BaseException as error:
        write(out/'failed.json',dict(accepted=False,error=type(error).__name__+': '+str(error),completedRegressions=completed,
              elapsedSeconds=time.monotonic()-start,newMissions=0,diagnosticOnly=True))
        raise


if __name__=='__main__':main()
