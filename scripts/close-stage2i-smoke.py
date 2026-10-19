#!/usr/bin/env python3
"""Close a downloaded, independently audited smoke; no paid action is performed."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'aws'))
import launch_stage2i_smoke as launch
from lib.processing_output_manifest import verify_output_manifest


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_text())


def close(evidence,audit,output):
    root=evidence/'output';provenance=evidence/'provenance'
    verified=verify_output_manifest(root,allow_empty_upload_markers=True)
    transfer=read(provenance/'transfer-verification.json')
    assert transfer['job']=='plumenav-stage2i-smoke-20260922-013224'
    assert transfer['transport']==verified
    job=read(provenance/'describe-processing-job.json');name=job['ProcessingJobName']
    assert name=='plumenav-stage2i-smoke-20260922-013224'
    expected=launch.build_spec(name)
    assert read(provenance/'launch.json')['spec']==expected
    for k in ['ProcessingJobName','AppSpecification','ProcessingResources','StoppingCondition','RoleArn','Environment']:
        assert job[k]==expected[k],k
    assert job['ProcessingJobStatus']=='Completed' and not job.get('FailureReason') and not job.get('ExitMessage')
    assert job['ProcessingOutputConfig']['Outputs'][0]['S3Output']==expected['ProcessingOutputConfig']['Outputs'][0]['S3Output']
    assert len(job['ProcessingInputs'])==1
    for key,value in expected['ProcessingInputs'][0]['S3Input'].items():
        assert job['ProcessingInputs'][0]['S3Input'][key]==value,key
    assert read(root/'deployment.json')['bundleSha256']==launch.BUNDLE_SHA
    cloud=read(root/'analysis/analysis.json');local=read(audit/'analysis.json')
    for a in [cloud,local]:
        assert a['accepted'] and a['integrityPassed'] and a['absentControlPassed']
        assert a['mode']=='nominal-preflight' and a['compatibilityCount']==12 and len(a['details'])==12
        assert a['performance'] is None and a['coupledResolutionPassed'] is None
        assert a['bundleSha256']==launch.BUNDLE_SHA and a['manifestSha256']==sha(root/'manifest.json')
        assert all(d['audit']['passed'] and d['audit']['samePlatformReferenceAudited'] and d['audit']['cloudPlatformCompatibility']['passed'] for d in a['details'])
    assert [x['index'] for x in cloud['details']]==[x['index'] for x in local['details']]
    assert cloud['runs']==local['runs'],'Independent compact outcomes differ'
    for c,l in zip(cloud['details'],local['details']):
        assert c['compatibility']==l['compatibility']
        assert c['audit']['cloudPlatformCompatibility']['gates']==l['audit']['cloudPlatformCompatibility']['gates']
    for directory in [audit,root/'analysis']:
        completed=read(directory/'complete.json')
        assert completed['complete'] and completed['accepted'] and completed['analysisSha256']==sha(directory/'analysis.json')
    terminal=read(root/'job-complete.json')
    assert terminal['accepted'] and terminal['analysisSha256']==sha(root/'analysis/analysis.json')
    assert terminal['deliverySha256']==launch.DELIVERY_SHA
    inventory=[r for w in range(4) for r in read(root/f'worker-{w}/complete.json')['inventory']]
    assert sorted(r['index'] for r in inventory)==list(range(12))
    # Compare one-time candidate simulation (not doubled reference work) to the
    # matched, already accepted Stage 2h cloud cases. No algorithm tuning occurs.
    old=Path('research/evidence/si_stage2h_v2_campaign_download_2026-09-21/output')
    ratios=[]
    for r in inventory:
        i=r['compatibility']['referenceIndex'];ref=read(old/f'worker-{i%4}'/f'case-{i:03}.receipt.json')
        ratios.append(r['simulationSeconds']/ref['simulationSeconds'])
    planning=read(Path('research/results/si_stage2i_local_closure_2026-09-21.json'))['throughputPlanning']
    multiplier=max(1.,max(ratios))
    # Maximum observed matched-case costs, updated for any smoke slowdown, plus
    # conservatively scaled full-history audit and five minutes fixed overhead.
    simulation=planning['maximumMatchedWorkerHours']*3600*multiplier
    projected=simulation+cloud['elapsedSeconds']*20+300
    assert projected*1.25+120<=43200,'Forecast lacks 25% headroom within authorized 12-hour cap'
    result=dict(schemaVersion='stage2i-cloud-smoke-closure-v1',accepted=True,downloadedAndIndependentlyAudited=True,
                cloudValidated=True,campaignLaunched=False,smokeJob=name,archiveSha256=launch.ARCHIVE_SHA,
                bundleSha256=launch.BUNDLE_SHA,deliverySha256=launch.DELIVERY_SHA,
                imageUri=launch.base.IMAGE,caseCount=12,rawHistoriesAudited=24,
                independentAuditSha256=sha(audit/'analysis.json'),descriptionSha256=sha(provenance/'describe-processing-job.json'),
                outputManifestSha256=sha(root/'SHA256SUMS'),transport=verified,
                productionMaxRuntimeSeconds=43200,internalGuardSeconds=43080,
                planning=dict(workers=4,observedSimulationRatios=ratios,slowdownMultiplier=multiplier,
                    simulationProjectionSeconds=simulation,auditProjectionSeconds=cloud['elapsedSeconds']*20,
                    fixedAllowanceSeconds=300,totalProjectionSeconds=projected,headroomRequired=1.25,
                    limitation='Measured extrapolation, not a mathematical runtime bound; partial results remain diagnostic-only'),
                checkedAt=datetime.now(timezone.utc).isoformat())
    with output.open('x') as f:json.dump(result,f,indent=2,allow_nan=False);f.write('\n')
    print(json.dumps(result,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);p.add_argument('--audit',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();close(a.evidence,a.audit,a.output)
