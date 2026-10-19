#!/usr/bin/env python3
"""Close downloaded cloud smoke provenance after an independent Mac audit.

This is outside the immutable cloud bundle. It does not edit or rerun physics.
"""
import argparse,hashlib,json,math
from datetime import datetime,timezone
from pathlib import Path
from lib.processing_output_manifest import verify_output_manifest

ARCHIVE_SHA='beb451efd527fd65f541cfef697120388d9bf2e1c2502c80f68f0b105e13c80e'
BUNDLE_SHA='f23730105b14400057c5b643db989d4a52b3e48521d6e437f6cca4172346250b'
IMAGE='885854791233.dkr.ecr.us-east-1.amazonaws.com/sagemaker-distribution-prod@sha256:2ae2a90be54895e8ef66b4a26a913c57d1ee52f5429055afe652627ddbfa253a'

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def read(path):return json.loads(path.read_text())

def close(root,audit,description,output,allow_empty_upload_markers=False):
    # Root is the downloaded Processing output; the job description is separate.
    transport=verify_output_manifest(root,allow_empty_upload_markers=allow_empty_upload_markers)
    job=read(description);m=read(root/'manifest.json');b=read(root/'deployment.json')
    assert job['ProcessingJobStatus']=='Completed' and job['AppSpecification']['ImageUri']==IMAGE
    assert job['Environment']['STAGE2H_ARCHIVE_SHA256']==ARCHIVE_SHA and job['Environment']['STAGE2H_MODE']=='smoke'
    assert job['ProcessingResources']['ClusterConfig']['InstanceCount']==1
    assert job['ProcessingResources']['ClusterConfig']['InstanceType']=='ml.m5.xlarge'
    assert job['StoppingCondition']['MaxRuntimeInSeconds']==3600
    assert m['bundleSha256']==BUNDLE_SHA and m['caseCount']==12 and m['mode']=='smoke'
    assert m['cases']==b['plan']['smoke']['cases'] and m['configs']==b['plan']['smoke']['configs']
    assert len(b['frozenSources'])==141 and len(b['plan']['campaign']['cases'])==288
    cloud=read(root/'analysis/analysis.json');local=read(audit/'analysis.json')
    for data in [cloud,local]:
        assert data['accepted'] and data['integrityPassed'] and data['platformCompatibilityPassed'] and data['absentControlPassed']
        assert data['performance'] is None and data['manifestSha256']==sha(root/'manifest.json') and data['bundleSha256']==BUNDLE_SHA
        assert len(data['details'])==12
    # Independent audit runtimes can differ in roundoff, so require each to pass
    # the same frozen numerical tolerances, not bit-identical error diagnostics.
    # Check discrete gates and evidence counts exactly across the two audits.
    assert cloud['counts']==local['counts'] and cloud['sourceCount']==local['sourceCount']
    left={d['index']:d for d in cloud['details']};right={d['index']:d for d in local['details']}
    assert left.keys()==right.keys()
    for i in left:
        assert left[i]['audit']['passed'] and right[i]['audit']['passed']
        assert left[i]['replay']==right[i]['replay']
        assert left[i]['platformCompatibility']['gates']==right[i]['platformCompatibility']['gates']
    assert read(audit/'complete.json')['analysisSha256']==sha(audit/'analysis.json')
    assert read(root/'job-complete.json')['analysisSha256']==sha(root/'analysis/analysis.json')
    inventories=[i for w in range(4) for i in read(root/f'worker-{w}/complete.json')['inventory']]
    assert sorted(i['index'] for i in inventories)==sorted(s['index'] for s in m['cases'])
    # Conservative planning: all 288 treated as fine-grid, full 1200 s missions.
    # This intentionally gives no runtime discount for 96 coarser witnesses.
    # Case elapsed includes replay/compression; audit scaling includes smoke's
    # extra reference comparisons. A 50% margin covers remaining variability.
    slowest=max(i['elapsedSeconds']/i['summary']['completedAt'] for i in inventories)
    simulation_projection=72*1200*slowest
    audit_projection=cloud['elapsedSeconds']*24
    projection=simulation_projection+audit_projection+300
    guard=max(3600,math.ceil((projection*1.5+120)/1800)*1800)
    assert guard<=86400,('Cloud forecast exceeds approved 24-hour cap',guard)
    result=dict(accepted=True,downloadedAndIndependentlyAudited=True,smokeJob=job['ProcessingJobName'],archiveSha256=ARCHIVE_SHA,bundleSha256=BUNDLE_SHA,imageUri=IMAGE,independentAuditSha256=sha(audit/'analysis.json'),downloadedOutputManifestSha256=sha(root/'SHA256SUMS'),descriptionSha256=sha(description),checkedFiles=transport['checkedFiles'],transport=transport,caseCount=12,checkedAt=datetime.now(timezone.utc).isoformat(),productionMaxRuntimeSeconds=guard,planning=dict(slowestObservedCaseWallSecondsPerSimulatedSecond=slowest,simulationProjectionSeconds=simulation_projection,auditProjectionSeconds=audit_projection,fixedAllowanceSeconds=300,projectionSeconds=projection,headroom=1.5,allCasesTreatedAsFineGrid=True,allMissionDurationsSeconds=1200,workers=4,limitation='A conservative throughput forecast, not a mathematical runtime bound. Production remains capped and partial results are diagnostic-only.'))
    with output.open('x') as f:json.dump(result,f,indent=2,allow_nan=False);f.write('\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--audit',type=Path,required=True);p.add_argument('--description',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--allow-empty-upload-markers',action='store_true');a=p.parse_args()
    close(a.root.resolve(),a.audit.resolve(),a.description.resolve(),a.output.resolve(),a.allow_empty_upload_markers)
