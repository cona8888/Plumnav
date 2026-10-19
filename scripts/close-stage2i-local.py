#!/usr/bin/env python3
"""Record local acceptance, rejected-panel disposition and measured AWS workload."""
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess
from datetime import datetime, timezone


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def read(path):return json.loads(path.read_text())
def write(path,value):
    with path.open('x') as f:json.dump(value,f,indent=2,allow_nan=False);f.write('\n')


def main():
    old=Path('aws/build/stage2i-20260921-v1');bundle=Path('aws/build/stage2i-20260921-v2')
    audit=Path('research/results/si_stage2i_nominal_preflight_2026-09-21')
    run=Path('research/evidence/si_stage2i_nominal_preflight_2026-09-21')
    failed=Path('research/evidence/si_stage2i_preflight_2026-09-21')
    result=read(audit/'analysis.json');done=read(audit/'complete.json')
    assert done['accepted'] and done['analysisSha256']==sha(audit/'analysis.json')
    assert result['accepted'] and result['compatibilityCount']==12 and len(result['details'])==12
    assert result['bundleSha256']==sha(bundle/'bundle.json') and result['performance'] is None
    assert result['coupledResolutionPassed'] is None and result['absentBitIdentical'] is None
    assert all(d['audit']['samePlatformReferenceAudited'] and d['audit']['cloudPlatformCompatibility']['passed'] for d in result['details'])
    previous=read(old/'bundle.json');current=read(bundle/'bundle.json')
    assert current['plan']['nominal-only']==previous['plan']['nominal-only']
    fail=read(failed/'complete.json');assert not fail['complete'] and len(fail['failures'])==4
    logs=[]
    for w in range(4):
        log=failed/f'worker-{w}.log'
        assert 'RangeError: Inconsistent inspection geometry/timing' in log.read_text()
        logs.append(dict(worker=w,sha256=sha(log)))
    c=previous['plan']['preflight']['configs'][0]['localInletSampling']
    delay=math.pi*(c['tubeInnerDiameterMetres']/2)**2*c['tubeLengthMetres']/(c['flowLitresPerMinutePerChannel']/1000/60)
    nominal=delay-math.log(.05)*max(c['riseTimeConstantSeconds'],c['recoveryTimeConstantSeconds'])+c['averagingSeconds']
    slow=delay-math.log(.05)*2*max(c['riseTimeConstantSeconds'],c['recoveryTimeConstantSeconds'])+c['averagingSeconds']
    minimum_dwell=slow+c['inspection']['minimumSamplesPerWaypoint']*c['inspection']['sampleSpacingSeconds']
    source=Path('research/evidence/si_stage2h_v2_campaign_download_2026-09-21/output')
    original=read(source/'manifest.json');groups={}
    key=lambda s:(s['field'],s['method'],s['policy'],s['navDt'])
    for s in original['cases']:
        i=s['index'];r=read(source/f'worker-{i%4}'/f'case-{i:03}.receipt.json')
        groups.setdefault(key(s),[]).append(r['elapsedSeconds'])
    estimates=[]
    for w in range(4):
        cases=[s for s in current['plan']['nominal-only']['cases'] if s['index']%4==w]
        estimates.append(dict(worker=w,cases=len(cases),meanMatchedSeconds=sum(statistics.mean(groups[key(s)]) for s in cases),
                              maximumMatchedSeconds=sum(max(groups[key(s)]) for s in cases)))
    node='/Users/w.cha@bham.ac.uk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
    types='/Users/w.cha@bham.ac.uk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@types'
    args=[node,'node_modules/typescript/bin/tsc','--noEmit','--skipLibCheck','--module','esnext','--target','es2022','--moduleResolution','bundler','--strict','--typeRoots',types,'--types','node']
    checks={}
    for name,files in [('baseline',['aws/stage2h_v2/worker.ts']),('candidate',['scripts/stage2i-runner.ts','scripts/test-stage2i-design.ts'])]:
        p=subprocess.run(args+files,capture_output=True,text=True)
        checks[name]=dict(exitCode=p.returncode,diagnostics=(p.stdout+p.stderr).strip().splitlines())
    assert checks['baseline']==checks['candidate'],'New strict diagnostics'
    app=subprocess.run([node,'node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.app.json'],capture_output=True,text=True)
    assert app.returncode==0,app.stdout+app.stderr
    record=dict(schemaVersion='stage2i-local-closure-v1',recordedAt=datetime.now(timezone.utc).isoformat(),accepted=True,
                acceptanceScope='Nominal same-host reproduction and unchanged cloud-reference numerical compatibility; NOT fresh-world performance or new convergence',
                bundleSha256=sha(bundle/'bundle.json'),auditSha256=sha(audit/'analysis.json'),
                candidateHistories=12,independentlyAuditedSameHostReferences=12,originalCloudReferences=12,
                preflightRunSeconds=read(run/'complete.json')['elapsedSeconds'],auditSeconds=result['elapsedSeconds'],
                frozenOriginalSources=141,prospectiveFallbackExactlyPreserved=True,
                rejectedPanel=dict(bundleSha256=sha(old/'bundle.json'),completeSha256=sha(failed/'complete.json'),logs=logs,
                    accepted=False,diagnosticOnly=True,reason='Existing settled-measurement configuration validator rejects doubled response with fixed timing',
                    nominalSettlingSeconds=nominal,slowerMinimumSettlingSeconds=slow,slowerMinimumDwellSeconds=minimum_dwell,
                    frozenDwellSeconds=c['inspection']['dwellSeconds']),
                finalDesign=dict(cases=480,primaryMissions=384,independentPairedWorlds=32,resolutionTriplets=48),
                throughputPlanning=dict(source='Accepted Stage 2h AWS receipts; field/arm/resolution-matched; excludes audit and provisioning',workers=estimates,
                    meanWorkerHours=max(x['meanMatchedSeconds'] for x in estimates)/3600,
                    maximumMatchedWorkerHours=max(x['maximumMatchedSeconds'] for x in estimates)/3600),
                typeChecks=dict(noNewStrictDiagnostics=True,wholeResearchGraphStrictClean=False,appPassed=True,**checks),
                cloudValidated=False,paidLaunchAuthorized=False,freshWorldOutcomesGenerated=False)
    out=Path('research/results/si_stage2i_local_closure_2026-09-21.json');write(out,record)
    print(json.dumps({k:v for k,v in record.items() if k!='typeChecks'},indent=2))


if __name__=='__main__':main()
